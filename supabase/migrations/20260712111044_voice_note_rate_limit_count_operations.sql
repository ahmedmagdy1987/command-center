-- [V-4] Voice-note rate limit counts OPERATIONS, not survivors (2026-07-12 audit — SECURITY_AUDIT_2026-07-12.md).
-- private.voice_note_upload_allowed()'s 30/hr clause counted SURVIVING objects by created_at, so a
-- delete-then-reupload loop kept the survivor count low and never tripped the cap (proven: 35/35
-- uploads via delete+reupload vs a hard 30 cap). Storage-cost stayed bounded by the 1000/10GB cap,
-- but operation/bandwidth churn was unbounded.
--
-- Fix: record each successful upload in an append-only per-user log (deletes never touch it) via an
-- AFTER INSERT trigger on storage.objects, and count LOG ROWS in the last hour for the 30/hr cap. The
-- 1000-object absolute cap stays a survivor count (deleting genuinely frees footprint, so that is
-- correct there). The trigger opportunistically prunes each user's >1h-old log rows (they no longer
-- count), keeping the table to ~an hour of rows per user. A non-uuid folder (e.g. a service-role
-- write) is skipped, never blocking the insert. The voice_notes_insert_member policy is unchanged —
-- it already calls voice_note_upload_allowed().
--
-- Proven rolled-back before apply: with the current fn a delete+reupload loop bypasses the cap
-- (35/35); with this fn the same loop is blocked at 30 (31st rejected) with 0 surviving objects yet
-- 30 ops logged (delete-resistant); a normal user uploading without deleting is unaffected (5/5).
-- Isolation regression held; advisors clean.

create table if not exists private.voice_note_upload_log(
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists voice_note_upload_log_user_time_idx
  on private.voice_note_upload_log(user_id, created_at);
revoke all on private.voice_note_upload_log from anon, authenticated, public;

-- AFTER INSERT trigger: append-only op-record, delete-resistant. SECURITY DEFINER so it can write the
-- private log regardless of the (authenticated) uploader's grants; search_path='' per convention.
create or replace function private.log_voice_note_upload()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_uid uuid;
begin
  begin
    v_uid := (storage.foldername(new.name))[1]::uuid;
  exception when others then
    return new;  -- non-uuid folder (e.g. a service-role write): don't log, never block the insert
  end;
  insert into private.voice_note_upload_log(user_id) values (v_uid);
  -- only the last rolling hour matters for the rate cap; keep the table bounded per user
  delete from private.voice_note_upload_log
    where user_id = v_uid and created_at < now() - interval '1 hour';
  return new;
end;
$fn$;
revoke execute on function private.log_voice_note_upload() from public, anon, authenticated;

drop trigger if exists voice_note_upload_log on storage.objects;
create trigger voice_note_upload_log
  after insert on storage.objects
  for each row when (new.bucket_id = 'voice-notes')
  execute function private.log_voice_note_upload();

-- Rate cap now counts operations (append-only log); absolute cap stays a survivor count.
create or replace function private.voice_note_upload_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    (select count(*) from private.voice_note_upload_log l
       where l.user_id = auth.uid()
         and l.created_at > now() - interval '1 hour') < 30
    and
    (select count(*) from storage.objects o
       where o.bucket_id = 'voice-notes'
         and (storage.foldername(o.name))[1] = (auth.uid())::text) < 1000;
$fn$;
revoke execute on function private.voice_note_upload_allowed() from public, anon;
grant  execute on function private.voice_note_upload_allowed() to authenticated;
