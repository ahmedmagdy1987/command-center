-- Phase 3A: extend tenant isolation to projects + members (the two tables Phase 2 didn't
-- cover). DB-only; no app code change; identical behavior for the current single-workspace
-- team. Reuses workspaces, workspace_members, set_workspace_id trigger, private.is_workspace_member.
-- Does NOT touch tasks/comments/messages/notifications policies or any existing trigger.

-- ===== PROJECTS (belongs to a workspace, same model as tasks) =====================
alter table public.projects add column if not exists workspace_id uuid references public.workspaces (id);
create index if not exists projects_workspace_id_idx on public.projects (workspace_id);

update public.projects set workspace_id = '11111111-1111-1111-1111-111111111111' where workspace_id is null;
alter table public.projects alter column workspace_id set not null;   -- backfill covers all 9 rows

-- reuse the Phase-1 auto-stamp trigger function (do not redefine it)
drop trigger if exists set_workspace_id on public.projects;
create trigger set_workspace_id before insert on public.projects
  for each row execute function public.set_workspace_id_from_membership();

-- ===== MEMBERS co-worker helper (private schema; SECURITY DEFINER so it bypasses
--       workspace_members' self-only RLS — otherwise the co-member check collapses to self) =
create or replace function private.shares_workspace(target_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members me
    join public.workspace_members them on them.workspace_id = me.workspace_id
    where me.user_id = auth.uid()
      and them.user_id = target_user
  );
$$;
revoke execute on function private.shares_workspace(uuid) from public;
revoke execute on function private.shares_workspace(uuid) from anon;
grant  execute on function private.shares_workspace(uuid) to authenticated;

-- ===== MEMBERS role-lock (closes the self-promotion-to-owner hole). Plain trigger (no
--       SECURITY DEFINER needed — only compares OLD/NEW). Hardened: search_path='', EXECUTE
--       revoked. Blocks ANY role change via UPDATE; owner-managed role changes are Phase 3B. =
create or replace function public.members_lock_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role is distinct from old.role then
    raise exception 'members.role cannot be changed here (roles are set at setup; owner-managed role changes come in a later phase)';
  end if;
  return new;
end;
$$;
revoke execute on function public.members_lock_role() from public;
revoke execute on function public.members_lock_role() from anon;
revoke execute on function public.members_lock_role() from authenticated;

drop trigger if exists members_lock_role on public.members;
create trigger members_lock_role before update on public.members
  for each row execute function public.members_lock_role();

-- ===== Drop ALL existing policies on projects + members by real name, then recreate =====
do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
    where schemaname='public' and tablename in ('projects','members')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ----- PROJECTS policies (workspace-membership gated; owner-only delete preserved) -----
create policy projects_select_member on public.projects
  for select to authenticated
  using ( private.is_workspace_member(workspace_id) );

create policy projects_insert_member on public.projects
  for insert to authenticated
  with check ( private.is_workspace_member(workspace_id) );

create policy projects_update_member on public.projects
  for update to authenticated
  using  ( private.is_workspace_member(workspace_id) )
  with check ( private.is_workspace_member(workspace_id) );

create policy projects_delete_owner on public.projects
  for delete to authenticated
  using (
    private.is_workspace_member(workspace_id)
    and exists (select 1 from public.members m where m.id = (select auth.uid()) and m.role = 'owner')
  );

-- ----- MEMBERS policies (self + co-workspace visibility; self-only writes; role-locked) -----
create policy members_select_self_or_shared on public.members
  for select to authenticated
  using ( id = (select auth.uid()) or private.shares_workspace(id) );

create policy members_insert_self on public.members
  for insert to authenticated
  with check ( id = (select auth.uid()) );

create policy members_update_self on public.members
  for update to authenticated
  using  ( id = (select auth.uid()) )
  with check ( id = (select auth.uid()) );
