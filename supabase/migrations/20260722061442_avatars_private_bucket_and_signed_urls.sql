-- ============================================================================================
-- avatars: PUBLIC bucket -> PRIVATE bucket + signed URLs
-- Proven 30/30 rolled-back (supabase/tests/avatars_private_bucket_and_signed_urls_rolled_back_proof.sql),
-- run on top of the preceding 20260722061032_avatars_quota_rate_limit_and_orphan_sweep.
-- Re-verified 11/11 live post-apply against the real production rows (co-member render, outsider
-- denial, the uid pin, the sweep sparing the live object, and the fail-safe raising 55000).
--
-- ⚠⚠ APPLY ORDER IS LOAD-BEARING. This migration MUST land AFTER
--    20260722061032_avatars_quota_rate_limit_and_orphan_sweep.sql, which creates the sweep + cron job
--    this file re-points. Applying this first would leave the sweep to be created later with its OLD
--    matching rule against the NEW column shape, and with no fail-safe.
--
-- ⚠ STATEMENT ORDER WITHIN THIS FILE IS ALSO LOAD-BEARING. The backfill (PART 4) and its
--   refuse-to-commit guard BOTH precede the sweep's rule change (PART 5), so the exact-equality rule
--   can never exist without a completed backfill — see FINDING 5.
--
-- WHY. `avatars` was the only PUBLIC bucket in the project. /storage/v1/object/public/avatars/<uid>/<f>
-- serves the bytes to the entire internet with NO policy and NO JWT evaluated; `avatars_select_own`
-- governed only the authenticated storage API and never protected a single byte. A URL, once minted,
-- was PERMANENT: "Remove photo" could not revoke it, and any co-member given a URL held a permanent,
-- unrevokable, anonymously-fetchable link that outlived their membership.
-- A private bucket + short-lived signed URLs fixes all three, and the flip itself immediately
-- invalidates every public URL ever minted (the /object/public/ route starts returning 400).
-- This is a TENANT-ISOLATION change as much as a privacy one.
--
-- THE DESIGN IN ONE LINE: avatar_url stops storing a URL and stores the storage PATH; a co-workspace
-- SELECT policy gates on the object being REFERENCED by a members row you may see; and the sweep's
-- matching rule becomes exact equality against that same column — giving one invariant:
--     an object is VISIBLE  iff  it is REFERENCED  iff  it is NOT SWEPT.
--
-- ============================================================================================
-- LANDMINES
-- ============================================================================================
--  ⚠ THE HARD BLOCKER THIS CLOSES. `avatars_select_own` is own-folder ONLY. While the bucket was
--    public that never mattered (the public endpoint bypasses RLS), but signing REQUIRES SELECT —
--    proven by impersonation that a co-member selects ZERO of a peer's avatar object (proof R02).
--    Flipping the bucket flag alone silently degrades EVERY avatar except your own to initials.
--    `avatars_select_own` is KEPT and still load-bearing: it is how you read your own just-uploaded,
--    not-yet-saved object, which by definition has no members row pointing at it yet.
--
--  ⚠ THE TRIGGER PIN IS A CONTROL, NOT TIDINESS. Before this migration the trigger validated only the
--    public-URL PREFIX — it never checked the folder belonged to the row owner — and `authenticated`
--    already holds UPDATE (avatar_url). So user A could already point avatar_url at user B's object.
--    That was harmless while the bucket was public; the instant avatar_url GRANTS READ ACCESS to the
--    object it names, it becomes A publishing B's private/abandoned image to A's whole workspace.
--    The pin closes a gap that was live. Do not relax it. The single-segment character class (no '/')
--    also forecloses sub-path shapes that would let a crafted name become a suffix of another path.
--
--  ⚠ THE TRIGGER PINS TO new.id, NOT auth.uid(). Deliberate: the backfill below and any future DEFINER
--    maintenance run as postgres with no auth.uid(). new.id is the stronger statement anyway — the
--    path must belong to the profile row it sits on, regardless of who is writing.
--
--  ⚠ FINDING 5 — THE SWEEP RULE IS THE SHARPEST EDGE. The preceding migration matched by right()
--    suffix, written for a column holding a URL. Under a path column suffix matching HAPPENS TO STILL
--    WORK — it fails SILENTLY CORRECT, which is exactly what makes it dangerous. It is replaced with
--    exact equality, which is the truthful rule and identical to the visibility predicate. But exact
--    equality CANNOT match a legacy URL: a skipped or partial backfill would make the next hourly run
--    DELETE A LIVE, IN-USE AVATAR. (The one live object predates this change by six days, so the
--    1-hour age guard would NOT have protected it.) Hence two mitigations, both required and both
--    present below:
--      (i)  the backfill + a refuse-to-commit guard, before the rule change;
--      (ii) a fail-safe INSIDE the sweep that RAISES 55000 rather than deleting if any avatar_url is
--           not a bare path — so a restored backup, hand-edited row or reverted client makes the sweep
--           fail loudly in cron.job_run_details instead of quietly destroying faces it cannot parse.
--    The 1-hour age guard from 20260715142424 (BUG B) is preserved verbatim and is unrelated.
--
--  ⚠ storage.protect_delete() IS A STATEMENT-LEVEL BEFORE DELETE TRIGGER, so a direct SQL delete on
--    storage.objects raises 42501 BEFORE RLS is consulted. Two consequences: an avatars DELETE-policy
--    outcome is not behaviourally provable in SQL (the proof pins it structurally instead), and the
--    sweep only works because SET LOCAL session_replication_role='replica' disables that trigger.
--    Remove the SET LOCAL and the sweep silently collects nothing, forever.
--
--  ⚠ ROLLBACK IS NOT SYMMETRIC. Flipping the bucket back to public does NOT restore the old URLs in
--    members.avatar_url — the backfill is one-way. A revert needs its own forward migration that
--    re-prefixes the paths. Do not assume `update storage.buckets set public=true` undoes this.
--
--  ⚠ TWO TEST FILES ARE DELIBERATELY INVERTED BY THIS MIGRATION and were updated in the same commit:
--    avatars_upload_rls_rolled_back_proof.sql (its S-group now proves the reference rule in both
--    directions — a peer's REFERENCED object is visible, a peer's superseded object in the SAME folder
--    is not) and profile_and_avatar_rolled_back_proof.sql (it planted public-URL avatar_url values the
--    new trigger rejects, and it re-creates members_validate_profile inside its own transaction, so it
--    had to track the shipped body). If someone "fixes" the first by weakening PART 2, the hard
--    blocker comes back.
--
-- NOT DONE HERE, DELIBERATELY: no signed-URL minting in the DB (signing is a storage-api operation;
--   no pg_net, no edge function, no secrets); no revocation of already-downloaded bytes; no CDN purge
--   (edge-cached copies of previously-requested objects may survive their TTL — bounded, accepted, and
--   every NEW object is never public for even one instant); no widening of the mime allowlist
--   (png/jpeg/webp/gif, still NO svg — an SVG avatar is stored XSS the moment anything renders it
--   inline); no grant of avatar_url reads to anon.
-- ============================================================================================

-- ------------------------------------------------------------------ PART 1. the bucket flip
-- Previously shared public URLs die. That is the POINT, not a side effect.
update storage.buckets set public = false where id = 'avatars';

-- ------------------------------------------------------------------ PART 2. co-workspace SELECT
-- DEFINER, so the policy does not depend on nested RLS over public.members (members_select_self_or_shared
-- would in fact permit the same reads today, but a storage policy whose correctness rides on another
-- table's policy is a coupling that breaks quietly). The share check is re-applied EXPLICITLY here.
--
-- It gates on the object being REFERENCED, not on the FOLDER. Two reasons, both load-bearing:
--   (a) a folder-level rule would expose EVERY object in a co-worker's folder — including abandoned
--       uploads and superseded photos they thought they had replaced. The reference rule exposes
--       exactly the ONE object per person the app actually renders. A co-worker can see your current
--       face; they cannot see the four you rejected.
--   (b) it makes the policy and the sweep the SAME predicate, so visible <=> referenced <=> not swept
--       is an invariant rather than a coincidence.
-- It also avoids folder[1]::uuid, which would raise 22P02 on any malformed object name.
create or replace function private.is_visible_avatar_object(p_name text) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.members m
     where m.avatar_url = p_name
       and (m.id = auth.uid() or private.shares_workspace(m.id))
  );
$fn$;
revoke execute on function private.is_visible_avatar_object(text) from public, anon;
grant  execute on function private.is_visible_avatar_object(text) to authenticated;

-- Additive: OR'd with the existing avatars_select_own, which is retained (own not-yet-referenced
-- uploads). This one covers "someone I share a workspace with is currently USING this object".
drop policy if exists avatars_select_shared_workspace on storage.objects;
create policy avatars_select_shared_workspace on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and private.is_visible_avatar_object(name));

-- ------------------------------------------------------------------ PART 3. trigger rewrite
-- Recreated IN FULL (never a partial edit): display_name / status_text / status_emoji / bio blocks
-- are restated byte-for-byte from the live body; ONLY the avatar_url block changes. (Verified after
-- apply: zero differing characters in everything preceding the avatar_url block.)
create or replace function public.members_validate_profile() returns trigger
language plpgsql security definer set search_path to '' as $fn$
begin
  if (tg_op = 'INSERT' or new.display_name is distinct from old.display_name) and new.display_name is not null then
    if length(new.display_name) > 60 then
      raise exception 'display name is too long (max 60 characters)' using errcode = '22023';
    end if;
    if private._looks_like_role_title(new.display_name) then
      raise exception 'display name may not impersonate a role or title' using errcode = '42501';
    end if;
  end if;

  if new.status_text is not null then
    if length(new.status_text) > 80 then
      raise exception 'status is too long (max 80 characters)' using errcode = '22023';
    end if;
    if private._looks_like_role_title(new.status_text) then
      raise exception 'status may not impersonate a role or title' using errcode = '42501';
    end if;
  end if;

  if new.status_emoji is not null and length(btrim(new.status_emoji)) > 0 then
    if length(new.status_emoji) > 16 then
      raise exception 'status emoji is too long' using errcode = '22023';
    end if;
    if normalize(new.status_emoji, NFKC) ~ '[[:alnum:]]'
       or new.status_emoji ~ '[①-⓿㈀-㋿\U0001F100-\U0001F1E5\U0001F130-\U0001F189]' then
      raise exception 'status emoji must be an emoji, not letters or letter-like symbols' using errcode = '22023';
    end if;
  end if;

  if new.bio is not null and length(new.bio) > 280 then
    raise exception 'bio is too long (max 280 characters)' using errcode = '22023';
  end if;

  if new.avatar_url is not null and length(btrim(new.avatar_url)) > 0 then
    if length(new.avatar_url) > 2048 then
      raise exception 'avatar_url is too long' using errcode = '22023';
    end if;
    -- PATH, not URL. The bucket is private; there is no stable URL to store, and this value is what
    -- both avatars_select_shared_workspace and _sweep_orphan_avatars compare to storage.objects.name.
    -- Pinned to THIS ROW'S OWN uid folder: avatar_url grants read access to the object it names, so
    -- allowing a foreign path would let one user publish another user's object to their workspace.
    -- Single path segment only (no '/' in the class) — forecloses sub-paths and traversal.
    if new.avatar_url !~ ('^' || new.id::text || '/[A-Za-z0-9._-]{1,200}$') then
      raise exception 'avatar_url must be a storage path in your own avatars folder (<your-user-id>/<file>)'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$fn$;
revoke all on function public.members_validate_profile() from public, anon, authenticated;

drop trigger if exists members_validate_profile on public.members;
create trigger members_validate_profile
  before insert or update on public.members
  for each row execute function public.members_validate_profile();

-- ------------------------------------------------------------------ PART 4. backfill URL -> path
-- MUST run AFTER the trigger rewrite: the OLD trigger rejects a path, so a backfill placed above
-- would fail. Host matched as [^/]+ rather than the hardcoded project ref so a custom storage domain
-- is caught too; split_part strips any ?query a URL may have carried.
update public.members
   set avatar_url = split_part(
         regexp_replace(avatar_url, '^https?://[^/]+/storage/v1/object/public/avatars/', ''), '?', 1)
 where avatar_url is not null
   and avatar_url ~ '^https?://[^/]+/storage/v1/object/public/avatars/';

-- Refuse to commit a mixed-shape column. If ANY row survives that is not a bare own-uid path, this
-- migration aborts rather than hand a URL to an exact-equality sweep rule (FINDING 5, mitigation i).
do $backfill_guard$
declare v_bad int;
begin
  select count(*) into v_bad from public.members m
   where m.avatar_url is not null
     and length(btrim(m.avatar_url)) > 0
     and m.avatar_url !~ ('^' || m.id::text || '/[A-Za-z0-9._-]{1,200}$');
  if v_bad > 0 then
    raise exception 'BACKFILL INCOMPLETE: % members.avatar_url row(s) are not a bare own-uid path; refusing to commit', v_bad
      using errcode = '55000';
  end if;
end
$backfill_guard$;

-- ------------------------------------------------------------------ PART 5. sweep, re-pointed
-- Body is the preceding migration's, with exactly two changes:
--   * matching rule: right()-suffix  ->  exact equality (the column now holds the path itself)
--   * a fail-safe pre-check that RAISES rather than deleting if the column shape is ever violated
-- Everything else — the SET LOCAL idiom, the 1-hour age guard, DEFINER/search_path/revoke — is
-- preserved verbatim.
create or replace function private._sweep_orphan_avatars() returns void
language plpgsql security definer set search_path='' as $fn$
declare v_bad int;
begin
  -- FAIL-SAFE (FINDING 5, mitigation ii). Exact equality cannot recognise a URL-shaped value, so a
  -- single stale row would make the sweep delete a LIVE avatar. Fail closed, loudly, in
  -- cron.job_run_details — never silently destroy data we merely failed to parse.
  select count(*) into v_bad from public.members m
   where m.avatar_url is not null
     and length(btrim(m.avatar_url)) > 0
     and m.avatar_url !~ ('^' || m.id::text || '/[A-Za-z0-9._-]{1,200}$');
  if v_bad > 0 then
    raise exception 'avatar sweep aborted: % members.avatar_url row(s) are not a bare storage path; refusing to sweep', v_bad
      using errcode = '55000';
  end if;

  -- ⚠ THE `set local` IDIOM HERE IS LOAD-BEARING — DO NOT "IMPROVE" IT INTO set_config().
  -- session_replication_role is PGC_SUSET; set_config() requests it at USERSET for a non-superuser
  -- (this project's postgres is rolsuper=false / rolbypassrls=true) and is refused with 42501 on
  -- EVERY call. SET LOCAL takes a different path and is accepted — the shipped precedent
  -- (_sweep_orphan_task_attachments, 20260712124726 / 20260715142424) uses it. No save/restore is
  -- needed: a SET LOCAL inside a function carrying its own SET clause reverts on exit.
  set local session_replication_role = replica;

  delete from storage.objects o
   where o.bucket_id = 'avatars'
     -- THE AGE GUARD (BUG B, 20260715142424). pickAvatar uploads BEFORE members.avatar_url is
     -- written — and the modal may never be saved at all — so a freshly picked photo legitimately
     -- has no referencing row. The window here is WIDER than the attachment one: a human deciding.
     and o.created_at < now() - interval '1 hour'
     -- EXACT EQUALITY, not right()-suffix, not LIKE, not folder-level. The column now stores the
     -- object path itself, so equality is the truthful rule — and it is the SAME predicate as
     -- private.is_visible_avatar_object, which is what makes
     --     visible <=> referenced <=> not swept
     -- an invariant rather than a coincidence. (Folder-level would be catastrophic: a user has one
     -- live object and N dead ones in the SAME uid folder.)
     and not exists (
       select 1 from public.members m
        where m.avatar_url is not null
          and m.avatar_url = o.name);

  set local session_replication_role = origin;
end; $fn$;
revoke execute on function private._sweep_orphan_avatars() from public, anon, authenticated;
-- The 'avatar-orphan-sweep' cron job was created by the PRECEDING migration and is NOT re-scheduled
-- here; create-or-replace swaps the body under the existing schedule.
