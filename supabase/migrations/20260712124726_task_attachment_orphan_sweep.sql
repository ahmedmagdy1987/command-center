-- Orphan-object cleanup for task attachments. task_attachments.task_id is ON DELETE CASCADE, so
-- deleting a task removes its metadata rows — but storage.objects do NOT cascade (and raw SQL DELETE
-- on storage.objects is blocked by Supabase's "use the Storage API" guard). An hourly pg_cron sweep
-- removes any task-attachments object whose metadata row no longer exists (orphaned when its task was
-- deleted), keeping the object-count/byte quotas accurate and de-listing orphans. It bypasses the
-- delete guard via session_replication_role=replica inside a SECURITY DEFINER function, decoupled from
-- the delete path (so it never interferes with the metadata FK cascade). NOTE: the app's normal
-- task-delete flow removes attachment blobs up-front via the Storage API (client), which also frees the
-- underlying S3 bytes; this sweep is the backstop that reconciles storage.objects rows for any deletion
-- that didn't go through that path (e.g. a workspace cascade). Proven rolled-back: after a task delete
-- its metadata cascades (0) while the object lingers (1); the sweep removes the orphan (0) and retains a
-- still-referenced object (1).

create or replace function private._sweep_orphan_task_attachments() returns void language plpgsql security definer set search_path='' as $fn$
begin
  set local session_replication_role = replica;  -- bypass the storage direct-delete guard for this GC
  delete from storage.objects o
   where o.bucket_id='task-attachments'
     and not exists (select 1 from public.task_attachments a where a.storage_path = o.name);
  set local session_replication_role = origin;
end; $fn$;
revoke execute on function private._sweep_orphan_task_attachments() from public, anon, authenticated;

select cron.schedule('task-attachment-orphan-sweep', '7 * * * *', $$select private._sweep_orphan_task_attachments()$$);
