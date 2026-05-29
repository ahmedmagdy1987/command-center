-- Notifications + task-created trigger for the VA notification center.
-- Idempotent: create-if-not-exists / drop-if-exists / create-or-replace. Safe to re-apply.

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
--    auth.uid() is wrapped in a scalar subquery so it is evaluated once per query
--    (avoids the auth_rls_initplan performance advisor).
alter table public.notifications enable row level security;

drop policy if exists "Recipients can read their notifications" on public.notifications;
create policy "Recipients can read their notifications"
  on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()));

drop policy if exists "Recipients can update their notifications" on public.notifications;
create policy "Recipients can update their notifications"
  on public.notifications for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

drop policy if exists "Recipients can delete their notifications" on public.notifications;
create policy "Recipients can delete their notifications"
  on public.notifications for delete to authenticated
  using (recipient_id = (select auth.uid()));

-- 4) Base-table privileges. This project grants DML explicitly per table (mirrors tasks).
--    Recipients may read / mark-read / delete their own rows (RLS restricts to own rows).
--    INSERT is never granted to clients; only the SECURITY DEFINER trigger writes rows.
grant select, update, delete on public.notifications to authenticated;
revoke insert on public.notifications from anon, authenticated;

-- 5) Realtime publication (idempotent add)
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

-- 6) Trigger function: when an OWNER creates a va/shared, non-private task,
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

-- 7) Harden the SECURITY DEFINER function: revoke EXECUTE from client roles.
revoke execute on function public.notify_on_task_created() from public;
revoke execute on function public.notify_on_task_created() from anon;
revoke execute on function public.notify_on_task_created() from authenticated;

-- 8) Trigger on tasks (idempotent)
drop trigger if exists notify_on_task_created on public.tasks;
create trigger notify_on_task_created
  after insert on public.tasks
  for each row
  execute function public.notify_on_task_created();
