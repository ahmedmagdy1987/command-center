-- Accurate per-conversation DM unread count, at any workspace volume. The client previously derived
-- unread from a newest-500-messages window, so busy workspaces undercounted quieter conversations that
-- fell outside the window. This RPC computes each conversation's unread server-side (no window).
-- Advisor-clean: private DEFINER impl + public INVOKER passthrough (same shape as workspace_members_list).
-- Isolation: returns ONLY the caller's own conversations (auth.uid() in user_lo/user_hi); a message is
-- unread iff it's not the caller's own, not soft-deleted, and newer than the caller's dm_reads cursor.
-- Proven rolled-back 4/4: participant unread=1 for a fresh peer message; sender's own message counts 0;
-- a non-participant gets no row for that conversation; an outsider gets 0 conversations.
create or replace function private._dm_unread_counts(p_ws uuid)
returns table(conversation_id uuid, unread bigint)
language sql stable security definer set search_path='' as $fn$
  select c.id,
    (select count(*) from public.dm_messages m
       where m.conversation_id = c.id
         and m.sender_id is distinct from auth.uid()
         and m.deleted_at is null
         and m.created_at > coalesce((select r.last_read_at from public.dm_reads r
                                        where r.conversation_id = c.id and r.user_id = auth.uid()), 'epoch'::timestamptz))::bigint
  from public.dm_conversations c
  where c.workspace_id = p_ws
    and auth.uid() in (c.user_lo, c.user_hi);
$fn$;
create or replace function public.dm_unread_counts(p_workspace_id uuid)
returns table(conversation_id uuid, unread bigint)
language sql security invoker set search_path='' as $fn$
  select * from private._dm_unread_counts(p_workspace_id);
$fn$;
revoke all on function private._dm_unread_counts(uuid) from public, anon;
revoke all on function public.dm_unread_counts(uuid)  from public, anon;
grant execute on function private._dm_unread_counts(uuid) to authenticated;
grant execute on function public.dm_unread_counts(uuid)  to authenticated;
