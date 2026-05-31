-- Phase 2B-1: rewrite the three notify_* triggers off the legacy `owner` model onto assignee_id +
-- the task's workspace. This is the DB companion of 2B, landed first (in isolation) because routing
-- is the subtle-correctness part, and it clears the last `owner` reference out of the triggers so 2C
-- (drop owner) is safe. No `owner` reference remains anywhere here. Functions stay hardened
-- (SECURITY DEFINER, search_path='', EXECUTE revoked from public/anon/authenticated; rows still come
-- only from these triggers). All three stamp notifications.workspace_id = the task's workspace_id.

-- assigned (replaces notify_on_task_created): on INSERT, or on UPDATE when assignee_id actually changes,
-- notify the new assignee — but never the acting user (auth.uid()) assigning to themselves.
drop trigger if exists notify_on_task_created on public.tasks;
drop function if exists public.notify_on_task_created();

create or replace function public.notify_on_task_assigned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_actor uuid := auth.uid();
begin
  if new.assignee_id is not null
     and new.assignee_id <> v_actor
     and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
  then
    insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
    values (new.assignee_id, v_actor, new.id, 'task_assigned', 'Assigned to you',
            'You were assigned: "' || coalesce(new.title, 'Untitled') || '".', new.workspace_id);
  end if;
  return new;
end;
$$;
revoke execute on function public.notify_on_task_assigned() from public;
revoke execute on function public.notify_on_task_assigned() from anon;
revoke execute on function public.notify_on_task_assigned() from authenticated;
create trigger notify_on_task_assigned
  after insert or update of assignee_id on public.tasks
  for each row execute function public.notify_on_task_assigned();

-- completed: on transition into done by an actor who is NOT the creator, notify the creator.
create or replace function public.notify_on_task_completed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_actor uuid := auth.uid();
begin
  if old.status <> 'done' and new.status = 'done'
     and new.created_by is not null
     and new.created_by <> v_actor
  then
    insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
    values (new.created_by, v_actor, new.id, 'task_completed', 'Task completed',
            'A task you created was completed: "' || coalesce(new.title, 'Untitled') || '".', new.workspace_id);
  end if;
  return new;
end;
$$;
revoke execute on function public.notify_on_task_completed() from public;
revoke execute on function public.notify_on_task_completed() from anon;
revoke execute on function public.notify_on_task_completed() from authenticated;

-- comment: notify the distinct set {created_by, assignee_id} minus the comment author, at the task's
-- workspace. (Self-assigned task -> the single participant is notified once; the author never is.)
create or replace function public.notify_on_comment_added()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_creator uuid; v_assignee uuid; v_ws uuid; v_title text;
begin
  select t.created_by, t.assignee_id, t.workspace_id, t.title
    into v_creator, v_assignee, v_ws, v_title
  from public.tasks t where t.id = new.task_id;

  insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
  select distinct r, new.author_id, new.task_id, 'comment_added', 'New comment',
         'New comment on "' || coalesce(v_title, 'Untitled') || '".', v_ws
  from (values (v_creator), (v_assignee)) as x(r)
  where r is not null and r <> new.author_id;

  return new;
end;
$$;
revoke execute on function public.notify_on_comment_added() from public;
revoke execute on function public.notify_on_comment_added() from anon;
revoke execute on function public.notify_on_comment_added() from authenticated;
