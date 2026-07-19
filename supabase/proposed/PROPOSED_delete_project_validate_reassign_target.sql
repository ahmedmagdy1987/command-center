-- ============================================================================================
-- PROPOSED — _delete_project must VALIDATE that the reassign target exists
-- STATUS: NOT APPLIED. Awaits owner approval + the rolled-back proof run.
--         See PROPOSED_delete_project_validate_reassign_target_rolled_back_proof.sql.
-- When approved: apply via apply_migration, then move this file to
--         supabase/migrations/<version-from-list_migrations>_delete_project_validate_reassign_target.sql
--         and the proof to supabase/tests/.
--
-- THE BUG (data-integrity, reachable today, zero damage so far).
--   `private._delete_project` (20260716104604) validates three things about an 'unassign' delete:
--     * p_reassign_to is non-null and non-blank          -> 22023
--     * p_reassign_to <> p_project_id                    -> 22023
--     * the project BEING DELETED exists in the workspace -> P0002
--   It never validates that p_reassign_to ITSELF resolves to a real project. It then runs
--   `update public.tasks set project = p_reassign_to`, and `tasks.project` is FREE TEXT with NO
--   foreign key (CLAUDE.md, Bundle 3) — so an unresolvable value is accepted silently and the tasks
--   become unfiled. The UI degrades gracefully (the chip just disappears), which is precisely why
--   this would never be noticed.
--
--   The client makes it near-certain rather than hypothetical: VisualTaskCommandCenter.jsx:3220
--   hardcodes `const reassignTo = project.id === 'other' ? 'personal' : 'other';` — the seed ids.
--   LIVE CHECK 2026-07-19: NONE of the three workspaces (Command Center, ahmed, amego) has a project
--   with id 'other'; two of the three also lack 'personal'. So "Keep the tasks" would strand them on
--   essentially every project in the product today.
--
--   Also live-checked before writing this: **0 tasks are currently orphaned** (24 tasks, 0 with a
--   project id that does not resolve in their workspace). There is no cleanup to do — this is purely
--   preventive, which makes it the cheapest possible moment to fix.
--
-- THE FIX — two halves, and BOTH are required:
--   (1) DB (this file): reject an unresolvable reassign target. The DB is the only place that can
--       make this an invariant rather than a convention; the RPC is reachable by any owner/admin
--       directly, not only through our UI.
--   (2) CLIENT (companion, same piece of work): stop hardcoding a seed id. The delete modal must
--       offer the workspace's REAL projects as the destination, and must not offer "keep the tasks"
--       at all when there is no other project to move them to.
--
-- WHY P0002 AND NOT A NEW SQLSTATE: it matches the sibling 'project not found' raise three lines up,
--   and both describe the same class of failure (a project id that does not resolve in this
--   workspace). The MESSAGES differ so the client can tell them apart; the codes deliberately do not,
--   because a caller who can reach this RPC is already a proven member of the workspace and can
--   enumerate its projects anyway — there is no oracle to protect here.
--
-- ORDERING NOTE: the new check is placed AFTER the "project being deleted exists" check. That order
--   is deliberate — a caller who passes two bad ids learns about the one they asked to DELETE first,
--   which is the more useful error, and it keeps the existing error precedence unchanged for every
--   input that was already valid.
--
-- SIGNATURE CHANGE (small, deliberate): `public.delete_project`'s default for p_reassign_to changes
--   from 'other' to NULL. A default that names a seed id which may not exist is the same footgun at
--   the API layer; with NULL, an omitted target fails as "reassign target required" (22023) instead
--   of "does not exist" (P0002), which is the truthful error. Every existing caller passes all four
--   arguments explicitly (api.js deleteViaRpc), so no live call path changes behaviour.
--
-- BEHAVIOUR-PRESERVING for every currently-valid call: a reassign target that resolves is untouched;
--   cascade mode is untouched; all rank gates, the can_see_task GATE A, and the cross-tenant
--   workspace scoping are reproduced verbatim from 20260716104604.
-- ============================================================================================

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
    -- THE FIX. Without this, tasks.project (free text, no FK) accepts an unresolvable id and the
    -- tasks are silently unfiled. Scoped by workspace_id so a project id from ANOTHER tenant is
    -- rejected too — project ids are free-text slugs like 'personal', so a bare id check would let a
    -- caller move their tasks onto a slug that only exists in someone else's workspace.
    if not exists (select 1 from public.projects where id = p_reassign_to and workspace_id = p_workspace_id) then
      raise exception 'reassign target project does not exist in this workspace' using errcode = 'P0002';
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

-- Default changes 'other' -> NULL (see SIGNATURE CHANGE in the header). Body is otherwise identical.
create or replace function public.delete_project(
  p_project_id text, p_workspace_id uuid, p_mode text default 'unassign', p_reassign_to text default null
) returns jsonb
language sql set search_path to '' as $fn$
  select private._delete_project(p_project_id, p_workspace_id, p_mode, p_reassign_to);
$fn$;
revoke all on function public.delete_project(text, uuid, text, text) from public, anon;
grant execute on function public.delete_project(text, uuid, text, text) to authenticated;
