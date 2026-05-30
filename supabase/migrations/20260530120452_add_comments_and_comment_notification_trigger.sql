-- ===========================================================================
-- comments: in-task discussion. Visibility INHERITS the task (a user can read /
-- add comments only on tasks they can see). Idempotent.
-- ===========================================================================
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     text not null references public.tasks (id) on delete cascade,
  author_id   uuid references auth.users (id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Thread query index (task_id, created_at) + author FK index (keeps perf advisor clean).
create index if not exists comments_task_id_created_idx on public.comments (task_id, created_at);
create index if not exists comments_author_id_idx       on public.comments (author_id);

-- Full replica identity so realtime UPDATE/DELETE carry the full OLD row (incl. task_id),
-- letting the per-task realtime filter match edits/deletes too (not just inserts).
alter table public.comments replica identity full;

-- RLS: inherit task visibility. The EXISTS subquery on tasks is itself filtered by
-- tasks' RLS for the authenticated role, so a user can read/add comments exactly on
-- tasks they can see.
alter table public.comments enable row level security;

drop policy if exists comments_select_visible on public.comments;
create policy comments_select_visible on public.comments
  for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = comments.task_id));

drop policy if exists comments_insert_own on public.comments;
create policy comments_insert_own on public.comments
  for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (select 1 from public.tasks t where t.id = comments.task_id)
  );

drop policy if exists comments_update_own on public.comments;
create policy comments_update_own on public.comments
  for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));

drop policy if exists comments_delete_own on public.comments;
create policy comments_delete_own on public.comments
  for delete to authenticated
  using (author_id = (select auth.uid()));

-- Per-table grants (this project uses explicit grants, not default-grant-all).
grant select, insert, update, delete on public.comments to authenticated;

-- Realtime (honours RLS -> per-task / per-user filtering).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname='supabase_realtime' and schemaname='public' and tablename='comments'
     )
  then
    alter publication supabase_realtime add table public.comments;
  end if;
end $$;

-- ===========================================================================
-- comment -> notification: notify everyone who can see the task, except the author.
--   workspace task (owner in va/shared): notify every other member.
--   private ('me') task: only the creator can see it -> notify no one.
-- Reuses the notifications table + bell. Same hardening as notify_on_task_created.
-- ===========================================================================
create or replace function public.notify_on_comment_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text;
  v_title text;
begin
  select t.owner, t.title into v_owner, v_title
  from public.tasks t where t.id = new.task_id;

  if v_owner in ('va', 'shared') then
    insert into public.notifications (recipient_id, actor_id, task_id, type, title, message)
    select m.id,
           new.author_id,
           new.task_id,
           'comment_added',
           'New comment',
           'New comment on "' || coalesce(v_title, 'Untitled') || '". Check the details.'
    from public.members m
    where m.id <> new.author_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.notify_on_comment_added() from public;
revoke execute on function public.notify_on_comment_added() from anon;
revoke execute on function public.notify_on_comment_added() from authenticated;

drop trigger if exists notify_on_comment_added on public.comments;
create trigger notify_on_comment_added
  after insert on public.comments
  for each row execute function public.notify_on_comment_added();
