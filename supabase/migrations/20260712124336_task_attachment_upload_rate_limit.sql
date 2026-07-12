-- Task-attachment upload RATE limit — counts OPERATIONS (delete-resistant), mirroring the hardened
-- voice-note pattern (20260712111044). The core's 2 GB size quota + object-count cap are survivor
-- counts (correct for a cost cap), but a delete-then-reupload loop churns operations without tripping
-- them. Record each successful upload in an append-only per-user log via an AFTER INSERT trigger on
-- storage.objects, and cap at 60 uploads/hour/user (a human attaching files never approaches this;
-- it stops automated abuse). Deletes never touch the log, so the cap cannot be reset by deleting.
-- Proven rolled-back before apply: no-rate-limit core allows 65/65 delete+reupload; after this, blocked
-- at 60 (0 survivors yet 60 ops logged); a different user's normal uploads are unaffected (5/5).

create table if not exists private.task_attachment_upload_log(
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists task_attachment_upload_log_user_time_idx on private.task_attachment_upload_log(user_id, created_at);
revoke all on private.task_attachment_upload_log from anon, authenticated, public;

create or replace function private.log_task_attachment_upload() returns trigger language plpgsql security definer set search_path='' as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return new; end if;  -- service-role / unauthenticated writes are not rate-limited
  insert into private.task_attachment_upload_log(user_id) values (v_uid);
  -- only the last rolling hour matters for the rate cap; keep the table bounded per user
  delete from private.task_attachment_upload_log where user_id = v_uid and created_at < now() - interval '1 hour';
  return new;
end; $fn$;
revoke execute on function private.log_task_attachment_upload() from public, anon, authenticated;
drop trigger if exists task_attachment_upload_log on storage.objects;
create trigger task_attachment_upload_log after insert on storage.objects
  for each row when (new.bucket_id = 'task-attachments')
  execute function private.log_task_attachment_upload();

create or replace function private.task_attachment_upload_allowed() returns boolean language sql stable security definer set search_path='' as $fn$
  select (select count(*) from private.task_attachment_upload_log l
            where l.user_id = auth.uid() and l.created_at > now() - interval '1 hour') < 60;
$fn$;
revoke execute on function private.task_attachment_upload_allowed() from public, anon;
grant execute on function private.task_attachment_upload_allowed() to authenticated;

-- Re-assert task_attach_insert with the operations-rate check appended (all other clauses unchanged).
drop policy if exists task_attach_insert on storage.objects;
create policy task_attach_insert on storage.objects for insert to authenticated
  with check (bucket_id='task-attachments'
    and private.is_workspace_member(((storage.foldername(name))[1])::uuid)
    and private.can_edit_task((storage.foldername(name))[2])
    and private.workspace_attachment_bytes(((storage.foldername(name))[1])::uuid) + coalesce((metadata->>'size')::bigint,0) <= 2147483648
    and private.workspace_attachment_object_count(((storage.foldername(name))[1])::uuid) < 2000
    and private.task_attachment_upload_allowed());
