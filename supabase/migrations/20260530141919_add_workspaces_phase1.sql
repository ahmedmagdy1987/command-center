-- Phase 1 of workspaces (multi-tenancy) — ADDITIVE + BACKFILL ONLY.
-- No existing RLS policy changed; no app/members.role change. One workspace for the
-- existing team; every existing row stamped; a BEFORE INSERT trigger stamps future
-- rows from the inserter's membership so the app keeps working until the Phase 2 RLS rewrite.

-- 1. workspaces ----------------------------------------------------------------------
create table if not exists public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- 2. workspace_members ---------------------------------------------------------------
create table if not exists public.workspace_members (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id)        on delete cascade,
  role         text not null check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  unique (workspace_id, user_id)
);
-- workspace_id lookups are served by the UNIQUE(workspace_id, user_id) index (leading col),
-- so only the user_id side needs its own index (also covers the user_id FK):
create index if not exists workspace_members_user_id_idx on public.workspace_members (user_id);

-- 3. nullable workspace_id on the four data tables + an index on each -----------------
alter table public.tasks         add column if not exists workspace_id uuid references public.workspaces (id);
alter table public.comments      add column if not exists workspace_id uuid references public.workspaces (id);
alter table public.messages      add column if not exists workspace_id uuid references public.workspaces (id);
alter table public.notifications add column if not exists workspace_id uuid references public.workspaces (id);

create index if not exists tasks_workspace_id_idx         on public.tasks (workspace_id);
create index if not exists comments_workspace_id_idx      on public.comments (workspace_id);
create index if not exists messages_workspace_id_idx      on public.messages (workspace_id);
create index if not exists notifications_workspace_id_idx on public.notifications (workspace_id);

-- 4. Backfill (idempotent) -----------------------------------------------------------
-- 4a. one workspace, owned by the primary human owner (Tony / ciorciaritony@gmail.com).
insert into public.workspaces (id, name, owner_id)
values ('11111111-1111-1111-1111-111111111111', 'Command Center',
        '1745dca1-be37-41fc-8b7b-18438d4d22c5')
on conflict (id) do nothing;

-- 4b. all current members, preserving each one's members.role.
insert into public.workspace_members (workspace_id, user_id, role)
select '11111111-1111-1111-1111-111111111111', m.id, m.role
from public.members m
on conflict (workspace_id, user_id) do nothing;

-- 4c. stamp every existing row (only where null -> idempotent).
update public.tasks         set workspace_id = '11111111-1111-1111-1111-111111111111' where workspace_id is null;
update public.comments      set workspace_id = '11111111-1111-1111-1111-111111111111' where workspace_id is null;
update public.messages      set workspace_id = '11111111-1111-1111-1111-111111111111' where workspace_id is null;
update public.notifications set workspace_id = '11111111-1111-1111-1111-111111111111' where workspace_id is null;

-- 5. BEFORE INSERT auto-stamp trigger (keeps the app working with no code change) -----
-- SECURITY DEFINER: tenant-stamping is a system invariant that must not depend on the
-- invoker's (Phase-2-tightenable) read policy/grants on workspace_members; consistent with
-- the project's other trigger fns; only ever sets NEW.workspace_id to the caller's OWN
-- workspace (auth.uid()). Hardened: fixed empty search_path + EXECUTE revoked.
create or replace function public.set_workspace_id_from_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.workspace_id is null then
    select wm.workspace_id
      into new.workspace_id
      from public.workspace_members wm
     where wm.user_id = auth.uid()
     limit 1;
  end if;
  return new;
end;
$$;

revoke execute on function public.set_workspace_id_from_membership() from public;
revoke execute on function public.set_workspace_id_from_membership() from anon;
revoke execute on function public.set_workspace_id_from_membership() from authenticated;

drop trigger if exists set_workspace_id on public.tasks;
create trigger set_workspace_id before insert on public.tasks
  for each row execute function public.set_workspace_id_from_membership();
drop trigger if exists set_workspace_id on public.comments;
create trigger set_workspace_id before insert on public.comments
  for each row execute function public.set_workspace_id_from_membership();
drop trigger if exists set_workspace_id on public.messages;
create trigger set_workspace_id before insert on public.messages
  for each row execute function public.set_workspace_id_from_membership();
drop trigger if exists set_workspace_id on public.notifications;
create trigger set_workspace_id before insert on public.notifications
  for each row execute function public.set_workspace_id_from_membership();

-- 6. RLS + grants on the two NEW tables (Phase-1: read-only, member-scoped) -----------
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;

drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspaces.id
        and wm.user_id = (select auth.uid())
    )
  );

drop policy if exists workspace_members_select_self on public.workspace_members;
create policy workspace_members_select_self on public.workspace_members
  for select to authenticated
  using (user_id = (select auth.uid()));

grant select on public.workspaces        to authenticated;
grant select on public.workspace_members to authenticated;
