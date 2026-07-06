-- [L3] Voice-note upload hardening (2026-07-06 red-team audit — SECURITY_AUDIT_2026-07-06.md).
-- The INSERT policy only checked own-folder + "has a members row", with no per-user cap — any
-- signed-up user could upload unlimited 10 MB objects (storage-cost DoS). Add a server-side
-- per-user rate limit + absolute cap via a SECURITY DEFINER helper, and keep the existing
-- own-folder gate. Upload remains scoped to the caller's <auth.uid()>/ folder; the workspace
-- association is enforced later at message-insert time (messages/dm_messages RLS) and at
-- object-read time (voice_notes_select_member) — the upload path itself carries no workspace.
--
-- Quota: <30 uploads per rolling hour AND <1000 objects total, per user (both counted over the
-- caller's own folder in the voice-notes bucket). 30/hr stops automated abuse while never
-- touching real use (a human recording 30 voice notes in an hour is already extreme); 1000 is a
-- generous absolute backstop (<=10 GB/user). Tune here if usage patterns require.
--
-- Proven rolled-back before apply: helper allows at 0/5 recent, blocks at 30 recent, and is
-- per-user (another user with 0 objects is unaffected); end-to-end, the real INSERT policy blocks
-- the over-limit upload (42501), allows a normal upload, and still blocks a cross-folder upload
-- (42501). Isolation regression held; advisors clean.

create or replace function private.voice_note_upload_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    (select count(*) from storage.objects o
       where o.bucket_id = 'voice-notes'
         and (storage.foldername(o.name))[1] = (auth.uid())::text
         and o.created_at > now() - interval '1 hour') < 30
    and
    (select count(*) from storage.objects o
       where o.bucket_id = 'voice-notes'
         and (storage.foldername(o.name))[1] = (auth.uid())::text) < 1000;
$fn$;

revoke execute on function private.voice_note_upload_allowed() from public, anon;
grant execute on function private.voice_note_upload_allowed() to authenticated;

drop policy voice_notes_insert_member on storage.objects;
create policy voice_notes_insert_member on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'voice-notes'
    and (storage.foldername(name))[1] = ((select auth.uid()))::text
    and exists (select 1 from public.members m where m.id = (select auth.uid()))
    and private.voice_note_upload_allowed()
  );
