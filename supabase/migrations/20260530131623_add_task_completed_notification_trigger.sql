-- Notify the owner(s) when the VA marks a va/shared task done.
-- Fires only on the transition INTO done, only when the completer (auth.uid()) is a
-- non-owner member. Owner completions, private 'me' tasks, and re-saves of an
-- already-done task notify no one. Reuses the notifications table + bell. Idempotent.
create or replace function public.notify_on_task_completed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();   -- who performed the UPDATE (the request's user)
begin
  if old.status <> 'done'
     and new.status = 'done'
     and new.owner in ('va', 'shared')
     and exists (select 1 from public.members m where m.id = v_actor and m.role <> 'owner')
  then
    insert into public.notifications (recipient_id, actor_id, task_id, type, title, message)
    select m.id,
           v_actor,
           new.id,
           'task_completed',
           'Task completed',
           'Your VA completed: "' || coalesce(new.title, 'Untitled') || '".'
    from public.members m
    where m.role = 'owner';
  end if;
  return new;
end;
$$;

revoke execute on function public.notify_on_task_completed() from public;
revoke execute on function public.notify_on_task_completed() from anon;
revoke execute on function public.notify_on_task_completed() from authenticated;

drop trigger if exists notify_on_task_completed on public.tasks;
create trigger notify_on_task_completed
  after update on public.tasks
  for each row execute function public.notify_on_task_completed();
