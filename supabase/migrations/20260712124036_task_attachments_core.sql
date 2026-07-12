-- Task file attachments — core (bucket + metadata table + RLS delegating to task predicates).
-- Design: TASK_ATTACHMENTS_DESIGN.md (approved). Delegates SELECT to can_view_task (= can_see_task,
-- inherits privacy + guest own/assigned scoping) and INSERT/quota to can_edit_task (mirrors
-- tasks_update_role: member/guest own-assigned, admin+ any) — never reimplements guest-scoping.
-- Proven rolled-back (feasibility A-E, 14/14): delegation matrix across outsider/guest/member/admin/owner;
-- member happy path (upload + metadata, workspace_id stamped from the parent task even when spoofed);
-- outsider metadata insert blocked 42501; outsider reads 0 metadata/0 objects; outsider storage upload
-- blocked 42501. Advisors clean; isolation 48/48 + role 40/40 held.

-- Private bucket: 25 MB/file, MIME allowlist (images + pdf + text/csv + zip + office; NO svg/executables).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-attachments','task-attachments', false, 26214400, array[
  'image/png','image/jpeg','image/gif','image/webp',
  'application/pdf','text/plain','text/csv','application/zip',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set public=excluded.public, file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;

-- Metadata table (immutable — no UPDATE policy/grant). workspace_id stamped by trigger from the parent task.
create table if not exists public.task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references public.tasks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  storage_path text not null unique,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
alter table public.task_attachments enable row level security;
revoke all on public.task_attachments from anon, public;
grant select, insert, delete on public.task_attachments to authenticated;
create index if not exists task_attachments_task_idx on public.task_attachments(task_id);
create index if not exists task_attachments_ws_idx on public.task_attachments(workspace_id);

-- Helpers (SECURITY DEFINER, search_path='', EXECUTE to authenticated only).
create or replace function private.can_view_task(p_task text) returns boolean language sql stable security definer set search_path='' as $fn$
  select private.can_see_task(auth.uid(), p_task);
$fn$;
create or replace function private.can_edit_task(p_task text) returns boolean language sql stable security definer set search_path='' as $fn$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task
      and private.is_workspace_member(t.workspace_id)
      and (t.privacy='workspace' or (t.privacy='private' and (t.created_by=auth.uid() or t.assignee_id=auth.uid())))
      and (private.workspace_role_rank(t.workspace_id) >= 2 or t.created_by=auth.uid() or t.assignee_id=auth.uid()));
$fn$;
create or replace function private.task_attachment_count(p_task text) returns int language sql stable security definer set search_path='' as $fn$
  select count(*)::int from public.task_attachments where task_id = p_task;
$fn$;
-- Live-bytes size quota + object-count cap read storage.objects directly (authoritative; deleting frees them — correct for a cost cap).
create or replace function private.workspace_attachment_bytes(p_ws uuid) returns bigint language sql stable security definer set search_path='' as $fn$
  select coalesce(sum((o.metadata->>'size')::bigint),0)::bigint from storage.objects o
    where o.bucket_id='task-attachments' and (storage.foldername(o.name))[1] = p_ws::text;
$fn$;
create or replace function private.workspace_attachment_object_count(p_ws uuid) returns int language sql stable security definer set search_path='' as $fn$
  select count(*)::int from storage.objects o
    where o.bucket_id='task-attachments' and (storage.foldername(o.name))[1] = p_ws::text;
$fn$;
revoke execute on function private.can_view_task(text), private.can_edit_task(text), private.task_attachment_count(text), private.workspace_attachment_bytes(uuid), private.workspace_attachment_object_count(uuid) from public, anon;
grant execute on function private.can_view_task(text), private.can_edit_task(text), private.task_attachment_count(text), private.workspace_attachment_bytes(uuid), private.workspace_attachment_object_count(uuid) to authenticated;

-- Authoritative workspace_id stamp from the parent task (client cannot spoof a mismatched workspace).
create or replace function public.set_attachment_workspace_id() returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  select t.workspace_id into new.workspace_id from public.tasks t where t.id = new.task_id;
  if new.workspace_id is null then raise exception 'task not found for attachment' using errcode='23503'; end if;
  return new;
end; $fn$;
revoke execute on function public.set_attachment_workspace_id() from public, anon, authenticated;
drop trigger if exists set_attachment_workspace_id on public.task_attachments;
create trigger set_attachment_workspace_id before insert on public.task_attachments for each row execute function public.set_attachment_workspace_id();

-- Metadata policies: SELECT = can_view_task; INSERT = self-uploader + can_edit_task + <20 per task; DELETE = uploader-own or admin+.
drop policy if exists task_attachments_select on public.task_attachments;
drop policy if exists task_attachments_insert on public.task_attachments;
drop policy if exists task_attachments_delete on public.task_attachments;
create policy task_attachments_select on public.task_attachments for select to authenticated using (private.can_view_task(task_id));
create policy task_attachments_insert on public.task_attachments for insert to authenticated
  with check (uploaded_by=(select auth.uid()) and private.can_edit_task(task_id) and private.task_attachment_count(task_id) < 20);
create policy task_attachments_delete on public.task_attachments for delete to authenticated
  using (uploaded_by=(select auth.uid()) or private.workspace_role_rank(workspace_id) >= 2);

-- Storage object policies: download iff a metadata row references it AND caller can view the task;
-- upload gated on the path (ws-member + can_edit_task) + 2 GB/ws size quota + per-ws object-count cap;
-- delete iff uploader-own or admin+ (via the metadata row).
drop policy if exists task_attach_select on storage.objects;
drop policy if exists task_attach_insert on storage.objects;
drop policy if exists task_attach_delete on storage.objects;
create policy task_attach_select on storage.objects for select to authenticated
  using (bucket_id='task-attachments' and exists (select 1 from public.task_attachments a where a.storage_path = name and private.can_view_task(a.task_id)));
create policy task_attach_insert on storage.objects for insert to authenticated
  with check (bucket_id='task-attachments'
    and private.is_workspace_member(((storage.foldername(name))[1])::uuid)
    and private.can_edit_task((storage.foldername(name))[2])
    and private.workspace_attachment_bytes(((storage.foldername(name))[1])::uuid) + coalesce((metadata->>'size')::bigint,0) <= 2147483648
    and private.workspace_attachment_object_count(((storage.foldername(name))[1])::uuid) < 2000);
create policy task_attach_delete on storage.objects for delete to authenticated
  using (bucket_id='task-attachments' and exists (select 1 from public.task_attachments a where a.storage_path = name and (a.uploaded_by=(select auth.uid()) or private.workspace_role_rank(a.workspace_id) >= 2)));
