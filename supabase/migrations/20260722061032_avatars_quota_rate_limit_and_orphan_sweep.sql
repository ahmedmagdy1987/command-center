-- ============================================================================================
-- avatars bucket: upload rate limit + per-user quota/cap + orphan sweep
-- Proven 37/37 rolled-back (supabase/tests/avatars_quota_rate_limit_and_orphan_sweep_rolled_back_proof.sql).
--
-- THE GAP. `avatars` was the ONLY one of the three buckets with NO rate limit, NO byte quota and NO
-- object cap. This is the storage-DoS shape the 2026-07-06 audit raised for voice-notes (L3) and that
-- 20260706035337 / 20260712111044 closed there — reintroduced by the newer bucket.
--
-- LIMITS: 12 uploads/hour/user (tightest of the three — a human changes their photo rarely);
--   20 objects/user and 20 MB/user (generous headroom over the ~90 KB steady state, because the
--   client mints a FRESH uid() filename on every upload with upsert:false, so a transient
--   client-delete failure must not lock a user out of their own profile).
--   The byte clause ADDS the incoming row's size so the quota is inclusive; the count clause is a
--   strict `< N` because the row is not counted yet. Both mirror task_attach_insert exactly.
--
-- COUNTING OPERATIONS, NOT SURVIVORS (the 20260712111044 lesson): the rate limit reads an
--   append-only log written by an AFTER INSERT trigger, so delete-then-reupload cannot reset it. The
--   byte/count quotas DO read storage.objects directly and are therefore survivor counts — correct,
--   because those two are COST caps and deleting genuinely frees the cost.
--
-- ⚠ LANDMINE: supabase/tests/avatars_upload_rls_rolled_back_proof.sql asserts against the previous
--   two-clause `avatars_insert_own`. This migration re-creates that policy with three more clauses.
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
-- MATCHING: exact SUFFIX comparison via right(), NOT `like '%'||o.name`. A LIKE pattern would treat
-- any % or _ inside an object name as a wildcard; object names are client-generated, so that is
-- attacker-influenced input and LIKE is the wrong tool. Matching on folder[1] alone would be
-- catastrophic in the other direction: a user legitimately has ONE live object and N dead ones in
-- the SAME uid folder, so a folder-level rule would delete the live one.
-- ⚠ THE `set local` IDIOM HERE IS LOAD-BEARING — DO NOT "IMPROVE" IT INTO set_config().
-- session_replication_role is PGC_SUSET; set_config() requests it at USERSET for a non-superuser
-- (this project's postgres is rolsuper=false / rolbypassrls=true) and is refused with 42501 on
-- EVERY call — the cron job would have errored every hour forever, silently. SET LOCAL takes a
-- different path and is accepted, which is why the shipped precedent
-- (_sweep_orphan_task_attachments, 20260712124726 / 20260715142424) uses it. No save/restore is
-- needed: a SET LOCAL inside a function carrying its own SET clause reverts on exit.
--
-- NOTE: the matching rule below is superseded by the very next migration
-- (20260722061442_avatars_private_bucket_and_signed_urls), which converts members.avatar_url from a
-- URL to a bare storage path and replaces right()-suffix with EXACT EQUALITY plus a fail-safe. This
-- body is the correct rule for the URL-shaped column it was written against; do not "restore" it.
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
-- sweep at :07) so three DEFINER jobs are not contending on the same tick.
select cron.unschedule('avatar-orphan-sweep')
 where exists (select 1 from cron.job where jobname = 'avatar-orphan-sweep');
select cron.schedule('avatar-orphan-sweep','30 * * * *', 'select private._sweep_orphan_avatars()');
