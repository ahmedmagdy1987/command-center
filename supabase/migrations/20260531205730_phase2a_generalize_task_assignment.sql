-- Phase 2A: generalize task assignment (additive, non-breaking).
-- Introduces assignee_id (a single workspace member, or unassigned) and decouples privacy from the
-- legacy owner model by dropping the tasks_align_privacy trigger. The owner column and the notify_*
-- triggers are intentionally LEFT INTACT (the app still writes owner until 2B; notify_* still fire).
-- The 4 task RLS policies move to the new predicate: private now = creator OR assignee.
-- Safety-proven: per-user visible-task counts are identical before/after (every existing private task
-- is owner='me' -> assignee backfilled to created_by, so the predicate is equivalent for existing rows).

-- 1) Assignee column. FK -> auth.users(id) to match every other user reference in the schema
--    (created_by, workspaces.owner_id, workspace_members.user_id, comments.author_id, messages.sender_id,
--    notifications.*). ON DELETE SET NULL: removing a user unassigns their tasks, never deletes them.
alter table public.tasks
  add column if not exists assignee_id uuid references auth.users(id) on delete set null;

-- Covering index for the FK (also clears the unindexed_foreign_keys advisor for this FK).
create index if not exists tasks_assignee_id_idx on public.tasks(assignee_id);

-- 2) Backfill from the legacy owner model. The `assignee_id is null` guard makes this safe to re-run
--    and harmless if ever reapplied after 2B (never overwrites an explicitly-chosen assignee).
update public.tasks set assignee_id = created_by
  where owner = 'me' and assignee_id is null;                          -- me  -> creator (already private)

update public.tasks t set assignee_id = wm.user_id                     -- va  -> the workspace's sole role='member'
  from public.workspace_members wm
  where t.owner = 'va' and t.assignee_id is null
    and wm.workspace_id = t.workspace_id and wm.role = 'member';
--   owner='shared' -> assignee stays NULL (unassigned). No statement needed.

-- 3) Break the owner<->privacy weld: stop deriving privacy from owner. The client's sanitizeTask still
--    sets privacy, so the current UI keeps working until 2B. (The orphaned function is dropped in 2C.)
drop trigger if exists tasks_align_privacy on public.tasks;

-- 4) New access rule: private = creator OR assignee (the only access meaning assignment gains).
--    Drop all existing task policies by real name, then recreate the four on the new predicate.
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='tasks'
  loop execute format('drop policy if exists %I on public.tasks', p.policyname); end loop;
end $$;

create policy tasks_select_workspace_or_own_private on public.tasks
  for select to authenticated
  using (
    private.is_workspace_member(workspace_id)
    and ( privacy = 'workspace'
          or ( privacy = 'private'
               and ( created_by = (select auth.uid()) or assignee_id = (select auth.uid()) ) ) )
  );

create policy tasks_insert_member on public.tasks
  for insert to authenticated
  with check (
    private.is_workspace_member(workspace_id)
    and ( privacy = 'workspace'
          or ( privacy = 'private'
               and ( created_by = (select auth.uid()) or assignee_id = (select auth.uid()) ) ) )
  );

create policy tasks_update_workspace_or_own_private on public.tasks
  for update to authenticated
  using (
    private.is_workspace_member(workspace_id)
    and ( privacy = 'workspace'
          or ( privacy = 'private'
               and ( created_by = (select auth.uid()) or assignee_id = (select auth.uid()) ) ) )
  )
  with check (
    private.is_workspace_member(workspace_id)
    and ( privacy = 'workspace'
          or ( privacy = 'private'
               and ( created_by = (select auth.uid()) or assignee_id = (select auth.uid()) ) ) )
  );

create policy tasks_delete_workspace_or_own_private on public.tasks
  for delete to authenticated
  using (
    private.is_workspace_member(workspace_id)
    and ( privacy = 'workspace'
          or ( privacy = 'private'
               and ( created_by = (select auth.uid()) or assignee_id = (select auth.uid()) ) ) )
  );

-- 5) Per-workspace member listing for the 2B assignee picker. Advisor-clean (same pattern as
--    create_workspace): SECURITY DEFINER impl in the non-API `private` schema + a thin SECURITY INVOKER
--    public wrapper. Deliberately does NOT touch the self-scoped workspace_members SELECT policy, so
--    workspaceMembers.listMine() / the isOwner derivation are unaffected. Caller must belong to the
--    workspace (guarded by is_workspace_member); never leaks another workspace's members.
create or replace function private._workspace_members_list(p_workspace_id uuid)
returns table (user_id uuid, display_name text, email text, role text)
language sql
security definer
set search_path = ''
as $fn$
  select wm.user_id, m.display_name, m.email, wm.role
  from public.workspace_members wm
  join public.members m on m.id = wm.user_id
  where wm.workspace_id = p_workspace_id
    and private.is_workspace_member(p_workspace_id)
  order by wm.role desc, m.created_at
$fn$;

revoke execute on function private._workspace_members_list(uuid) from public;
revoke execute on function private._workspace_members_list(uuid) from anon;
grant  execute on function private._workspace_members_list(uuid) to authenticated;

create or replace function public.workspace_members_list(p_workspace_id uuid)
returns table (user_id uuid, display_name text, email text, role text)
language sql
security invoker
set search_path = ''
as $fn$
  select * from private._workspace_members_list(p_workspace_id)
$fn$;

revoke execute on function public.workspace_members_list(uuid) from public;
revoke execute on function public.workspace_members_list(uuid) from anon;
grant  execute on function public.workspace_members_list(uuid) to authenticated;
