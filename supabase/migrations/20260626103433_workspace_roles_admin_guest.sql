-- Workspace roles & permissions: owner > admin > member > guest.
-- Guest = own/assigned tasks only, no projects/roster, DMs-only (no team chat). Project-delete +
-- invite = owner+admin. Member edit/delete = own/assigned only (admin+ = any). Role changes via
-- owner+admin RPCs with last-owner / no-self-escalation / no-act-above-rank guards.
-- Proven rolled-back: 35/35 role boundaries + isolation re-audit (45/45 holds, members no-regression).

alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add  constraint workspace_members_role_check
  check (role = any (array['owner','admin','member','guest']));

create or replace function private._role_rank(p_role text)
returns int language sql immutable as $$
  select case p_role when 'owner' then 3 when 'admin' then 2 when 'member' then 1 when 'guest' then 0 else -1 end;
$$;
create or replace function private.workspace_role(ws_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select role from public.workspace_members where workspace_id = ws_id and user_id = auth.uid();
$$;
create or replace function private.workspace_role_rank(ws_id uuid)
returns int language sql stable security definer set search_path = '' as $$
  select private._role_rank(private.workspace_role(ws_id));
$$;
revoke all on function private._role_rank(text)          from public, anon;
revoke all on function private.workspace_role(uuid)      from public, anon;
revoke all on function private.workspace_role_rank(uuid) from public, anon;
grant execute on function private._role_rank(text)          to authenticated;
grant execute on function private.workspace_role(uuid)      to authenticated;
grant execute on function private.workspace_role_rank(uuid) to authenticated;

drop policy if exists tasks_select_workspace_or_own_private on public.tasks;
drop policy if exists tasks_insert_member                   on public.tasks;
drop policy if exists tasks_update_workspace_or_own_private on public.tasks;
drop policy if exists tasks_delete_workspace_or_own_private on public.tasks;
drop policy if exists tasks_select_role on public.tasks;
drop policy if exists tasks_insert_role on public.tasks;
drop policy if exists tasks_update_role on public.tasks;
drop policy if exists tasks_delete_role on public.tasks;
create policy tasks_select_role on public.tasks for select to authenticated
using (private.is_workspace_member(workspace_id)
  and (privacy='workspace' or (privacy='private' and ((select auth.uid())=created_by or (select auth.uid())=assignee_id)))
  and (private.workspace_role(workspace_id) <> 'guest' or (select auth.uid())=created_by or (select auth.uid())=assignee_id));
create policy tasks_insert_role on public.tasks for insert to authenticated
with check (private.is_workspace_member(workspace_id)
  and (privacy='workspace' or (privacy='private' and ((select auth.uid())=created_by or (select auth.uid())=assignee_id)))
  and (private.workspace_role(workspace_id) <> 'guest' or (select auth.uid())=assignee_id));
create policy tasks_update_role on public.tasks for update to authenticated
using (private.is_workspace_member(workspace_id)
  and (privacy='workspace' or (privacy='private' and ((select auth.uid())=created_by or (select auth.uid())=assignee_id)))
  and (private.workspace_role_rank(workspace_id) >= 2 or (select auth.uid())=created_by or (select auth.uid())=assignee_id))
with check (private.is_workspace_member(workspace_id)
  and (privacy='workspace' or (privacy='private' and ((select auth.uid())=created_by or (select auth.uid())=assignee_id)))
  and (private.workspace_role_rank(workspace_id) >= 2 or (select auth.uid())=created_by or (select auth.uid())=assignee_id));
create policy tasks_delete_role on public.tasks for delete to authenticated
using (private.is_workspace_member(workspace_id)
  and (privacy='workspace' or (privacy='private' and ((select auth.uid())=created_by or (select auth.uid())=assignee_id)))
  and (private.workspace_role_rank(workspace_id) >= 2 or (select auth.uid())=created_by or (select auth.uid())=assignee_id));

drop policy if exists projects_select_member on public.projects;
drop policy if exists projects_insert_member on public.projects;
drop policy if exists projects_update_member on public.projects;
drop policy if exists projects_delete_owner  on public.projects;
drop policy if exists projects_delete_admin  on public.projects;
create policy projects_select_member on public.projects for select to authenticated
using (private.is_workspace_member(workspace_id) and private.workspace_role(workspace_id) <> 'guest');
create policy projects_insert_member on public.projects for insert to authenticated
with check (private.is_workspace_member(workspace_id) and private.workspace_role_rank(workspace_id) >= 1);
create policy projects_update_member on public.projects for update to authenticated
using (private.is_workspace_member(workspace_id) and private.workspace_role_rank(workspace_id) >= 1)
with check (private.is_workspace_member(workspace_id) and private.workspace_role_rank(workspace_id) >= 1);
create policy projects_delete_admin on public.projects for delete to authenticated
using (private.workspace_role_rank(workspace_id) >= 2);

drop policy if exists messages_select_member on public.messages;
drop policy if exists messages_insert_member on public.messages;
create policy messages_select_member on public.messages for select to authenticated
using (private.is_workspace_member(workspace_id) and private.workspace_role(workspace_id) <> 'guest');
create policy messages_insert_member on public.messages for insert to authenticated
with check ((select auth.uid())=sender_id and private.is_workspace_member(workspace_id) and private.workspace_role(workspace_id) <> 'guest');

drop policy if exists invitations_select_owner on public.invitations;
create policy invitations_select_owner on public.invitations for select to authenticated
using (private.workspace_role_rank(workspace_id) >= 2);

-- RPC gate updates: owner -> owner+admin (rank >= 2)
create or replace function private._create_invitation(p_workspace_id uuid, p_email text)
returns invitations language plpgsql security definer set search_path = '' as $$
declare v_email text; inv public.invitations;
begin
  if private.workspace_role_rank(p_workspace_id) < 2 then raise exception 'only an owner or admin can invite' using errcode='42501'; end if;
  v_email := lower(trim(p_email));
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'a valid email is required'; end if;
  if exists (select 1 from public.workspace_members wm join auth.users u on u.id=wm.user_id
             where wm.workspace_id=p_workspace_id and lower(u.email)=v_email) then
    raise exception 'that person is already a member of this workspace'; end if;
  update public.invitations set token=gen_random_uuid(), expires_at=now()+interval '14 days', invited_by=(select auth.uid()), created_at=now()
   where workspace_id=p_workspace_id and lower(email)=v_email and status='pending' returning * into inv;
  if inv.id is null then
    insert into public.invitations (workspace_id,email,role,invited_by) values (p_workspace_id,v_email,'member',(select auth.uid())) returning * into inv;
  end if;
  return inv;
end; $$;
create or replace function private._revoke_invitation(p_id uuid)
returns invitations language plpgsql security definer set search_path = '' as $$
declare inv public.invitations;
begin
  select * into inv from public.invitations where id=p_id;
  if inv.id is null then raise exception 'invitation not found' using errcode='P0002'; end if;
  if private.workspace_role_rank(inv.workspace_id) < 2 then raise exception 'only an owner or admin can revoke' using errcode='42501'; end if;
  update public.invitations set status='revoked' where id=p_id returning * into inv;
  return inv;
end; $$;
create or replace function private._project_task_count(p_project_id text, p_workspace_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
  declare v integer;
  begin
    if private.workspace_role_rank(p_workspace_id) < 2 then raise exception 'not authorized' using errcode='42501'; end if;
    select count(*) into v from public.tasks where project=p_project_id and workspace_id=p_workspace_id;
    return v;
  end;
$$;

-- Role-management RPCs (the ONLY write path to workspace_members.role). Private DEFINER impl +
-- public INVOKER passthrough (advisor-clean). All guardrails server-side.
create or replace function private._set_member_role(p_ws uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_caller_rank int := private.workspace_role_rank(p_ws); v_new_rank int := private._role_rank(p_role);
        v_target_role text; v_target_rank int; v_owner_count int;
begin
  if v_caller_rank < 2 then raise exception 'only an owner or admin can change roles' using errcode='42501'; end if;
  if v_new_rank < 0 then raise exception 'invalid role: %', p_role using errcode='22023'; end if;
  select role into v_target_role from public.workspace_members where workspace_id=p_ws and user_id=p_user;
  if v_target_role is null then raise exception 'that user is not a member of this workspace' using errcode='P0002'; end if;
  v_target_rank := private._role_rank(v_target_role);
  if v_target_role = p_role then return; end if;
  if v_caller_rank = 2 then
    if v_target_rank >= 2 then raise exception 'admins cannot modify owners or admins' using errcode='42501'; end if;
    if v_new_rank    >= 2 then raise exception 'admins can only set the member or guest role' using errcode='42501'; end if;
  end if;
  if p_user = (select auth.uid()) and v_new_rank > v_caller_rank then raise exception 'you cannot raise your own role' using errcode='42501'; end if;
  if v_new_rank > v_caller_rank then raise exception 'you cannot grant a role above your own' using errcode='42501'; end if;
  if v_target_role = 'owner' and p_role <> 'owner' then
    select count(*) into v_owner_count from public.workspace_members where workspace_id=p_ws and role='owner';
    if v_owner_count <= 1 then raise exception 'cannot demote the last owner of the workspace' using errcode='42501'; end if;
  end if;
  update public.workspace_members set role=p_role where workspace_id=p_ws and user_id=p_user;
end; $$;
create or replace function private._remove_member(p_ws uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_caller_rank int := private.workspace_role_rank(p_ws); v_target_role text; v_target_rank int; v_owner_count int;
begin
  if v_caller_rank < 2 then raise exception 'only an owner or admin can remove members' using errcode='42501'; end if;
  select role into v_target_role from public.workspace_members where workspace_id=p_ws and user_id=p_user;
  if v_target_role is null then raise exception 'that user is not a member of this workspace' using errcode='P0002'; end if;
  v_target_rank := private._role_rank(v_target_role);
  if v_caller_rank = 2 and v_target_rank >= 2 then raise exception 'admins cannot remove owners or admins' using errcode='42501'; end if;
  if v_target_role = 'owner' then
    select count(*) into v_owner_count from public.workspace_members where workspace_id=p_ws and role='owner';
    if v_owner_count <= 1 then raise exception 'cannot remove the last owner of the workspace' using errcode='42501'; end if;
  end if;
  delete from public.workspace_members where workspace_id=p_ws and user_id=p_user;
end; $$;
create or replace function public.set_member_role(p_ws uuid, p_user uuid, p_role text)
returns void language sql security invoker set search_path = '' as $$ select private._set_member_role(p_ws,p_user,p_role); $$;
create or replace function public.remove_member(p_ws uuid, p_user uuid)
returns void language sql security invoker set search_path = '' as $$ select private._remove_member(p_ws,p_user); $$;
revoke all on function private._set_member_role(uuid,uuid,text) from public, anon;
revoke all on function private._remove_member(uuid,uuid)        from public, anon;
revoke all on function public.set_member_role(uuid,uuid,text)   from public, anon;
revoke all on function public.remove_member(uuid,uuid)          from public, anon;
grant execute on function private._set_member_role(uuid,uuid,text) to authenticated;
grant execute on function private._remove_member(uuid,uuid)        to authenticated;
grant execute on function public.set_member_role(uuid,uuid,text)   to authenticated;
grant execute on function public.remove_member(uuid,uuid)          to authenticated;
