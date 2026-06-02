-- Invitations phase, Step 0: scope the voice-notes SELECT storage policy to the workspace.
-- Before this, voice_notes_select_member let ANY global member read ANY voice note in the bucket
-- (gated only on members-existence). With invitations creating a real multi-workspace, multi-member
-- world, that is a cross-workspace read gap. A voice-note object's workspace is derivable from the
-- message that references it (messages.audio_path -> workspace_id), so read access is now: your OWN
-- upload (path folder = your uid, which also covers the upload->sign window before the message row
-- exists) OR a message referencing the object is in a workspace you belong to. INSERT/DELETE are
-- already self-folder-scoped (foldername[1]=auth.uid()), so they carry no cross-workspace risk and
-- are left unchanged.
-- Verified by a rolled-back live-RLS proof: a WS1-only member can't read a WS-B voice note (0), while
-- the uploader and a WS-B co-member can (1/1); advisors clean; per-user baseline unchanged.

drop policy if exists "voice_notes_select_member" on storage.objects;
create policy "voice_notes_select_member" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'voice-notes'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.messages msg
        where msg.audio_path = name
          and private.is_workspace_member(msg.workspace_id)
      )
    )
  );
