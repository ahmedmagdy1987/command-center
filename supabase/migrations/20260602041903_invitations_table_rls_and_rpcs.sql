-- Invitations phase, Step 1: invitations table + RLS + the 4 sanctioned RPCs (Option-B:
-- private SECURITY DEFINER impls + public SECURITY INVOKER passthroughs). Writes to invitations
-- and workspace_members happen ONLY through these RPCs (the table has no INSERT/UPDATE/DELETE
-- policy or grant), mirroring the create_workspace sanctioned-write-path discipline.
--
-- Mechanism (approved): email-bound invite + token link, owner-only / member-only, copy-link delivery.
--   create_invitation  : owner-gated; forces role 'member'; upserts the single pending invite.
--   accept_invitation  : email-bound (lower(invite.email)=lower(caller's auth email)); inserts the
--                        workspace_members row with user_id = auth.uid() (NEVER a param).
--   invitation_preview : authenticated-only minimal preview (workspace name + invited email + status
--                        + expiry) so the post-login /invite/:token screen can validate the token and
--                        show context for a not-yet-member (workspaces RLS would otherwise hide it).
--   revoke_invitation  : owner-gated; sets status='revoked'.
--
-- Verified (rolled-back proof set): owner creates / non-owner can't; accept with matching email
-- inserts the membership; wrong-email + expired + revoked all rejected; preview minimal; invitee sees
-- only their own pending invite, owner sees the workspace's, a non-owner/non-invitee sees none; direct
-- INSERT/UPDATE/DELETE on the table denied. Advisors clean; per-user baseline unchanged.

create table if not exists public.invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        text not null,
  role         text not null default 'member' check (role in ('member','owner')),
  token        uuid not null default gen_random_uuid() unique,
  status       text not null default 'pending' check (status in ('pending','accepted','revoked')),
  invited_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '14 days'),
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users(id)
);

create unique index if not exists invitations_one_pending
  on public.invitations (workspace_id, lower(email)) where status = 'pending';
create index if not exists invitations_email_idx     on public.invitations (lower(email));
create index if not exists invitations_workspace_idx on public.invitations (workspace_id);

alter table public.invitations enable row level security;

-- SELECT: an owner manages their workspace's invites; an invitee sees their own pending invite.
drop policy if exists invitations_select_owner on public.invitations;
create policy invitations_select_owner on public.invitations
  for select to authenticated
  using (private.is_workspace_owner(workspace_id));

drop policy if exists invitations_select_invitee on public.invitations;
create policy invitations_select_invitee on public.invitations
  for select to authenticated
  using (status = 'pending' and lower(email) = lower((select auth.email())));

-- No INSERT/UPDATE/DELETE policy: all writes go through the RPCs below.
grant select on public.invitations to authenticated;

-- ---- RPCs (private DEFINER impl + public INVOKER wrapper) -------------------------------------

create or replace function private._create_invitation(p_workspace_id uuid, p_email text)
returns public.invitations language plpgsql security definer set search_path = '' as $$
declare v_email text; inv public.invitations;
begin
  if not private.is_workspace_owner(p_workspace_id) then
    raise exception 'only an owner can invite' using errcode = '42501';
  end if;
  v_email := lower(trim(p_email));
  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'a valid email is required';
  end if;
  if exists (
    select 1 from public.workspace_members wm join auth.users u on u.id = wm.user_id
    where wm.workspace_id = p_workspace_id and lower(u.email) = v_email
  ) then
    raise exception 'that person is already a member of this workspace';
  end if;
  update public.invitations
     set token = gen_random_uuid(), expires_at = now() + interval '14 days',
         invited_by = (select auth.uid()), created_at = now()
   where workspace_id = p_workspace_id and lower(email) = v_email and status = 'pending'
   returning * into inv;
  if inv.id is null then
    insert into public.invitations (workspace_id, email, role, invited_by)
    values (p_workspace_id, v_email, 'member', (select auth.uid()))
    returning * into inv;
  end if;
  return inv;
end; $$;

create or replace function private._accept_invitation(p_token uuid)
returns public.workspaces language plpgsql security definer set search_path = '' as $$
declare inv public.invitations; v_email text; ws public.workspaces;
begin
  select email into v_email from auth.users where id = (select auth.uid());
  if v_email is null then raise exception 'not authenticated' using errcode = '42501'; end if;

  select * into inv from public.invitations where token = p_token for update;
  if inv.id is null then raise exception 'invitation not found' using errcode = 'P0002'; end if;
  if inv.status = 'revoked' then raise exception 'this invitation was revoked'; end if;
  if inv.status = 'accepted' then
    select * into ws from public.workspaces where id = inv.workspace_id; return ws;   -- idempotent
  end if;
  if inv.expires_at <= now() then raise exception 'this invitation has expired'; end if;
  if lower(inv.email) <> lower(v_email) then raise exception 'this invitation is for a different email'; end if;

  if not exists (select 1 from public.workspace_members where workspace_id = inv.workspace_id and user_id = (select auth.uid())) then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (inv.workspace_id, (select auth.uid()), inv.role);
  end if;
  update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = (select auth.uid()) where id = inv.id;
  select * into ws from public.workspaces where id = inv.workspace_id;
  return ws;
end; $$;

create or replace function private._invitation_preview(p_token uuid)
returns table (workspace_name text, email text, status text, is_expired boolean)
language sql security definer set search_path = '' as $$
  select w.name, i.email, i.status, (i.expires_at <= now())
  from public.invitations i join public.workspaces w on w.id = i.workspace_id
  where i.token = p_token;
$$;

create or replace function private._revoke_invitation(p_id uuid)
returns public.invitations language plpgsql security definer set search_path = '' as $$
declare inv public.invitations;
begin
  select * into inv from public.invitations where id = p_id;
  if inv.id is null then raise exception 'invitation not found' using errcode = 'P0002'; end if;
  if not private.is_workspace_owner(inv.workspace_id) then
    raise exception 'only an owner can revoke' using errcode = '42501';
  end if;
  update public.invitations set status = 'revoked' where id = p_id returning * into inv;
  return inv;
end; $$;

-- public invoker passthroughs
create or replace function public.create_invitation(p_workspace_id uuid, p_email text)
returns public.invitations language sql security invoker set search_path = '' as $$
  select private._create_invitation(p_workspace_id, p_email);
$$;
create or replace function public.accept_invitation(p_token uuid)
returns public.workspaces language sql security invoker set search_path = '' as $$
  select private._accept_invitation(p_token);
$$;
create or replace function public.invitation_preview(p_token uuid)
returns table (workspace_name text, email text, status text, is_expired boolean)
language sql security invoker set search_path = '' as $$
  select * from private._invitation_preview(p_token);
$$;
create or replace function public.revoke_invitation(p_id uuid)
returns public.invitations language sql security invoker set search_path = '' as $$
  select private._revoke_invitation(p_id);
$$;

-- ---- grants (least-privilege; all functions authenticated-only) ------------------------------
revoke all on function private._create_invitation(uuid, text) from public;
grant execute on function private._create_invitation(uuid, text) to authenticated;
revoke all on function private._accept_invitation(uuid) from public;
grant execute on function private._accept_invitation(uuid) to authenticated;
revoke all on function private._invitation_preview(uuid) from public;
grant execute on function private._invitation_preview(uuid) to authenticated;
revoke all on function private._revoke_invitation(uuid) from public;
grant execute on function private._revoke_invitation(uuid) to authenticated;

revoke all on function public.create_invitation(uuid, text) from public;
grant execute on function public.create_invitation(uuid, text) to authenticated;
revoke all on function public.accept_invitation(uuid) from public;
grant execute on function public.accept_invitation(uuid) to authenticated;
revoke all on function public.invitation_preview(uuid) from public;
grant execute on function public.invitation_preview(uuid) to authenticated;
revoke all on function public.revoke_invitation(uuid) from public;
grant execute on function public.revoke_invitation(uuid) to authenticated;
