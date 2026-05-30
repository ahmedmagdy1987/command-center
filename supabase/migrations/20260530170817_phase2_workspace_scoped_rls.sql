-- ============================================================================
-- Phase 2: workspace-scoped (tenant-isolated) RLS on tasks/comments/messages/
-- notifications. Membership gating ON TOP of the existing within-workspace rules.
-- No app code change; identical behavior for the current single-workspace team.
-- Existing triggers (notify_*, tasks_align_privacy, set_workspace_id) untouched.
-- notifications.workspace_id intentionally stays NULLABLE (recipient_id is the real
-- isolation gate; a null-workspace notif is hidden by is_workspace_member anyway, no
-- leak) so an indirect notify_* insert can never roll back the parent user action.
--
-- NOTE: is_workspace_member is created here in `public`; migration 20260530172221
-- relocates it to a private (non-API) schema to clear the
-- authenticated_security_definer_function_executable advisor.
-- ============================================================================

-- 1. Membership helper (SECURITY DEFINER; bypasses workspace_members RLS; STABLE) ----
create or replace function public.is_workspace_member(ws_id uuid)
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

revoke execute on function public.is_workspace_member(uuid) from public;
revoke execute on function public.is_workspace_member(uuid) from anon;
grant  execute on function public.is_workspace_member(uuid) to authenticated;

-- 2. Drop EVERY existing policy on the 4 tables by its real name (robust; no reliance
--    on the new names matching the old ones), then recreate only the new set. ----------
do $$
declare r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('tasks','comments','messages','notifications')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- 3. TASKS = membership AND existing privacy rule; INSERT/UPDATE WITH CHECK also
--    require membership of the row's workspace_id. -------------------------------------
create policy tasks_select_workspace_or_own_private on public.tasks
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (privacy = 'workspace' or (privacy = 'private' and created_by = (select auth.uid())))
  );

create policy tasks_insert_member on public.tasks
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (privacy = 'workspace' or (privacy = 'private' and created_by = (select auth.uid())))
  );

create policy tasks_update_workspace_or_own_private on public.tasks
  for update to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (privacy = 'workspace' or (privacy = 'private' and created_by = (select auth.uid())))
  )
  with check (
    public.is_workspace_member(workspace_id)
    and (privacy = 'workspace' or (privacy = 'private' and created_by = (select auth.uid())))
  );

create policy tasks_delete_workspace_or_own_private on public.tasks
  for delete to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (privacy = 'workspace' or (privacy = 'private' and created_by = (select auth.uid())))
  );

-- 4. COMMENTS: SELECT inherits task visibility (now transitively workspace-scoped);
--    INSERT adds author + membership + comment.workspace_id = task's workspace;
--    UPDATE/DELETE add membership (defense-in-depth). ----------------------------------
create policy comments_select_visible on public.comments
  for select to authenticated
  using ( exists (select 1 from public.tasks t where t.id = comments.task_id) );

create policy comments_insert_own on public.comments
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.tasks t
      where t.id = comments.task_id
        and t.workspace_id = comments.workspace_id
    )
  );

create policy comments_update_own on public.comments
  for update to authenticated
  using  ( author_id = (select auth.uid()) and public.is_workspace_member(workspace_id) )
  with check ( author_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

create policy comments_delete_own on public.comments
  for delete to authenticated
  using ( author_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

-- 5. MESSAGES: per-workspace isolated channel; membership-gated; own-only for write -----
create policy messages_select_member on public.messages
  for select to authenticated
  using ( public.is_workspace_member(workspace_id) );

create policy messages_insert_member on public.messages
  for insert to authenticated
  with check ( sender_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

create policy messages_update_own on public.messages
  for update to authenticated
  using  ( sender_id = (select auth.uid()) and public.is_workspace_member(workspace_id) )
  with check ( sender_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

create policy messages_delete_own on public.messages
  for delete to authenticated
  using ( sender_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

-- 6. NOTIFICATIONS: recipient-only AND membership (defense-in-depth). No INSERT policy
--    (rows come only from the SECURITY DEFINER notify_* triggers, which bypass RLS;
--    authenticated has no INSERT grant). Names preserved. -------------------------------
create policy "Recipients can read their notifications" on public.notifications
  for select to authenticated
  using ( recipient_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

create policy "Recipients can update their notifications" on public.notifications
  for update to authenticated
  using  ( recipient_id = (select auth.uid()) and public.is_workspace_member(workspace_id) )
  with check ( recipient_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

create policy "Recipients can delete their notifications" on public.notifications
  for delete to authenticated
  using ( recipient_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

-- 7. Lock the tenancy key on tasks/comments/messages (0 nulls confirmed).
--    notifications.workspace_id stays NULLABLE (deferred to Phase 3). -------------------
alter table public.tasks    alter column workspace_id set not null;
alter table public.comments alter column workspace_id set not null;
alter table public.messages alter column workspace_id set not null;
