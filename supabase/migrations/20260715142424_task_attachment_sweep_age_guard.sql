-- BUG B — the hourly orphan sweep could delete a LIVE upload.
--
-- The client uploads the blob first and inserts the task_attachments metadata row second
-- (src/lib/api.js:977-981), because the storage-delete policy needs the metadata row to authorize a
-- later delete. That leaves a window in which a perfectly good, in-flight object has no metadata row.
-- The sweep's only test was "no metadata row" -> it deleted such an object outright. The metadata
-- INSERT would then still succeed, leaving a DANGLING metadata row pointing at a blob that no longer
-- exists (a permanently broken attachment) -- worse than the orphan the sweep exists to collect.
-- The window widens with large files (25 MB cap) and slow connections.
--
-- Fix: only ever collect objects old enough that no upload could still be in flight. The sweep runs
-- hourly and only ever GCs blobs whose task was deleted, so a 1-hour delay costs nothing.
--
-- Proven (17/17 rolled-back): current sweep destroys an age-0s in-flight upload; with the guard it
-- survives, while a 61-minute orphan is still collected and linked objects are never touched. The
-- guard is a boundary test at 59/61 minutes, and survives repeated sweeps.
-- CREATE OR REPLACE preserves the existing EXECUTE privileges and the pg_cron schedule.

create or replace function private._sweep_orphan_task_attachments()
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  set local session_replication_role = replica;  -- bypass the storage direct-delete guard for this GC
  delete from storage.objects o
   where o.bucket_id = 'task-attachments'
     and o.created_at < now() - interval '1 hour'   -- never race an upload whose metadata row is still in flight
     and not exists (select 1 from public.task_attachments a where a.storage_path = o.name);
  set local session_replication_role = origin;
end;
$$;
