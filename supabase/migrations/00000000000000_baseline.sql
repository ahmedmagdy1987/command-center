-- ============================================================================
-- 00000000000000_baseline.sql — BEST-EFFORT RECONSTRUCTION of the pre-ledger base schema
-- ============================================================================
-- ⚠️  THIS IS NOT AN ORIGINAL ARTIFACT — IT IS A RECONSTRUCTION. No hand-written CREATE TABLE
--     script for the base tables (public.tasks / public.projects / public.members) ever existed:
--     they were created directly on Supabase (dashboard / early setup) BEFORE the migration ledger
--     began (first ledger entry = 20260529185644). This file is reconstructed from the LIVE schema
--     (introspected 2026-07-16) and REWOUND to the pre-ledger shape so the later migrations replay
--     cleanly:
--       • tasks   — WITH `owner`; WITHOUT workspace_id (Phase 1), assignee_id (2A), due_reminder_stage.
--       • projects— WITHOUT workspace_id (Phase 3A).
--       • members — original 2-value role; WITHOUT avatar_url/bio/status_* (those land in the UX batch).
--       • migration-added length/shape CHECKs (…_len_chk / …_shape_chk / …_size_chk, from 20260713180216
--         + 20260715235911) are DELIBERATELY OMITTED — they arrive via their own migrations.
--
-- ⚠️  NEVER APPLIED to the live DB (the tables already exist — no-op there). It exists only to give a
--     from-scratch rebuild (baseline → every migration in order) a starting point. A real from-scratch
--     rebuild MUST be validated END-TO-END (DB password + owner present) before it is trusted. Do not
--     assume this is byte-identical to what was originally run.
--
-- ⚠️  KNOWN UNCERTAINTIES (flagged inline with «?»):
--       • tasks.owner default (2C dropped the column + its CHECK before this session).
--       • the ORIGINAL base RLS POLICIES — NOT RECOVERABLE (Phase 2/3A drop every policy by name and
--         recreate them). Conservative placeholders below; they are NOT the originals.
--       • the original members GRANT (pre-identity-lock likely broader than the live INSERT/SELECT).
--       • whether tags/subtasks/links/recurring were original or added out-of-band (not traceable to any
--         migration → assumed original).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- RLS auto-enable event trigger (live definition; stable utility, believed unchanged since creation —
-- exact original not independently verifiable). Created first so the CREATE TABLEs below auto-enable RLS.
-- ---------------------------------------------------------------------------
create or replace function public.rls_auto_enable() returns event_trigger
language plpgsql security definer set search_path to 'pg_catalog' as $fn$
declare cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
    if cmd.schema_name is not null and cmd.schema_name in ('public')
       and cmd.schema_name not in ('pg_catalog','information_schema')
       and cmd.schema_name not like 'pg_toast%' and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception when others then
        raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    else
      raise log 'rls_auto_enable: skip % (system schema or not enforced)', cmd.object_identity;
    end if;
  end loop;
end;
$fn$;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls on ddl_command_end
  when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
  execute function public.rls_auto_enable();

-- ---------------------------------------------------------------------------
-- public.members  (original 2-value role; profile columns arrive in the UX-batch migration)
-- ---------------------------------------------------------------------------
create table if not exists public.members (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text,
  role         text not null default 'member' check (role in ('owner','member')),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- public.projects  (pre-Phase-3A: NO workspace_id)
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id         text primary key,
  name       text not null,
  color      text not null default '#64748b',
  icon       text not null default '◇',
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- public.tasks  (pre-Phase-1/2A/2C: WITH `owner`; WITHOUT workspace_id/assignee_id/due_reminder_stage)
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id                text primary key,
  title             text not null default 'Untitled task',
  description       text default '',
  owner             text not null default 'me' check (owner in ('me','va','shared')),  -- «?» exact default unverified
  privacy           text not null default 'workspace' check (privacy in ('workspace','private')),
  project           text not null default 'other',
  status            text not null default 'inbox' check (status in ('inbox','must','should','waiting','scheduled','done')),
  priority          text not null default 'medium' check (priority in ('critical','high','medium','low')),
  effort            text not null default 'medium' check (effort in ('quick','medium','deep')),
  urgent            boolean not null default false,
  important         boolean not null default false,
  blocked           boolean not null default false,
  blocked_reason    text default '',
  due_date          timestamptz,
  scheduled_date    timestamptz,
  estimated_minutes integer not null default 30,
  tags              jsonb not null default '[]',   -- «?» original vs out-of-band (not traceable to a migration)
  subtasks          jsonb not null default '[]',   -- «?» same
  links             jsonb not null default '[]',   -- «?» same
  recurring         jsonb,                          -- «?» same
  created_by        uuid references auth.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  task_order        bigint not null default extract(epoch from now())
);

-- RLS enabled explicitly (belt — ensure_rls also fires on the CREATE TABLEs above).
alter table public.members  enable row level security;
alter table public.projects enable row level security;
alter table public.tasks    enable row level security;

-- Base-table privileges (least-privilege, explicit per table).
-- «?» members likely held table-wide UPDATE originally; 20260715142400 later revokes it and grants only
--     UPDATE(display_name). tasks/projects grants match the live DML surface.
grant select, insert, update, delete on public.tasks    to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update          on public.members  to authenticated;

-- ---------------------------------------------------------------------------
-- handle_new_user: seed a members profile on signup (first member = owner).
-- «?» Plausible ORIGINAL body; later migrations REPLACE it (20260701161427 hardens search_path; the
--     UX-batch profile migration adds display_name sanitization). Last CREATE OR REPLACE wins on replay.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path to 'public' as $fn$
declare member_count integer;
begin
  select count(*) into member_count from public.members;
  insert into public.members (id, email, display_name, role)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
          case when member_count = 0 then 'owner' else 'member' end);
  return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;   -- «?» original trigger name assumed
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- ⚠️  ORIGINAL BASE RLS POLICIES ARE NOT RECOVERABLE. Phase 2 / 3A drop every policy on these tables by
--     name and recreate them, so the true originals are gone. The placeholders below are a CONSERVATIVE
--     "manage your own rows" set so a from-scratch rebuild is not wide-open between here and Phase 2 —
--     they are NOT the originals and are superseded almost immediately. Validate a real rebuild end-to-end.
-- ---------------------------------------------------------------------------
drop policy if exists members_select_self on public.members;
create policy members_select_self on public.members for select to authenticated using (id = (select auth.uid()));
drop policy if exists members_insert_self on public.members;
create policy members_insert_self on public.members for insert to authenticated with check (id = (select auth.uid()));
drop policy if exists members_update_self on public.members;
create policy members_update_self on public.members for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists tasks_manage_own on public.tasks;               -- placeholder (real tasks RLS = Phase 2 ⟨P2⟩)
create policy tasks_manage_own on public.tasks for all to authenticated
  using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));

drop policy if exists projects_all_authenticated on public.projects;  -- placeholder (real projects RLS = Phase 3A)
create policy projects_all_authenticated on public.projects for all to authenticated using (true) with check (true);
