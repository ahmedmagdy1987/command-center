-- ============================================================================
-- BUG FIX — avatar upload blocked by RLS (42501) — ROLLED-BACK PROOF (14 assertions)
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
-- never move their object into someone else's folder. Public rendering is unaffected (CDN public URL).
--
-- MUST NOT reopen BUG A: email/role/id/created_at stay immutable and no cross-user write (A10-A13).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- (1) THE FIX DDL UNDER TEST
-- ---------------------------------------------------------------------------
drop policy if exists avatars_select_own on storage.objects;
create policy avatars_select_own on storage.objects for select to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects for update to authenticated
  using (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id='avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

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
  uB uuid := gen_random_uuid();   -- another member (victim of any cross-user attempt)
  v_ws uuid := gen_random_uuid();
  pA text; pB text;
  v_res text; v_n int;
begin
  insert into auth.users (id,email,aud,role) values
    (uA,'av-a-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (uB,'av-b-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.workspaces (id,name,owner_id,slug) values (v_ws,'AV WS',uA,'av-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values (v_ws,uA,'owner'),(v_ws,uB,'member');

  pA := uA::text||'/'||v_sfx||'.jpg';   -- A's own folder
  pB := uB::text||'/'||v_sfx||'.jpg';   -- B's folder

  -- B already has an object (so "A cannot see/modify it" is non-vacuous)
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
  values ('avatars', pB, uB, uB::text, jsonb_build_object('size',10,'mimetype','image/jpeg'));

  -- ===== HARNESS GUARD =====
  perform pg_temp.imp(uA);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: bypassrls'; end if;
  if auth.uid() is distinct from uA then execute 'reset role'; raise exception 'HARNESS BROKEN: uid'; end if;
  execute 'reset role';

  -- ===== ANTI-VACUITY GUARD: B's object really exists, and the path shape resolves to the uid =====
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pB;
  if v_n <> 1 then raise exception 'VACUOUS: B''s planted object missing'; end if;
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

  -- ========== GROUP S — the SELECT stays SCOPED (no bucket listing => advisor stays clean) ==========
  perform pg_temp.imp(uA); select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pB;
  execute 'reset role'; insert into _r values (5,'S01 CORE: A CANNOT read B''s avatar object (scoped, not bucket-wide)','0',v_n::text,v_n=0);

  perform pg_temp.imp(uA); select count(*) into v_n from storage.objects where bucket_id='avatars';
  execute 'reset role'; insert into _r values (6,'S02 A''s bucket-wide listing returns ONLY their own object (=1, not 2)','1',v_n::text,v_n=1);

  perform pg_temp.imp(uB); select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pB;
  execute 'reset role'; insert into _r values (7,'S03 pair (non-vacuous): B CAN read B''s own object','1',v_n::text,v_n=1);

  -- ========== GROUP X — cross-user writes still blocked ==========
  perform pg_temp.imp(uA);
  begin insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
        values ('avatars', uB::text||'/evil.jpg', uA, uA::text, jsonb_build_object('size',1,'mimetype','image/jpeg'));
        v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (8,'X01 A CANNOT INSERT into B''s avatars folder','42501',v_res,v_res='42501');

  perform pg_temp.imp(uA);
  update storage.objects set metadata=jsonb_build_object('size',999) where bucket_id='avatars' and name=pB;
  get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (9,'X02 A CANNOT UPDATE B''s object','0 rows',v_n::text||' rows',v_n=0);

  -- X03: the explicit WITH CHECK — A cannot MOVE their own object into B's folder
  perform pg_temp.imp(uA);
  begin update storage.objects set name = uB::text||'/stolen.jpg' where bucket_id='avatars' and name=pA;
        v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (10,'X03 A CANNOT rename their object INTO B''s folder (WITH CHECK)','42501',v_res,v_res='42501');

  -- ========== GROUP A — BUG A must stay closed ==========
  perform pg_temp.imp(uA);
  begin update public.members set display_name='Av Tester', status_text='ok', status_emoji='🔥', bio='b',
          avatar_url='https://nqlzjuxqgajeoypyzlnv.supabase.co/storage/v1/object/public/avatars/'||uA||'/x.jpg'
        where id=uA; v_res:='OK'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (11,'A10 legitimate self-profile update still succeeds','OK',v_res,v_res='OK');

  perform pg_temp.imp(uA);
  begin update public.members set email='hijack-'||v_sfx||'@x.test' where id=uA; v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (12,'A11 BUG A stays closed: cannot change own email','42501',v_res,v_res='42501');

  perform pg_temp.imp(uA);
  begin update public.members set role='owner' where id=uA; v_res:='ALLOWED'; exception when others then v_res:=sqlstate; end;
  execute 'reset role'; insert into _r values (13,'A12 BUG A stays closed: cannot change own members.role','42501',v_res,v_res='42501');

  perform pg_temp.imp(uA);
  update public.members set status_text='pwned' where id=uB; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (14,'A13 cannot write ANOTHER user''s profile row','0 rows',v_n::text||' rows',v_n=0);

  select count(*) into v_n from _r; if v_n <> 14 then raise exception 'INCOMPLETE: % rows, expected 14', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$fix$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;
