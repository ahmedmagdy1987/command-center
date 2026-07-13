-- 5b (SCALE_AUDIT A10): server-side dashboard/matrix/schedule headline aggregates, so those numbers no
-- longer require the whole task array resident in memory (the "whole-array ceiling").
--
-- SECURITY INVOKER -> RLS on tasks applies, so the counts reflect exactly the caller's VISIBLE tasks,
-- matching what the client computes from its in-memory array today. A non-member gets all-zero.
-- PROVEN rolled-back 2026-07-13: member total 11==11 direct + done 1==1; guest 4==4 (own/assigned only);
-- outsider 0. Regression 42/42; advisors clean; DB restored byte-for-byte.

create or replace function public.workspace_task_stats(p_ws uuid)
returns jsonb language sql stable security invoker set search_path='' as $fn$
  select jsonb_build_object(
    'total', count(*),
    'open',  count(*) filter (where status <> 'done'),
    'done',  count(*) filter (where status = 'done'),
    'overdue', count(*) filter (where status <> 'done' and due_date is not null and due_date < current_date),
    'unassigned', count(*) filter (where assignee_id is null),
    'by_status', jsonb_build_object('inbox',count(*) filter(where status='inbox'),'must',count(*) filter(where status='must'),
      'should',count(*) filter(where status='should'),'waiting',count(*) filter(where status='waiting'),
      'scheduled',count(*) filter(where status='scheduled'),'done',count(*) filter(where status='done')),
    'quadrant', jsonb_build_object('urgent_important',count(*) filter(where urgent and important and status<>'done'),
      'urgent',count(*) filter(where urgent and not important and status<>'done'),
      'important',count(*) filter(where not urgent and important and status<>'done'),
      'neither',count(*) filter(where not urgent and not important and status<>'done'))
  ) from public.tasks where workspace_id = p_ws;
$fn$;
revoke all on function public.workspace_task_stats(uuid) from public, anon;
grant execute on function public.workspace_task_stats(uuid) to authenticated;
