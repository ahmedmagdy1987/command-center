-- ============================================================================================
-- _delete_project must VALIDATE that the reassign target exists
--
-- THE BUG (data-integrity, reachable today; 0 tasks damaged so far — checked live before applying).
--   `private._delete_project` (20260716104604) validated three things about an 'unassign' delete:
--   the target is non-blank (22023), the target differs from the deleted project (22023), and the
--   project BEING DELETED exists (P0002). It never validated that p_reassign_to ITSELF resolves.
--   It then ran `update public.tasks set project = p_reassign_to`, and `tasks.project` is FREE TEXT
--   with NO foreign key (CLAUDE.md, Bundle 3) — so an unresolvable value was accepted silently and
--   the tasks became unfiled. The UI degrades gracefully (the chip just disappears), which is
--   exactly why this would never have been noticed.
--
--   The client made it near-certain: VisualTaskCommandCenter.jsx hardcoded
--   `project.id === 'other' ? 'personal' : 'other'` — the seed ids. Live check 2026-07-19: NONE of
--   the three workspaces has a project with id 'other'; two of three also lack 'personal'. So
--   "Keep the tasks" would have stranded them on essentially every project in the product.
--
--   Live at apply time: 24 tasks, **0 orphaned**. Purely preventive.
--
-- SHIPPED WITH ITS CLIENT HALF, deliberately and necessarily. On its own this migration converts a
--   silent stranding into a loud P0002 on nearly every project, because the client would still be
--   sending 'other'. The same change replaces that hardcoded id with a real destination PICKER over
--   the workspace's actual projects (and disables "keep the tasks" when there is nowhere to move
--   them), plus a shared `defaultProjectId()` helper that fixes the same latent seed-id assumption in
--   QuickAdd, ColumnQuickAdd and addTask.
--
-- WHY P0002 AND NOT A NEW SQLSTATE: it matches the sibling 'project not found' raise three lines up,
--   and both describe a project id that does not resolve in this workspace. The MESSAGES differ so a
--   client can tell them apart; the codes deliberately do not, because a caller who reaches this RPC
--   is already a proven member and can enumerate the workspace's projects anyway.
--   ⚠ The proof's teeth come from asserting the MESSAGE text as well as the code — a code-only
--   assertion would pass with this fix deleted. Keep that discipline.
--
-- ORDERING: the new check sits AFTER the "project being deleted exists" check, so a caller passing
--   two bad ids hears about the one they asked to DELETE first, and error precedence is unchanged
--   for every input that was already valid.
--
-- SIGNATURE CHANGE: `public.delete_project`'s default for p_reassign_to goes 'other' -> NULL. A
--   default naming a seed id that may not exist is the same footgun at the API layer; with NULL an
--   omitted target fails as "reassign target required" (22023) rather than "does not exist" (P0002),
--   which is the truthful error. Every existing caller passes all four arguments explicitly.
--
-- PROVEN: 39/39 rolled back, with a RED phase that reproduced the silent stranding against the live
--   body (including a cross-workspace target being accepted) before the fix.
--   See supabase/tests/delete_project_validate_reassign_target_rolled_back_proof.sql.
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
    -- caller move their tasks onto a slug that only exists in someone else's workspace. (The RED
    -- phase proved that exact cross-workspace acceptance was live.)
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

-- Default changes 'other' -> NULL (see SIGNATURE CHANGE). Body otherwise identical.
create or replace function public.delete_project(
  p_project_id text, p_workspace_id uuid, p_mode text default 'unassign', p_reassign_to text default null
) returns jsonb
language sql set search_path to '' as $fn$
  select private._delete_project(p_project_id, p_workspace_id, p_mode, p_reassign_to);
$fn$;
revoke all on function public.delete_project(text, uuid, text, text) from public, anon;
grant execute on function public.delete_project(text, uuid, text, text) to authenticated;
