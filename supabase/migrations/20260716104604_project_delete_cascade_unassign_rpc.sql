-- Project deletion via a sanctioned RPC: cascade (delete tasks + project) = OWNER-only (rank 3);
-- unassign (re-file tasks, delete project) = OWNER+ADMIN (rank 2). Both scoped by workspace_id
-- (cross-tenant guard for shared free-text project slugs like 'personal'/'other') AND private.can_see_task
-- (GATE A: only caller-visible tasks; invisible private tasks untouched at every rank). Requires the
-- project row to exist (blocks the free-text-slug footgun; guarantees project_deleted matches the op).
-- The existing projects_delete_admin policy (direct row delete, rank>=2) is UNCHANGED and remains the
-- low-level capability; the app routes deletes through this RPC. Advisor-clean (public INVOKER wrapper +
-- private DEFINER impl, both search_path=''). Proven: project_delete_cascade_rolled_back_proof.sql (29/29,
-- incl. the M8 "strip workspace_id -> RED" cross-tenant discriminator).
create or replace function private._delete_project(
  p_project_id text, p_workspace_id uuid, p_mode text, p_reassign_to text
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare
  v_rank int;
  v_affected int := 0;
  v_proj int := 0;
  v_mode text := lower(coalesce(p_mode, ''));
begin
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_rank := private.workspace_role_rank(p_workspace_id);

  if v_mode = 'cascade' then
    if v_rank < 3 then
      raise exception 'only an owner can delete a project and its tasks' using errcode = '42501';
    end if;
    if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    delete from public.tasks
      where project = p_project_id and workspace_id = p_workspace_id and private.can_see_task(auth.uid(), id);
    get diagnostics v_affected = row_count;
  elsif v_mode = 'unassign' then
    if v_rank < 2 then
      raise exception 'only an owner or admin can delete a project' using errcode = '42501';
    end if;
    if p_reassign_to is null or length(btrim(p_reassign_to)) = 0 then
      raise exception 'reassign target required' using errcode = '22023';
    end if;
    if p_reassign_to = p_project_id then
      raise exception 'reassign target must differ from the deleted project' using errcode = '22023';
    end if;
    if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    update public.tasks
      set project = p_reassign_to
      where project = p_project_id and workspace_id = p_workspace_id and private.can_see_task(auth.uid(), id);
    get diagnostics v_affected = row_count;
  else
    raise exception 'invalid mode: %', p_mode using errcode = '22023';
  end if;

  delete from public.projects where id = p_project_id and workspace_id = p_workspace_id;
  get diagnostics v_proj = row_count;

  return jsonb_build_object('mode', v_mode, 'tasks_affected', v_affected, 'project_deleted', v_proj > 0);
end;
$fn$;
revoke all on function private._delete_project(text, uuid, text, text) from public, anon;
grant execute on function private._delete_project(text, uuid, text, text) to authenticated;

create or replace function public.delete_project(
  p_project_id text, p_workspace_id uuid, p_mode text default 'unassign', p_reassign_to text default 'other'
) returns jsonb
language sql set search_path to '' as $fn$
  select private._delete_project(p_project_id, p_workspace_id, p_mode, p_reassign_to);
$fn$;
revoke all on function public.delete_project(text, uuid, text, text) from public, anon;
grant execute on function public.delete_project(text, uuid, text, text) to authenticated;
