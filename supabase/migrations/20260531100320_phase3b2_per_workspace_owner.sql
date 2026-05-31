-- Phase 3B-2: make "owner" PER-WORKSPACE. Authorization stops reading the global
-- members.role and reads workspace_members.role for the row's workspace instead.
-- Behavior-preserving for the current team (Tony + Ahmed Magdy are owners, VA a member
-- in workspace_members of the one workspace). members.role + members_lock_role untouched.

-- 1) Per-workspace owner helper. Same convention as private.is_workspace_member:
--    SECURITY DEFINER (bypasses workspace_members' self-only RLS), STABLE, search_path='',
--    in the private (non-API) schema, EXECUTE to authenticated only.
create or replace function private.is_workspace_owner(ws_id uuid)
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
      and wm.role = 'owner'
  );
$$;

revoke execute on function private.is_workspace_owner(uuid) from public;
revoke execute on function private.is_workspace_owner(uuid) from anon;
grant  execute on function private.is_workspace_owner(uuid) to authenticated;

-- 2) Re-point the one owner-gated policy. The per-workspace owner check already implies
--    membership of that workspace, so is_workspace_owner alone is sufficient.
--    Surgical: drop ONLY projects_delete_owner by its real name; leave the other 3 projects
--    policies (select/insert/update _member) untouched.
drop policy if exists projects_delete_owner on public.projects;
create policy projects_delete_owner on public.projects
  for delete to authenticated
  using ( private.is_workspace_owner(workspace_id) );
