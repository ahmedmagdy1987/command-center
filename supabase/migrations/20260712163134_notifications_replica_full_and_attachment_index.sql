-- Realtime + perf infra (additive, no RLS/behavior change).
-- (1) REPLICA IDENTITY FULL on notifications so realtime UPDATE/DELETE payloads carry the full old row
--     (incl. recipient_id) — otherwise the server-side `recipient_id=eq.<uid>` filter can't match on
--     DELETE (default replica identity ships only the PK), so cross-device read/clear never propagates.
--     Same pattern already used on messages/comments/dm_messages. RLS is unchanged: the SELECT policy
--     stays recipient-only, so realtime still delivers only the recipient's own rows (proven 4/4:
--     outsider sees/deletes/updates 0; a member can't read another's).
-- (2) Covering index on task_attachments.uploaded_by (perf advisor: unindexed FK; also speeds the
--     uploader-own DELETE-policy check).
alter table public.notifications replica identity full;
create index if not exists task_attachments_uploaded_by_idx on public.task_attachments(uploaded_by);
