-- ============================================================================
-- BUG FIX — avatar upload blocked by RLS (42501) — ROLLED-BACK PROOF (20 assertions)
-- ============================================================================
-- ROOT CAUSE: 20260716110514 shipped the avatars bucket with a BROAD SELECT policy
-- (avatars_read_all); clearing the public_bucket_allows_listing advisor dropped it, leaving the bucket
-- with NO SELECT policy. Supabase Storage's upload({upsert:true}) issues
--   INSERT ... ON CONFLICT (bucket_id,name) DO UPDATE
-- which must READ the conflicting row. With no SELECT policy that read is denied and the statement fails
-- with 42501 "new row violates row-level security policy" — every avatar upload broken. (The original
-- proof's S01 only exercised a PLAIN insert, which still works — that is why 40/40 was green yet the
-- feature was broken. B01/B02 below close that gap by testing the UPSERT path the app actually uses.)
--
-- FIX: restore SELECT but SCOPED to the caller's OWN folder (never bucket-wide, so the advisor stays
-- clean and nobody can list the bucket), and make avatars_update_own's WITH CHECK explicit so a user can
-- never move their object into someone else's folder.
--
-- MUST NOT reopen BUG A: email/role/id/created_at stay immutable and no cross-user write (A13-A15).
--
-- ############################################################################################
-- ## UPDATED FOR THE PRIVATE-BUCKET CONVERSION (avatars_private_bucket_and_signed_urls).      ##
-- ##                                                                                          ##
-- ## The bucket is no longer public, so rendering no longer bypasses RLS — a peer's avatar is  ##
-- ## rendered from a SIGNED URL, and signing REQUIRES SELECT on the object. `avatars_select_own`##
-- ## is own-folder ONLY, so on its own it degrades every face except your own to initials. The  ##
-- ## conversion adds `avatars_select_shared_workspace`, which gates on the object being         ##
-- ## REFERENCED by a members row the caller may see — NOT on the folder.                       ##
-- ##                                                                                           ##
-- ## THE S-GROUP NOW PROVES THAT DISTINCTION, because it is the whole design:                   ##
-- ##   S01/S02  a peer's UNREFERENCED object stays invisible (abandoned + superseded photos).   ##
-- ##   S04/S05  a peer's REFERENCED object IS visible -> createSignedUrl succeeds.              ##
-- ##   S06      a peer's SECOND, unreferenced object stays invisible even though its FOLDER now ##
-- ##            contains a visible object — i.e. the rule really is per-object, not folder-wide.##
-- ##   S07      an outsider in another workspace still sees nothing.                            ##
-- ## If someone "simplifies" the policy to a folder-level shares_workspace() check, S06 fails.  ##
-- ## If someone reverts the policy entirely, S04 fails and the hard blocker is back.            ##
-- ##                                                                                            ##
-- ## A10 previously planted a PUBLIC URL in members.avatar_url; the rewritten                    ##
-- ## members_validate_profile rejects that (22023). It now plants a bare own-uid PATH, and A11/A12 ##
-- ## were added for the two rejections that matter: the old URL shape, and ANOTHER USER'S path —  ##
-- ## the latter being the control that stops user A publishing user B's private image to A's      ##
-- ## whole workspace, now that avatar_url GRANTS READ ACCESS to the object it names.              ##
-- ############################################################################################

begin;

-- ---------------------------------------------------------------------------
-- (1) THE FIX DDL UNDER TEST (restated to mirror the LIVE policy set)
-- ---------------------------------------------------------------------------
drop policy if exists avatars_select_own on storage.objects;
create policy avatars_select_own on storage.objects for select to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects for update to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- The co-workspace SELECT added by the private-bucket conversion. Restated here (create-or-replace /
-- drop-create) so this file describes the policy set it actually asserts against.
-- Mirrors the LIVE body as of 20260722080911: the guest-scoped `can_see_member_avatar` replaced
-- `shares_workspace` (which that migration DROPPED — restating the old body here would now fail at
-- function-creation time, not at assertion time).
create or replace function private.is_visible_avatar_object(p_name text) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.members m
     where m.avatar_url = p_name
       and private.can_see_member_avatar(m.id)
  );
$fn$;
revoke execute on function private.is_visible_avatar_object(text) from public, anon;
grant  execute on function private.is_visible_avatar_object(text) to authenticated;

drop policy if exists avatars_select_shared_workspace on storage.objects;
create policy avatars_select_shared_workspace on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and private.is_visible_avatar_object(name));

-- ---------------------------------------------------------------------------
-- (2) HARNESS
-- ---------------------------------------------------------------------------
create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role','authenticated','email', coalesce(v_email,''))::text, true);
end $fn$;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;

-- ---------------------------------------------------------------------------
-- (3) THE PROOF
-- ---------------------------------------------------------------------------
do $fix$
declare
  v_sfx text := replace(gen_random_uuid()::text,'-','');
  uA uuid := gen_random_uuid();   -- the uploader
  uB uuid := gen_random_uuid();   -- co-member of the SAME workspace (the peer whose face must render)
  uC uuid := gen_random_uuid();   -- outsider: a DIFFERENT workspace
  v_ws uuid := gen_random_uuid();
  v_ws2 uuid := gen_random_uuid();
  pA text; pB text; pB2 text;
  v_res text; v_n int;
begin
  insert into auth.users (id,email,aud,role) values
    (uA,'av-a-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (uB,'av-b-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (uC,'av-c-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.workspaces (id,name,owner_id,slug) values
    (v_ws,'AV WS',uA,'av-'||v_sfx), (v_ws2,'AV WS2',uC,'av2-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_ws,uA,'owner'),(v_ws,uB,'member'),(v_ws2,uC,'owner');

  pA  := uA::text||'/'||v_sfx||'.jpg';        -- A's own folder
  pB  := uB::text||'/'||v_sfx||'.jpg';        -- B's folder — will become B's REFERENCED avatar
  pB2 := uB::text||'/'||v_sfx||'-old.jpg';    -- B's folder — a superseded/abandoned upload, never referenced

  -- B already has two objects (so "A cannot see them" is non-vacuous, and so S06 has a folder-mate)
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata) values
    ('avatars', pB,  uB, uB::text, jsonb_build_object('size',10,'mimetype','image/jpeg')),
    ('avatars', pB2, uB, uB::text, jsonb_build_object('size',10,'mimetype','image/jpeg'));

  -- ===== HARNESS GUARD =====
  perform pg_temp.imp(uA);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: bypassrls'; end if;
  if auth.uid() is distinct from uA then execute 'reset role'; raise exception 'HARNESS BROKEN: uid'; end if;
  execute 'reset role';

  -- ===== ANTI-VACUITY GUARD: B's objects really exist, and the path shape resolves to the uid =====
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name in (pB,pB2);
  if v_n <> 2 then raise exception 'VACUOUS: B''s planted objects missing (got %)', v_n; end if;
  if (storage.foldername(pA))[1] <> uA::text then raise exception 'VACUOUS: foldername(pA)[1] <> uA'; end if;

  -- ========== GROUP B — the BUG: the upload path the app actually uses ==========
  -- B01: plain INSERT (upsert:false path) into own folder
  perform pg_temp.imp(uA);
  begin insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
        values ('avatars', pA, uA, uA::text, jsonb_build_object('size',100,'mimetype','image/jpeg'));
        v_res:='OK'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (1,'B01 plain INSERT own folder (upsert:false path) allowed','OK',v_res,v_res='OK');

  -- B02 [CORE]: UPSERT own folder — the exact upload({upsert:true}) statement that returned 42501 before
  perform pg_temp.imp(uA);
  begin insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
        values ('avatars', pA, uA, uA::text, jsonb_build_object('size',200,'mimetype','image/jpeg'))
        on conflict (bucket_id,name) do update set metadata = excluded.metadata;
        v_res:='OK'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (2,'B02 CORE: UPSERT own folder allowed (was 42501 without the SELECT policy)','OK',v_res,v_res='OK');

  -- B03: the SELECT the upsert depends on — A can read their OWN object
  perform pg_temp.imp(uA); select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pA;
  execute 'reset role'; insert into _r values (3,'B03 A can SELECT their OWN avatar object (what the upsert reads)','1',v_n::text,v_n=1);

  -- B04: UPDATE own object now matches (was 0 rows with no SELECT policy)
  perform pg_temp.imp(uA);
  update storage.objects set metadata=jsonb_build_object('size',300,'mimetype','image/jpeg')
   where bucket_id='avatars' and name=pA; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (4,'B04 A can UPDATE their OWN object','1 rows',v_n::text||' rows',v_n=1);

  -- ========== GROUP S — visibility is per-OBJECT and gated on being REFERENCED ==========
  -- Stage 1: B's objects are NOT referenced by any members row -> invisible to A even though they
  -- share a workspace. This is what keeps abandoned + superseded photos private.
  perform pg_temp.imp(uA); select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pB;
  execute 'reset role'; insert into _r values (5,'S01 CORE: A CANNOT read a co-member''s UNREFERENCED object (not folder-scoped)','0',v_n::text,v_n=0);

  perform pg_temp.imp(uA); select count(*) into v_n from storage.objects where bucket_id='avatars';
  execute 'reset role'; insert into _r values (6,'S02 A''s bucket-wide listing is ONLY their own object while the peer has no referenced avatar','1',v_n::text,v_n=1);

  perform pg_temp.imp(uB); select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pB;
  execute 'reset role'; insert into _r values (7,'S03 pair (non-vacuous): B CAN read B''s own object','1',v_n::text,v_n=1);

  -- Stage 2: B now actually USES pB as their avatar. It becomes renderable to co-workspace members.
  execute 'reset role';
  update public.members set avatar_url = pB where id = uB;

  perform pg_temp.imp(uA); select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pB;
  execute 'reset role'; insert into _r values (8,'S04 [CORE — the hard blocker] once REFERENCED, A CAN read the peer''s object -> createSignedUrl succeeds','1',v_n::text,v_n=1);

  perform pg_temp.imp(uA); select count(*) into v_n from storage.objects where bucket_id='avatars';
  execute 'reset role'; insert into _r values (9,'S05 A''s listing is now exactly {own, peer-referenced}','2',v_n::text,v_n=2);

  perform pg_temp.imp(uA); select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pB2;
  execute 'reset role'; insert into _r values (10,'S06 [CORE] per-OBJECT, not per-FOLDER: the peer''s superseded object in the SAME folder stays invisible','0',v_n::text,v_n=0);

  perform pg_temp.imp(uC); select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pB;
  execute 'reset role'; insert into _r values (11,'S07 an OUTSIDER (different workspace) still cannot read the referenced object','0',v_n::text,v_n=0);

  -- ========== GROUP X — cross-user writes still blocked ==========
  perform pg_temp.imp(uA);
  begin insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
        values ('avatars', uB::text||'/evil.jpg', uA, uA::text, jsonb_build_object('size',1,'mimetype','image/jpeg'));
        v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (12,'X01 A CANNOT INSERT into B''s avatars folder','42501',v_res,v_res='42501');

  perform pg_temp.imp(uA);
  update storage.objects set metadata=jsonb_build_object('size',999) where bucket_id='avatars' and name=pB2;
  get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (13,'X02 A CANNOT UPDATE B''s object','0 rows',v_n::text||' rows',v_n=0);

  -- X03: the explicit WITH CHECK — A cannot MOVE their own object into B's folder
  perform pg_temp.imp(uA);
  begin update storage.objects set name = uB::text||'/stolen.jpg' where bucket_id='avatars' and name=pA;
        v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (14,'X03 A CANNOT rename their object INTO B''s folder (WITH CHECK)','42501',v_res,v_res='42501');

  -- ========== GROUP A — BUG A must stay closed, and the avatar_url pin ==========
  -- A10 plants a bare own-uid PATH (the private-bucket shape). The old public URL is rejected by A11.
  perform pg_temp.imp(uA);
  begin update public.members set display_name='Av Tester', status_text='ok', status_emoji='🔥', bio='b',
          avatar_url = pA
        where id=uA; v_res:='OK'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (15,'A10 legitimate self-profile update (bare own-uid avatar path) still succeeds','OK',v_res,v_res='OK');

  perform pg_temp.imp(uA);
  begin update public.members set
          avatar_url='https://nqlzjuxqgajeoypyzlnv.supabase.co/storage/v1/object/public/avatars/'||uA||'/x.jpg'
        where id=uA; v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (16,'A11 the old PUBLIC-URL shape is now rejected (column stores a path)','22023',v_res,v_res='22023');

  -- THE CONTROL: avatar_url grants read access to the object it names, so a foreign path must be
  -- impossible — otherwise A publishes B's private image to A's whole workspace.
  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = pB2 where id=uA; v_res:='ALLOWED';
  exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (17,'A12 [CONTROL] A CANNOT point avatar_url at B''s object path (would publish B''s image)','22023',v_res,v_res='22023');

  perform pg_temp.imp(uA);
  begin update public.members set email='hijack-'||v_sfx||'@x.test' where id=uA; v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (18,'A13 BUG A stays closed: cannot change own email','42501',v_res,v_res='42501');

  perform pg_temp.imp(uA);
  begin update public.members set role='owner' where id=uA; v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (19,'A14 BUG A stays closed: cannot change own members.role','42501',v_res,v_res='42501');

  perform pg_temp.imp(uA);
  update public.members set status_text='pwned' where id=uB; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (20,'A15 cannot write ANOTHER user''s profile row','0 rows',v_n::text||' rows',v_n=0);

  select count(*) into v_n from _r; if v_n <> 20 then raise exception 'INCOMPLETE: % rows, expected 20', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$fix$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;
