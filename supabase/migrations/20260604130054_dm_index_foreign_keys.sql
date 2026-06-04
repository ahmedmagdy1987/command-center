-- Covering indexes for the DM foreign keys (clears the unindexed_foreign_keys advisor on the new
-- tables; mirrors 20260530142227_index_workspaces_owner_id). dm_messages(conversation_id,created_at)
-- is already indexed; these cover the remaining FKs used by RLS, the realtime workspace filter, and
-- ON DELETE actions.
create index if not exists dm_messages_workspace_id_idx on public.dm_messages(workspace_id);
create index if not exists dm_messages_sender_id_idx    on public.dm_messages(sender_id);
create index if not exists dm_reads_user_id_idx          on public.dm_reads(user_id);
