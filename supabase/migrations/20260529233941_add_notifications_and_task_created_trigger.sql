-- Recovered VERBATIM from supabase_migrations.schema_migrations.statements (version 20260529233941)
-- on 2026-07-16. This is the SUPERSEDED FIRST VERSION of the notifications migration: it uses an
-- UNWRAPPED `auth.uid()` in the RLS policies. It was immediately re-applied as 20260529234347 (already
-- in the repo) which wraps `(select auth.uid())` to clear the auth_rls_initplan advisor and grants DML
-- explicitly. Both are in the remote ledger; the live schema matches 234347. Committed here only so the
-- repo's migration files match the remote ledger 1:1. No-op live (create-if-not-exists / idempotent).

-- Notifications + task-created trigger for the VA notification center.
-- Idempotent: create-if-not-exists / drop-if-exists / create-or-replace.

-- 1) Table (task_id is TEXT because tasks.id is text)
create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users (id) on delete cascade,
  actor_id     uuid references auth.users (id) on delete set null,
  task_id      text not null references public.tasks (id) on delete cascade,
  type         text not null,
  title        text,
  message      text not null,
  read         boolean not null default false,
  created_at   timestamptz not null default now()
);

-- 2) Indexes: cover every FK (performance advisor) + power the recipient list query
create index if not exists notifications_recipient_created_idx
  on public.notifications (recipient_id, created_at desc);
create index if not exists notifications_actor_id_idx
  on public.notifications (actor_id);
create index if not exists notifications_task_id_idx
  on public.notifications (task_id);

-- 3) RLS: recipients manage only their own rows; NO insert policy.
alter table public.notifications enable row level security;

drop policy if exists "Recipients can read their notifications" on public.notifications;
create policy "Recipients can read their notifications"
  on public.notifications for select to authenticated
  using (recipient_id = auth.uid());

drop policy if exists "Recipients can update their notifications" on public.notifications;
create policy "Recipients can update their notifications"
  on public.notifications for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

drop policy if exists "Recipients can delete their notifications" on public.notifications;
create policy "Recipients can delete their notifications"
  on public.notifications for delete to authenticated
  using (recipient_id = auth.uid());

-- Clients may never INSERT; only the SECURITY DEFINER trigger writes notifications.
revoke insert on public.notifications from anon, authenticated;

-- 4) Realtime publication (idempotent add)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'notifications'
     )
  then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- 5) Trigger function: when an OWNER creates a va/shared, non-private task,
--    notify every non-owner member (the VA), excluding the creator.
create or replace function public.notify_on_task_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.owner in ('va', 'shared')
     and new.privacy <> 'private'
     and exists (
       select 1 from public.members m
       where m.id = new.created_by and m.role = 'owner'
     )
  then
    insert into public.notifications (recipient_id, actor_id, task_id, type, title, message)
    select m.id,
           new.created_by,
           new.id,
           'task_created',
           'New task',
           'A new task was added: "' || coalesce(new.title, 'Untitled') || '". Check the details.'
    from public.members m
    where m.role <> 'owner'
      and m.id <> new.created_by;
  end if;
  return new;
end;
$$;

-- 6) Harden the SECURITY DEFINER function: revoke EXECUTE from client roles.
revoke execute on function public.notify_on_task_created() from public;
revoke execute on function public.notify_on_task_created() from anon;
revoke execute on function public.notify_on_task_created() from authenticated;

-- 7) Trigger on tasks (idempotent)
drop trigger if exists notify_on_task_created on public.tasks;
create trigger notify_on_task_created
  after insert on public.tasks
  for each row
  execute function public.notify_on_task_created();
