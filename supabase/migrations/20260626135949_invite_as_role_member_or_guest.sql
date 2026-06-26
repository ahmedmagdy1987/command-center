-- Invite-as-role: let an owner/admin choose member|guest at invite time (was hardcoded 'member').
-- Widens invitations_role_check to the four roles and adds p_role to create_invitation, validated to
-- member|guest (owner/admin are still assigned ONLY via set_member_role after the invitee joins; the
-- caller must be rank >= 2 / owner|admin). accept_invitation already applies inv.role, so no accept-side
-- change. Proven by a 6/6 rolled-back boundary proof.

alter table public.invitations drop constraint if exists invitations_role_check;
alter table public.invitations add constraint invitations_role_check
  check (role in ('owner','admin','member','guest'));

-- create_invitation gains p_role (default 'member' -> backward compatible with existing 2-arg callers).
-- The signature changes (2 -> 3 args), so drop the old overloads first (public depends on private).
drop function if exists public.create_invitation(uuid, text);
drop function if exists private._create_invitation(uuid, text);

create or replace function private._create_invitation(p_workspace_id uuid, p_email text, p_role text default 'member')
returns public.invitations language plpgsql security definer set search_path to '' as $fn$
declare v_email text; inv public.invitations;
begin
  if private.workspace_role_rank(p_workspace_id) < 2 then raise exception 'only an owner or admin can invite' using errcode='42501'; end if;
  if p_role is null or p_role not in ('member','guest') then raise exception 'you can only invite as member or guest' using errcode='42501'; end if;
  v_email := lower(trim(p_email));
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'a valid email is required'; end if;
  if exists (select 1 from public.workspace_members wm join auth.users u on u.id=wm.user_id
             where wm.workspace_id=p_workspace_id and lower(u.email)=v_email) then
    raise exception 'that person is already a member of this workspace'; end if;
  update public.invitations set role=p_role, token=gen_random_uuid(), expires_at=now()+interval '14 days', invited_by=(select auth.uid()), created_at=now()
   where workspace_id=p_workspace_id and lower(email)=v_email and status='pending' returning * into inv;
  if inv.id is null then
    insert into public.invitations (workspace_id,email,role,invited_by) values (p_workspace_id,v_email,p_role,(select auth.uid())) returning * into inv;
  end if;
  return inv;
end; $fn$;
revoke all on function private._create_invitation(uuid, text, text) from public, anon;
grant execute on function private._create_invitation(uuid, text, text) to authenticated;

create or replace function public.create_invitation(p_workspace_id uuid, p_email text, p_role text default 'member')
returns public.invitations language sql security invoker set search_path to '' as $pw$
  select private._create_invitation(p_workspace_id, p_email, p_role);
$pw$;
revoke all on function public.create_invitation(uuid, text, text) from public, anon;
grant execute on function public.create_invitation(uuid, text, text) to authenticated;
