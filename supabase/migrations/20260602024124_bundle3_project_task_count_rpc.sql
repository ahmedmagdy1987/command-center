-- Bundle 3: reliable project task-count RPC (advisor-clean Option B:
-- private SECURITY DEFINER impl + public SECURITY INVOKER passthrough).
--
-- Lets an owner get the TRUE count of a project's tasks (bypassing the caller's RLS
-- blind spots, incl. other members' private tasks) so the app can BLOCK deletion of a
-- project that still holds tasks instead of silently stranding them. tasks.project is a
-- free-text id (no FK to projects), so deletion is otherwise unguarded; this is the gate.
--
-- The DEFINER body lives in the `private` (non-API) schema so it doesn't trip the
-- authenticated_security_definer_function_executable advisor; the public wrapper is
-- INVOKER so it doesn't either. Both pin search_path=''. Verified by a rolled-back proof:
-- owner gets the true count incl. a member's hidden private task; a non-owner caller is
-- rejected; member can INSERT a project but a non-owner can't DELETE while an owner can.

create or replace function private._project_task_count(p_project_id text, p_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
  declare v integer;
  begin
    -- owner-only: members must not be able to probe private-task counts; the delete UI is owner-gated.
    if not private.is_workspace_owner(p_workspace_id) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    select count(*) into v
      from public.tasks
     where project = p_project_id
       and workspace_id = p_workspace_id;
    return v;
  end;
$$;

revoke all on function private._project_task_count(text, uuid) from public;
grant execute on function private._project_task_count(text, uuid) to authenticated;

create or replace function public.project_task_count(p_project_id text, p_workspace_id uuid)
returns integer
language sql
security invoker
set search_path = ''
as $$
  select private._project_task_count(p_project_id, p_workspace_id);
$$;

revoke all on function public.project_task_count(text, uuid) from public;
grant execute on function public.project_task_count(text, uuid) to authenticated;
