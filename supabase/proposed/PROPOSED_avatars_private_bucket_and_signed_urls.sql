-- ============================================================================================
-- PROPOSED — avatars: PUBLIC bucket -> PRIVATE bucket + signed URLs
-- STATUS: NOT APPLIED. Awaits owner review.
--         Proof: PROPOSED_avatars_private_bucket_and_signed_urls_rolled_back_proof.sql
-- When approved: apply via apply_migration, then move this file to
--         supabase/migrations/<version-from-list_migrations>_avatars_private_bucket_and_signed_urls.sql
--         and the proof to supabase/tests/.
--
-- ⚠⚠ APPLY ORDER IS LOAD-BEARING. This migration MUST land AFTER
--    PROPOSED_avatars_quota_rate_limit_and_orphan_sweep.sql. See "ORDERING" at the bottom of this
--    header. Applying this one first leaves the sweep to be created later with its OLD matching
--    rule against the NEW column shape, and with no fail-safe.
--
-- ============================================================================================
-- WHY
-- ============================================================================================
-- `avatars` is the only PUBLIC bucket in the project (voice-notes and task-attachments are both
-- private). Live-verified 2026-07-19: storage.buckets.public = true. Consequences, all of which
-- the quota/sweep proposal already documented as residuals it could NOT fix:
--
--   1. NO POLICY AND NO JWT ARE EVALUATED on the read path. /storage/v1/object/public/avatars/<uid>/<f>
--      serves the bytes to the entire internet. `avatars_select_own` governs only the authenticated
--      storage API; it never protected a single byte.
--   2. A URL, once minted, is PERMANENT. "Remove photo" cannot revoke it; even deleting the object
--      leaves CDN copies. Every face ever uploaded to this product is currently a permanent public
--      asset on the project domain.
--   3. It is an open image host. Anyone with the project ref can enumerate nothing (names are
--      random) but anyone GIVEN a URL keeps it forever, across workspace removal, across account
--      deletion.
--
-- A private bucket + short-lived signed URLs fixes all three: reads become policy-gated and
-- time-boxed, and the flip itself immediately invalidates every public URL ever minted (the
-- /object/public/ route starts returning 400 for this bucket).
--
-- This is a TENANT-ISOLATION change as much as a privacy one: after this, your face is visible to
-- people you share a workspace with, and to nobody else. Today it is visible to everybody.
--
-- ============================================================================================
-- THE FOUR PARTS, AND THE BLOCKER EACH ONE ADDRESSES
-- ============================================================================================
--
-- PART 1 — THE BUCKET FLIP.  public = false.
--   Straightforward, and the only irreversible-feeling bit: previously shared public URLs die.
--   That is the POINT, not a side effect. Stated explicitly so nobody "fixes" it later.
--
-- PART 2 — THE HARD BLOCKER: a co-worker's avatar becomes UNREADABLE.
--   `avatars_select_own` is OWN-FOLDER ONLY:
--        (storage.foldername(name))[1] = auth.uid()::text
--   Under a public bucket that did not matter — rendering never touched a policy. Under a private
--   bucket, createSignedUrl REQUIRES SELECT on the object. A WS1 admin currently selects ZERO of a
--   co-member's avatar objects (asserted RED in the proof). So on flip day EVERY avatar except your
--   own would fail to sign and silently degrade to initials. A co-workspace SELECT policy is
--   MANDATORY, not optional.
--
--   The policy added here reuses `private.shares_workspace` (the existing membership helper that
--   already powers members_select_self_or_shared) rather than inventing a predicate. But it does
--   NOT gate on the FOLDER. It gates on the object being REFERENCED:
--
--        visible  <=>  some members row I may see has avatar_url = this object's name
--
--   Two reasons this is the right shape, and both matter:
--     (a) IT STAYS UN-LISTABLE IN THE WAY THAT COUNTS. A folder-level rule
--         (shares_workspace(folder[1]::uuid)) would expose EVERY object in a co-worker's folder —
--         including abandoned uploads and superseded photos they thought they had replaced. The
--         reference rule exposes exactly the ONE object per person that the app actually renders.
--         A co-worker can see your current face. They cannot see the four you rejected.
--     (b) IT MAKES THE SWEEP AND THE POLICY AGREE BY CONSTRUCTION. Both are now the same predicate
--         ("is this object referenced by a members row"), so the invariant is exact:
--              an object is VISIBLE  iff  it is REFERENCED  iff  it is NOT SWEPT.
--         There is no third state where something is renderable but collectable, or collectable but
--         renderable. That is what makes finding 5 provable rather than argued.
--   It also avoids `folder[1]::uuid`, which would raise 22P02 on any malformed object name and could
--   error out an otherwise-legal listing.
--
--   `avatars_select_own` is KEPT unchanged and is still load-bearing: it is how you read your own
--   just-uploaded, not-yet-saved object (the upsert-conflict read of 20260716131220, and the
--   preview in the still-open modal), which by definition has no members row pointing at it yet.
--
-- PART 3 — THE TRIGGER REWRITE.  members_validate_profile pins avatar_url with a literal regex to
--        '^https://nqlzjuxqgajeoypyzlnv\.supabase\.co/storage/v1/object/public/avatars/'
--   A signed URL can NEVER satisfy that (different route, and it carries a token + expiry, so it is
--   not a stable value to store anyway). The column must stop storing a URL and start storing the
--   STORAGE OBJECT PATH — which is also the only shape that lets PART 2's policy and the sweep
--   compare against storage.objects.name at all.
--
--   The new rule is TIGHTER than the old one in a way that is security-relevant, not cosmetic:
--        new.avatar_url ~ ('^' || new.id::text || '/[A-Za-z0-9._-]{1,200}$')
--   It pins the path to the ROW OWNER'S OWN uid folder. Under the old public-URL rule that was
--   merely tidy. Under PART 2 it is a CONTROL: avatar_url now GRANTS READ ACCESS to the object it
--   names. Without the pin, user A could set their avatar_url to user B's object path and thereby
--   publish B's private/abandoned image to A's entire workspace. The single-segment character class
--   (no '/') also forecloses the sub-path shapes that would let a crafted name become a suffix of
--   someone else's path.
--   Rejected by construction: the old public URL, any https URL, javascript:/data: URIs, path
--   traversal, another user's folder, sub-folders, and anything over 2048 chars.
--
-- PART 4 — THE BACKFILL, and why it is not cosmetic.
--   One live row today (VA, 0598a0bc-…, a 127-char absolute public URL) pointing at the one live
--   object (…/ltnts5q5w58m.jpg, 88,988 bytes, uploaded 2026-07-16). PART 3 makes that value
--   invalid, so it must be converted in the SAME migration. But the real reason it is load-bearing
--   is finding 5 — see below.
--
-- ============================================================================================
-- FINDING 5 — THE SWEEP INTERACTION. THE MOST DANGEROUS PART OF THIS CHANGE.
-- ============================================================================================
-- The approved quota/rate-limit/sweep proposal collects an avatars object when no members row
-- references it, matching by EXACT SUFFIX:
--        not exists (select 1 from public.members m
--                     where m.avatar_url is not null
--                       and right(m.avatar_url, length(o.name)) = o.name)
-- That rule was written for a column holding a URL, where the path is the URL's tail. This
-- migration changes the column to hold the PATH. Suffix matching happens to still work in that
-- world (path == name, so right() is a no-op) — which is exactly what makes it dangerous: it fails
-- SILENTLY CORRECT, so nobody notices the rule is now the wrong tool and it survives the next edit.
--
-- The rule is replaced with EXACT EQUALITY (`m.avatar_url = o.name`), which is the truthful
-- statement of the new model and identical to PART 2's visibility predicate. But exact equality has
-- a sharp edge that suffix matching did not have:
--
--   ⚠ EXACT EQUALITY DOES NOT MATCH A LEGACY URL. If the backfill were skipped, deferred, or
--     partially applied, the one live row would still hold a 127-char URL, the live object would
--     match nothing, and the very next hourly sweep run would DELETE A LIVE, IN-USE AVATAR.
--     Under the old suffix rule that same mistake was survivable. Under this one it is not.
--     This is asserted RED in the proof (assertion 6): with today's column shape, the new rule
--     reports the live object as collectable.
--
-- So this migration carries TWO mitigations, both required:
--   (i)  The backfill (PART 4) runs in the same transaction as the rule change, and a post-backfill
--        DO block RAISES if any surviving members.avatar_url does not match the new path shape.
--        The migration refuses to commit a mixed-shape column.
--   (ii) A FAIL-SAFE inside the sweep itself. Before deleting anything, _sweep_orphan_avatars now
--        checks for any avatar_url that is not a bare path and RAISES 55000 instead of proceeding.
--        A future code path that reintroduces a URL (a restored backup, a hand-edited row, a
--        reverted client) makes the sweep FAIL LOUDLY in cron.job_run_details rather than quietly
--        deleting the faces it cannot recognise. The sweep's job is reclaiming waste; it should
--        never be the thing that destroys live data, and it must fail closed to guarantee that.
-- The 1-hour age guard from 20260715142424 (BUG B) is preserved verbatim and is unrelated to this
-- — it protects a freshly picked photo while the modal is still open.
--
-- ============================================================================================
-- WHAT IS DELIBERATELY *NOT* DONE HERE
-- ============================================================================================
--   * NO client code. This migration alone BREAKS avatar rendering, because the client still stores
--     and renders getPublicUrl(). The client half ships in the same commit; see the notes returned
--     with this design for the exact file:line list. Do not apply this without it.
--   * NO change to avatars_insert_own / _update_own / _delete_own. Write pinning is already correct
--     and is re-proven unchanged (assertions 13-15). Note the quota/sweep migration re-creates
--     avatars_insert_own with three extra clauses; this migration must not fight it.
--   * NO signed-URL minting in the DB. Signing is a storage-api operation; the DB's only job is to
--     make SELECT authorize correctly. No pg_net, no edge function, no secrets.
--   * NO revocation of already-downloaded bytes. Flipping to private kills the URL; it cannot
--     un-see an image someone already saved. Inherent, stated, accepted.
--   * NO CDN purge. Flipping public->false may leave edge-cached copies of previously requested
--     objects reachable for the cache TTL. Accepted residual; it is bounded and small, and every
--     NEW object from this point on is never public for even one instant.
--   * NO widening of the mime allowlist. png/jpeg/webp/gif, still NO svg. Private or not, an SVG
--     avatar is stored XSS the moment anything renders it inline. MUST NOT be relaxed.
--   * NO grant of avatar_url reads to anon. Signed URLs are minted by an authenticated caller only.
--
-- ============================================================================================
-- LANDMINES
-- ============================================================================================
--  ⚠ ORDERING. Apply PROPOSED_avatars_quota_rate_limit_and_orphan_sweep.sql FIRST, this one SECOND.
--    Rationale: the sweep migration is currently proven (37/37) against the CURRENT column shape, so
--    landing it first is a no-risk step in a world it was proven in. This migration then flips the
--    shape and REPLACES the matching rule in one transaction, so there is never an instant where a
--    path-shaped column is exposed to a URL-shaped rule. The reverse order would create the sweep
--    later with the wrong rule and no fail-safe, and there is no reason to accept that.
--    This file uses `create or replace` on _sweep_orphan_avatars and does NOT re-schedule the cron
--    job — the job created by the first migration keeps its schedule and picks up the new body.
--
--  ⚠ supabase/tests/avatars_upload_rls_rolled_back_proof.sql asserts `A CANNOT read B's avatar
--    object` (assertion S01) and that A's bucket-wide listing returns exactly 1 row (S02). PART 2
--    deliberately changes both when B's object is REFERENCED and A shares a workspace with B. That
--    file MUST be updated in the same commit or it will fail — and if someone "fixes" it by
--    weakening PART 2, the blocker comes back. Same house rule as the _looks_like_role_title
--    landmine in 20260718195827 and the avatars_insert_own landmine in the sweep proposal.
--
--  ⚠ supabase/tests/profile_and_avatar_rolled_back_proof.sql (40/40) plants public-URL avatar_url
--    values. Those become invalid under PART 3. Update in the same commit.
--
--  ⚠ THE COLUMN IS NOW A CAPABILITY. members.avatar_url no longer merely describes a picture; it
--    AUTHORIZES reads of the named object for everyone who shares a workspace with that member. Any
--    future code that writes avatar_url on someone's behalf, or any relaxation of the own-uid pin in
--    PART 3, is a read-access grant. Treat it as one.
--
--  ⚠ THE TRIGGER PINS TO new.id, NOT auth.uid(). Deliberate: the backfill and any future DEFINER
--    maintenance run as postgres with no auth.uid(), and an auth.uid() pin would either break them
--    or have to be bypassed. new.id is the stronger statement anyway — the path must belong to the
--    profile row it sits on, regardless of who is writing.
--
--  ⚠ storage.protect_delete() IS A STATEMENT-LEVEL TRIGGER, discovered while running the proof. A
--    direct SQL `delete from storage.objects` is refused with 42501 "Direct deletion from storage
--    tables is not allowed" BEFORE RLS is ever consulted. Two consequences: (a) you cannot prove an
--    avatars DELETE-policy outcome behaviourally in SQL — the proof asserts the guard behaviourally
--    (message pinned, since 42501 is shared with RLS denial) and the policy shape from pg_policy;
--    (b) the sweep only works because SET LOCAL session_replication_role='replica' disables that
--    trigger. Remove the SET LOCAL and the sweep silently collects nothing, forever.
--
--  ⚠ ROLLBACK IS NOT SYMMETRIC. Flipping the bucket back to public does not restore the old URLs in
--    members.avatar_url — the backfill is one-way. A revert needs its own forward migration that
--    re-prefixes the paths. Do not assume `update storage.buckets set public=true` undoes this.
-- ============================================================================================

-- ------------------------------------------------------------------ PART 1. the bucket flip
update storage.buckets set public = false where id = 'avatars';

-- ------------------------------------------------------------------ PART 2. co-workspace SELECT
-- DEFINER, so the policy does not depend on nested RLS over public.members (members_select_self_or_shared
-- would in fact permit the same reads today, but a storage policy whose correctness rides on another
-- table's policy is a coupling that breaks quietly). The share check is re-applied EXPLICITLY here.
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
-- are restated byte-for-byte from the live body read 2026-07-19; ONLY the avatar_url block changes.
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
-- migration aborts rather than hand a URL to an exact-equality sweep rule (finding 5, mitigation i).
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
-- See FINDING 5 above. Body is the approved proposal's, with exactly two changes:
--   * matching rule: right()-suffix  ->  exact equality (the column now holds the path itself)
--   * a fail-safe pre-check that RAISES rather than deleting if the column shape is ever violated
-- Everything else — the SET LOCAL idiom, the 1-hour age guard, DEFINER/search_path/revoke — is
-- preserved verbatim, including the comment explaining why SET LOCAL must not become set_config().
create or replace function private._sweep_orphan_avatars() returns void
language plpgsql security definer set search_path='' as $fn$
declare v_bad int;
begin
  -- FAIL-SAFE (finding 5, mitigation ii). Exact equality cannot recognise a URL-shaped value, so a
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
-- The 'avatar-orphan-sweep' cron job is created by the PRECEDING migration and is NOT re-scheduled
-- here; create-or-replace swaps the body under the existing schedule.
