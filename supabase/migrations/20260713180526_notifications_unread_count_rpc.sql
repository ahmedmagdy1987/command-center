-- 5b (SCALE_AUDIT A9): accurate workspace notification unread count, server-side, at any volume.
-- The NotificationBell today derives "{n} new" from the in-memory items array, which is capped at
-- notifications.list(50) — so it undercounts once a workspace has > 50 unread. This RPC counts server-side
-- (no window), mirroring the dm_unread_counts pattern. Advisor-clean: private DEFINER impl + public INVOKER
-- passthrough. The DEFINER body filters recipient_id = auth.uid(), so a caller can only ever count their OWN
-- unread — never another user's.
--
-- Proven rolled-back 3/3 (2026-07-13): user A -> A's own unread (1); user B calling the SAME workspace ->
-- B's own count (0, not A's) [isolation]; anon has no execute grant.
-- Wiring (NotificationBell header count) lands with the frontend scale bundle; the RPC is dormant until then.

create or replace function private._notifications_unread_count(p_ws uuid)
returns bigint language sql stable security definer set search_path='' as $fn$
  select count(*)::bigint from public.notifications
   where recipient_id = auth.uid() and workspace_id = p_ws and read = false;
$fn$;

create or replace function public.notifications_unread_count(p_ws uuid)
returns bigint language sql security invoker set search_path='' as $fn$
  select private._notifications_unread_count(p_ws);
$fn$;

revoke all on function private._notifications_unread_count(uuid) from public, anon;
revoke all on function public.notifications_unread_count(uuid)  from public, anon;
grant execute on function private._notifications_unread_count(uuid) to authenticated;
grant execute on function public.notifications_unread_count(uuid)  to authenticated;
