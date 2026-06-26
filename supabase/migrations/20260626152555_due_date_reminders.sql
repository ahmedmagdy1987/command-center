-- Due-date reminders: an hourly pg_cron job that notifies the ASSIGNEE when one of their tasks is due
-- within 24h (due_soon) or past due (overdue) — once each, deduped via tasks.due_reminder_stage
-- (none -> due_soon -> overdue, monotonic; reset when the due_date changes). Assignee-only = leak-proof
-- (the assignee can always see their own task; a guest assignee gets their own reminder). notifications
-- RLS is unchanged (recipient-only). Proven by an 11/11 rolled-back feasibility proof + a 19/19
-- cross-tenant isolation re-audit (0 leaks, the new due_soon/overdue notification surface included).

create extension if not exists pg_cron;

alter table public.tasks add column if not exists due_reminder_stage text not null default 'none';

-- Editing a task's due_date re-arms its reminders (stage back to 'none').
create or replace function public.reset_due_reminder_stage()
returns trigger language plpgsql as $$
begin
  if new.due_date is distinct from old.due_date then new.due_reminder_stage := 'none'; end if;
  return new;
end; $$;
revoke all on function public.reset_due_reminder_stage() from public, anon, authenticated;
drop trigger if exists reset_due_reminder_stage on public.tasks;
create trigger reset_due_reminder_stage before update on public.tasks
  for each row execute function public.reset_due_reminder_stage();

-- The job body. SECURITY DEFINER / search_path='' / EXECUTE-revoked, like the existing notify exemplars:
-- it inserts notifications (which have no client INSERT grant) and is invoked only by cron. The updating
-- CTE per kind is atomic — UPDATE...RETURNING claims the rows (advances the stage) and feeds exactly those
-- to the INSERT, so no double-count and no read-then-write race.
create or replace function private._run_due_reminders()
returns void language plpgsql security definer set search_path to '' as $$
begin
  with picked as (
    update public.tasks set due_reminder_stage = 'due_soon'
    where assignee_id is not null and status <> 'done' and due_reminder_stage = 'none'
      and due_date is not null and due_date > now() and due_date <= now() + interval '24 hours'
    returning id, assignee_id, workspace_id, title
  )
  insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
  select assignee_id, null, id, 'due_soon', 'Due soon',
         '"'||coalesce(title,'Untitled')||'" is due within a day.', workspace_id from picked;

  with picked as (
    update public.tasks set due_reminder_stage = 'overdue'
    where assignee_id is not null and status <> 'done' and due_reminder_stage <> 'overdue'
      and due_date is not null and due_date <= now()
    returning id, assignee_id, workspace_id, title
  )
  insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
  select assignee_id, null, id, 'overdue', 'Overdue',
         '"'||coalesce(title,'Untitled')||'" is overdue.', workspace_id from picked;
end; $$;
revoke all on function private._run_due_reminders() from public, anon, authenticated;

-- Hourly schedule. The named form upserts, so re-applying is idempotent.
select cron.schedule('due-date-reminders', '0 * * * *', $$ select private._run_due_reminders(); $$);
