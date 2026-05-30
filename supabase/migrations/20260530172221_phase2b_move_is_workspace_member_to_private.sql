-- Phase 2b: move is_workspace_member out of the API-exposed `public` schema into a
-- private (non-PostgREST) schema to clear authenticated_security_definer_function_executable,
-- while KEEPING the approved SECURITY DEFINER design. Re-points the 14 data-table policies
-- to private.is_workspace_member. No behavior change (verified: per-user counts unchanged,
-- tenant isolation a/b/c still holds, advisors clean).

create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_workspace_member(ws_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = ws_id
      and wm.user_id = auth.uid()
  );
$$;

revoke execute on function private.is_workspace_member(uuid) from public;
revoke execute on function private.is_workspace_member(uuid) from anon;
grant  execute on function private.is_workspace_member(uuid) to authenticated;

-- Re-point every policy on the 4 tables (drop all, recreate referencing private.is_workspace_member).
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname='public' and tablename in ('tasks','comments','messages','notifications')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- TASKS
create policy tasks_select_workspace_or_own_private on public.tasks
  for select to authenticated
  using ( private.is_workspace_member(workspace_id)
    and (privacy='workspace' or (privacy='private' and created_by=(select auth.uid()))) );
create policy tasks_insert_member on public.tasks
  for insert to authenticated
  with check ( private.is_workspace_member(workspace_id)
    and (privacy='workspace' or (privacy='private' and created_by=(select auth.uid()))) );
create policy tasks_update_workspace_or_own_private on public.tasks
  for update to authenticated
  using ( private.is_workspace_member(workspace_id)
    and (privacy='workspace' or (privacy='private' and created_by=(select auth.uid()))) )
  with check ( private.is_workspace_member(workspace_id)
    and (privacy='workspace' or (privacy='private' and created_by=(select auth.uid()))) );
create policy tasks_delete_workspace_or_own_private on public.tasks
  for delete to authenticated
  using ( private.is_workspace_member(workspace_id)
    and (privacy='workspace' or (privacy='private' and created_by=(select auth.uid()))) );

-- COMMENTS
create policy comments_select_visible on public.comments
  for select to authenticated
  using ( exists (select 1 from public.tasks t where t.id = comments.task_id) );
create policy comments_insert_own on public.comments
  for insert to authenticated
  with check ( author_id=(select auth.uid()) and private.is_workspace_member(workspace_id)
    and exists (select 1 from public.tasks t where t.id=comments.task_id and t.workspace_id=comments.workspace_id) );
create policy comments_update_own on public.comments
  for update to authenticated
  using ( author_id=(select auth.uid()) and private.is_workspace_member(workspace_id) )
  with check ( author_id=(select auth.uid()) and private.is_workspace_member(workspace_id) );
create policy comments_delete_own on public.comments
  for delete to authenticated
  using ( author_id=(select auth.uid()) and private.is_workspace_member(workspace_id) );

-- MESSAGES
create policy messages_select_member on public.messages
  for select to authenticated
  using ( private.is_workspace_member(workspace_id) );
create policy messages_insert_member on public.messages
  for insert to authenticated
  with check ( sender_id=(select auth.uid()) and private.is_workspace_member(workspace_id) );
create policy messages_update_own on public.messages
  for update to authenticated
  using ( sender_id=(select auth.uid()) and private.is_workspace_member(workspace_id) )
  with check ( sender_id=(select auth.uid()) and private.is_workspace_member(workspace_id) );
create policy messages_delete_own on public.messages
  for delete to authenticated
  using ( sender_id=(select auth.uid()) and private.is_workspace_member(workspace_id) );

-- NOTIFICATIONS
create policy "Recipients can read their notifications" on public.notifications
  for select to authenticated
  using ( recipient_id=(select auth.uid()) and private.is_workspace_member(workspace_id) );
create policy "Recipients can update their notifications" on public.notifications
  for update to authenticated
  using ( recipient_id=(select auth.uid()) and private.is_workspace_member(workspace_id) )
  with check ( recipient_id=(select auth.uid()) and private.is_workspace_member(workspace_id) );
create policy "Recipients can delete their notifications" on public.notifications
  for delete to authenticated
  using ( recipient_id=(select auth.uid()) and private.is_workspace_member(workspace_id) );

-- Drop the now-unreferenced public copy.
drop function if exists public.is_workspace_member(uuid);
