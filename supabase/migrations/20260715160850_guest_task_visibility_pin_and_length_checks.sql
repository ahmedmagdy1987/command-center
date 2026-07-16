-- JSON-import hardening, DB half: a guest must not be able to place workspace-visible
-- tasks on the board -- by import OR by hand.
--
-- Found while scoping the bulk-import surface. The client had NO guest gate on Import JSON
-- (TopBar renders for guests; GUEST_VIEWS only gates VIEWS), and tasks_insert_role's guest
-- clause constrained the ASSIGNEE, not the PRIVACY:
--     (workspace_role(workspace_id) <> 'guest' OR auth.uid() = assignee_id)
-- so a guest could bulk-inject unlimited privacy='workspace' self-assigned tasks straight onto
-- the whole workspace's board. Proven live (rolled back): the injected task was visible to owner
-- Tony.
--
-- This hid inside a "35/35 green" role proof because assertion C04 was named
-- 'guest CAN create a SELF-assigned task' while its DATA was a privacy='workspace' row -- the name
-- described the assignee, the row blessed the visibility. C04 is inverted in
-- supabase/tests/workspace_role_boundary_rolled_back_proof.sql as part of this change, and
-- C04b..C04f were added to cover the update paths below.
--
-- Fixing the INSERT alone would have been FALSE ASSURANCE. Proven live: tasks_update_role has no
-- guest clause whatsoever, so a guest could insert a legitimately-private task and then simply
-- UPDATE it to privacy='workspace' -- same result, two steps. Both paths are closed here.
--
-- Why the UPDATE half is a trigger and not a WITH CHECK: a WITH CHECK only ever sees the NEW row,
-- so it cannot express "privacy didn't change". Pinning privacy='private' for guests in WITH CHECK
-- would instead break a guest marking done a workspace task an admin legitimately assigned them
-- (proven as a no-regression assertion, C04e). So the trigger pins the two dimensions a guest must
-- not move -- privacy and assignee -- and leaves every other field editable. Mirrors the house
-- exemplars members_lock_identity / enforce_task_author_immutable.
--
-- Zero-regression: there are 0 live guests, and non-guests are untouched (the trigger short-circuits
-- before the role lookup unless privacy/assignee actually changed). Proven 19/19 rolled-back, 14/14 live.

-- 1. INSERT: a guest may only ever create a PRIVATE, self-assigned task.
drop policy if exists tasks_insert_role on public.tasks;
create policy tasks_insert_role on public.tasks
  for insert to authenticated
  with check (
    private.is_workspace_member(workspace_id)
    and ((select auth.uid()) = created_by)
    and (privacy = 'workspace'
         or (privacy = 'private' and ((select auth.uid()) = created_by or (select auth.uid()) = assignee_id)))
    and (private.workspace_role(workspace_id) <> 'guest'
         or (((select auth.uid()) = assignee_id) and privacy = 'private'))
  );

-- 2. UPDATE: pin privacy + assignee for guests (see the WITH CHECK note above).
create or replace function public.enforce_guest_task_pin()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- short-circuit: only pay for the role lookup when a pinned dimension actually moves
  if (new.privacy is distinct from old.privacy or new.assignee_id is distinct from old.assignee_id)
     and private.workspace_role(new.workspace_id) = 'guest' then
    if new.privacy is distinct from old.privacy then
      raise exception 'guests cannot change task visibility' using errcode = '42501';
    end if;
    raise exception 'guests cannot reassign tasks' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_guest_task_pin() from public, anon, authenticated;

drop trigger if exists enforce_guest_task_pin on public.tasks;
create trigger enforce_guest_task_pin
  before update on public.tasks
  for each row execute function public.enforce_guest_task_pin();

-- 3. Length CHECKs. tasks.id and tasks.project were completely unbounded on both sides -- a 100k-char
--    id AND project were both accepted (proven). Live maxima are 12 / 8 / 12 chars, so 64 is ~5x
--    headroom and 0 existing rows violate it (asserted in the proof). projects.id is capped to match,
--    so a project can never be created with an id that tasks.project could not reference.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_id_len_chk' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_id_len_chk check (length(id) between 1 and 64);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_project_len_chk' and conrelid = 'public.tasks'::regclass) then
    alter table public.tasks add constraint tasks_project_len_chk check (length(project) between 1 and 64);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_id_len_chk' and conrelid = 'public.projects'::regclass) then
    alter table public.projects add constraint projects_id_len_chk check (length(id) between 1 and 64);
  end if;
end $$;
