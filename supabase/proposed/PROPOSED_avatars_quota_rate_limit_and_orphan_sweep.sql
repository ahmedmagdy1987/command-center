-- ============================================================================================
-- PROPOSED — avatars bucket: upload rate limit + per-user quota/cap + orphan sweep
-- STATUS: NOT APPLIED. Awaits owner approval + the rolled-back proof run.
--         See PROPOSED_avatars_quota_rate_limit_and_orphan_sweep_rolled_back_proof.sql.
-- When approved: apply via apply_migration, then move this file to
--         supabase/migrations/<version-from-list_migrations>_avatars_quota_rate_limit_and_orphan_sweep.sql
--         and the proof to supabase/tests/.
--
-- THE GAP. `avatars` is the ONLY one of the three buckets with NO rate limit, NO byte quota and NO
-- object cap. Live-verified 2026-07-19: storage.objects carries exactly two upload-log triggers
-- (voice-notes, task-attachments) and there is no avatars equivalent; `avatars_insert_own` is a bare
-- two-clause policy (bucket + own folder). This is the storage-DoS shape the 2026-07-06 audit raised
-- for voice-notes (L3) and that 20260706035337 / 20260712111044 closed there — reintroduced by the
-- newer bucket.
--
-- ⚠ AND IT IS WORSE HERE THAN FOR EITHER PRECEDENT, because **`avatars` is PUBLIC** (public=true;
--   the other two are private). Three consequences that change the priority of this work:
--     1. PRIVACY, not just cost. Objects serve from /storage/v1/object/public/avatars/<uid>/<file>
--        with NO policy evaluated and NO JWT. `avatars_select_own` governs only the authenticated
--        storage API; it does not protect the bytes. So an orphan is not invisible waste — it stays
--        WORLD-READABLE forever. A user who clicks "Remove photo" reasonably believes the image is
--        gone; today it is still live and public, because the client only nulls members.avatar_url
--        and never deletes the object.
--     2. ABUSE ESCALATES. A private bucket serves only authenticated tenant members, so junk uploads
--        cost storage. A public bucket is an open CDN: uploads are world-reachable, so the abuse case
--        becomes unauthenticated public image hosting off the project domain. (The mime allowlist —
--        png/jpeg/webp/gif, NO svg — already blocks stored-XSS-via-SVG and MUST NOT be relaxed.)
--     3. Deleting an object does NOT revoke a URL already shared, and CDN caching means even the
--        delete is not instantly effective. Avatar URLs are permanently public once minted. That is
--        inherent to public=true and is NOT fixed here; it is stated so it is a known residual.
--
-- WHY AN ORPHAN SWEEP IS REQUIRED AND NOT JUST A CLIENT DELETE. `pickAvatar`
-- (VisualTaskCommandCenter.jsx:3699) uploads IMMEDIATELY on file-pick, and `members.avatar_url` is
-- only written later by save() — and never at all if the user closes the modal. So abandonment leaks
-- a public object that no client code can ever clean up (the tab is gone). The client-side delete
-- being added alongside this migration covers replace + remove; the sweep is the backstop for
-- abandonment, failed deletes, and everything already stranded.
--
-- ⚠ THE SWEEP CARRIES THE 20260715142424 AGE GUARD, and here it is MORE load-bearing than it was for
--   task-attachments: the avatars client has the same upload-first/reference-second ordering, but a
--   WIDER window (a human deciding whether to keep a photo, vs a programmatic metadata insert). A
--   sweep without `o.created_at < now() - interval '1 hour'` would delete the photo a user just
--   picked while their modal is still open. That is BUG B from the 2026-07-15 pass, and it is
--   reproduced deliberately in the proof's RED phase.
--
-- LIVE FACTS AT DESIGN TIME (read-only, 2026-07-19): 1 object, 88,988 bytes, 1 uid folder;
--   1 of 4 members has an avatar_url; **0 orphans**. There is no cleanup debt — this is preventive,
--   which is the cheapest moment to add it.
--
-- LIMITS, and why these numbers:
--   * 12 uploads/hour/user. A human changes their profile photo a handful of times ever; the
--     precedents are 30/hr (voice notes) and 60/hr (attachments), both for buckets where frequent
--     writes are the NORMAL workflow. Avatars are not, so this is deliberately the tightest of the
--     three and still ~an order of magnitude above real use.
--   * 20 objects/user and 20 MB/user. Both are generous headroom over the steady state (1 object,
--     ~90 KB) — deliberately, because the client mints a FRESH uid() filename on every upload
--     (upsert:false, documented and load-bearing at api.js:93-99) so a transient client-delete
--     failure must not lock a user out of their own profile. They bound the DoS hard regardless:
--     unlimited becomes 20 objects / 20 MB per user, and the sweep reclaims the dead ones hourly.
--   * The byte clause ADDS the incoming row's size (`+ coalesce((metadata->>'size')::bigint,0)`) so
--     the quota is inclusive of the object being inserted; the count clause is a strict `< N` because
--     the row is not counted yet. Both mirror task_attach_insert exactly.
--
-- COUNTING OPERATIONS, NOT SURVIVORS (the 20260712111044 lesson): the rate limit reads an
--   append-only log written by an AFTER INSERT trigger, so delete-then-reupload cannot reset it. The
--   byte/count quotas DO read storage.objects directly and are therefore survivor counts — correct,
--   because those two are COST caps and deleting genuinely frees the cost. Same split as attachments.
--
-- NAMING follows the two precedents exactly: private.<subject>_upload_log / log_<subject>_upload() /
--   <subject>_upload_allowed(), trigger name == log table name.
--
-- ⚠ COMPANION CLIENT WORK (required, same piece of work — this migration alone leaves "Remove photo"
--   still orphaning): api.js gains `members.removeAvatar(url)` (derive the object path from the
--   public URL, `storage.from('avatars').remove([path])`), ProfileModal calls it on "Remove photo"
--   AND before replacing an existing photo. That is what finally makes `avatars_delete_own` — dead
--   since 20260716110514 — a reachable policy.
--
-- ⚠ LANDMINE: supabase/tests/avatars_upload_rls_rolled_back_proof.sql asserts against the CURRENT
--   two-clause `avatars_insert_own`. This migration re-creates that policy with three more clauses,
--   so that file must be updated in the same commit or it silently proves a policy that no longer
--   ships. (Same house rule as the _looks_like_role_title landmine in 20260718195827.)
-- ============================================================================================

-- ------------------------------------------------------------------ 1. append-only upload log
create table if not exists private.avatar_upload_log(
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists avatar_upload_log_user_time_idx on private.avatar_upload_log(user_id, created_at);
revoke all on private.avatar_upload_log from anon, authenticated, public;

create or replace function private.log_avatar_upload() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return new; end if;   -- service-role / sweep writes are not rate-limited
  insert into private.avatar_upload_log(user_id) values (v_uid);
  -- only the rolling hour matters for the cap; keep the table bounded per user
  delete from private.avatar_upload_log where user_id = v_uid and created_at < now() - interval '1 hour';
  return new;
end; $fn$;
revoke execute on function private.log_avatar_upload() from public, anon, authenticated;

drop trigger if exists avatar_upload_log on storage.objects;
create trigger avatar_upload_log after insert on storage.objects
  for each row when (new.bucket_id = 'avatars')
  execute function private.log_avatar_upload();

-- ------------------------------------------------------------------ 2. gates
create or replace function private.avatar_upload_allowed() returns boolean
language sql stable security definer set search_path='' as $fn$
  select (select count(*) from private.avatar_upload_log l
            where l.user_id = auth.uid() and l.created_at > now() - interval '1 hour') < 12;
$fn$;
revoke execute on function private.avatar_upload_allowed() from public, anon;
grant  execute on function private.avatar_upload_allowed() to authenticated;

-- Survivor counts, scoped to ONE user's folder (contrast the attachment helpers, scoped to a
-- workspace) — for avatars the blast radius of an abuser is their own folder, and folder[1] is
-- already pinned to auth.uid() by the policy below.
create or replace function private.user_avatar_bytes(p_uid uuid) returns bigint
language sql stable security definer set search_path='' as $fn$
  select coalesce(sum((o.metadata->>'size')::bigint),0)::bigint from storage.objects o
   where o.bucket_id='avatars' and (storage.foldername(o.name))[1] = p_uid::text;
$fn$;
create or replace function private.user_avatar_object_count(p_uid uuid) returns int
language sql stable security definer set search_path='' as $fn$
  select count(*)::int from storage.objects o
   where o.bucket_id='avatars' and (storage.foldername(o.name))[1] = p_uid::text;
$fn$;
revoke execute on function private.user_avatar_bytes(uuid), private.user_avatar_object_count(uuid) from public, anon;
grant  execute on function private.user_avatar_bytes(uuid), private.user_avatar_object_count(uuid) to authenticated;

-- ------------------------------------------------------------------ 3. re-assert the INSERT policy
-- DROP + CREATE in full (never ALTER), restating both original clauses verbatim and appending the
-- three new ones — the same shape 20260712124336 used for task_attach_insert.
drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects for insert to authenticated
  with check (bucket_id='avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and private.user_avatar_bytes((select auth.uid())) + coalesce((metadata->>'size')::bigint,0) <= 20971520
    and private.user_avatar_object_count((select auth.uid())) < 20
    and private.avatar_upload_allowed());

-- ------------------------------------------------------------------ 4. orphan sweep (3rd pg_cron job)
-- Collects avatars objects no members row references. `session_replication_role='replica'` is what
-- gets past storage's protect_objects_delete guard — the identical trick
-- _sweep_orphan_task_attachments already uses.
--
-- MATCHING: exact SUFFIX comparison via right(), NOT `like '%'||o.name`. A LIKE pattern would treat
-- any % or _ inside an object name as a wildcard; object names are client-generated
-- (`<uid>/<uid()>.<ext>`), so that is attacker-influenced input and LIKE is the wrong tool. Matching
-- on folder[1] alone would be catastrophic in the other direction: a user legitimately has ONE live
-- object and N dead ones in the SAME uid folder, so a folder-level rule would delete the live one.
-- ⚠ THE `set local` IDIOM HERE IS LOAD-BEARING — DO NOT "IMPROVE" IT INTO set_config().
-- The first draft of this function used
--     select current_setting('session_replication_role', true) into v_prev;
--     perform set_config('session_replication_role','replica', true);   -- and restored it at the end
-- so it could save and restore the prior value. That version RAISES 42501 'permission denied to set
-- parameter session_replication_role' on EVERY call, which the rolled-back proof caught (assertion
-- D01): the cron job would have errored every hour forever and collected nothing, silently.
-- WHY: session_replication_role is PGC_SUSET. set_config() requests it at
-- `superuser() ? PGC_SUSET : PGC_USERSET`, and this project's `postgres` role is NOT a superuser
-- (rolsuper=false, rolbypassrls=true), so the request downgrades and is refused. SECURITY DEFINER
-- does not help — the effective user inside the function is the owner, which is that same postgres.
-- `SET LOCAL` takes a different path and is accepted, which is why the shipped precedent
-- (_sweep_orphan_task_attachments, 20260712124726 / 20260715142424) uses it.
-- The save/restore was never needed anyway: a SET LOCAL made inside a function that carries its own
-- SET clause (this one has `set search_path=''`) is reverted automatically when the function exits.
create or replace function private._sweep_orphan_avatars() returns void
language plpgsql security definer set search_path='' as $fn$
begin
  set local session_replication_role = replica;

  delete from storage.objects o
   where o.bucket_id = 'avatars'
     -- THE AGE GUARD (BUG B, 20260715142424). pickAvatar uploads BEFORE members.avatar_url is
     -- written — and the modal may never be saved at all — so a freshly picked photo legitimately
     -- has no referencing row. Without this, the sweep deletes the image out from under a user whose
     -- modal is still open. The window here is WIDER than the attachment one: a human deciding.
     and o.created_at < now() - interval '1 hour'
     and not exists (
       select 1 from public.members m
        where m.avatar_url is not null
          and right(m.avatar_url, length(o.name)) = o.name);

  set local session_replication_role = origin;
end; $fn$;
revoke execute on function private._sweep_orphan_avatars() from public, anon, authenticated;

-- Hourly, at :30 — offset from the two existing jobs (due-date-reminders at :00, the attachment
-- sweep also hourly) so three DEFINER jobs are not contending on the same tick.
select cron.unschedule('avatar-orphan-sweep')
 where exists (select 1 from cron.job where jobname = 'avatar-orphan-sweep');
select cron.schedule('avatar-orphan-sweep','30 * * * *', 'select private._sweep_orphan_avatars()');
