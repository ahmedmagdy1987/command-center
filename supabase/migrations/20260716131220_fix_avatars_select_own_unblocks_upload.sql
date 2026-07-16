-- BUG FIX: every avatar upload failed with 42501 "new row violates row-level security policy".
--
-- ROOT CAUSE: 20260716110514 created the avatars bucket with a BROAD SELECT policy (avatars_read_all);
-- clearing the resulting public_bucket_allows_listing advisor dropped it, leaving the bucket with NO SELECT
-- policy at all. Supabase Storage's upload({upsert:true}) issues
--     INSERT INTO storage.objects ... ON CONFLICT (bucket_id,name) DO UPDATE ...
-- which must READ the conflicting row. With no SELECT policy that read is denied and the whole statement
-- fails 42501 — so no avatar could ever be uploaded. A plain INSERT still worked, which is exactly why the
-- 40/40 profile proof stayed green while the feature was broken: its S01 only exercised the plain-INSERT
-- path, never the upsert the client actually issues. (avatars_upload_rls_rolled_back_proof.sql now covers
-- the upsert path so this cannot regress silently.)
--
-- FIX: restore SELECT, but SCOPED to the caller's OWN folder — never bucket-wide, so no client can list the
-- bucket (advisor verified clean after apply) while the upsert can read its own conflicting row. Public
-- rendering is unaffected: objects in a public bucket serve via the CDN public URL with no policy involved.
-- Also make avatars_update_own's WITH CHECK explicit: PostgreSQL defaults WITH CHECK to USING, but stating
-- it means a future edit can't silently allow a user to rename their object INTO another user's folder.
--
-- Proven rolled-back 14/14: upsert + plain insert + own SELECT/UPDATE allowed; A cannot read, write, or
-- rename into B's folder; A's bucket-wide listing returns only their own object; and BUG A stays closed
-- (self-profile update OK, email/role immutable, no cross-user write).
drop policy if exists avatars_select_own on storage.objects;
create policy avatars_select_own on storage.objects for select to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects for update to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
