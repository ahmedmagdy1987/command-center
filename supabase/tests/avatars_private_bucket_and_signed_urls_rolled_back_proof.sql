-- ============================================================================================
-- avatars PUBLIC -> PRIVATE + signed URLs — ROLLED-BACK PROOF (30 assertions)
-- ============================================================================================
-- STATUS: APPLIED 2026-07-22 as 20260722061442, after this proof ran 30/30 GREEN against the live DB
--         (re-run immediately before apply, on top of 20260722061032).
-- RESULT (re-run live against nqlzjuxqgajeoypyzlnv, 2026-07-22): total 30 / passed 30 / failed 0.
-- Post-run verification confirmed the rollback was clean: bucket still public=true, 1 avatar object,
-- members.avatar_url still the 127-char public URL, 0 new policies, 0 new functions, 0 fixture rows.
--
-- ⚠⚠ THIS FILE NO LONGER RUNS AT ALL POST-APPLY — AND IT IS WORSE THAN "SOME ASSERTIONS FAIL".
--   Measured 2026-07-22: the transaction **ABORTS DURING RED FIXTURE SETUP** and reports NOTHING —
--   zero of the 30 assertions are recorded, so a careless reader sees an error, not a verdict.
--       ERROR: 22023 avatar_url must be a storage path in your own avatars folder
--       at line ~118:  update public.members set avatar_url = v_base||pA where id = uA;
--   The fixtures deliberately plant TODAY'S public-URL-shaped `avatar_url`; the live
--   `members_validate_profile` (rewritten by the very migration this file proves) rejects a URL.
--   Beyond that, R01 asserts the bucket is PUBLIC and R04 asserts the trigger REJECTS a bare path —
--   both now false.
--   **To run this as a regression it needs the REWIND pattern**: restore the pre-migration bucket
--   flag AND the pre-migration trigger body transaction-locally before the RED block, then re-apply
--   the shipped bodies before GREEN. See guest_scoped_avatar_visibility_rolled_back_proof.sql for a
--   worked example of a REWIND-built suite that stays green forever.
--   The GREEN half (7-30) remains valid as written; it is only the RED setup that cannot run.
--
-- A LIVE POST-APPLY RE-VERIFICATION (11/11, rolled back, against the REAL production rows rather than
-- synthetic fixtures) additionally confirmed: Tony and Ahmed Magdy can each SELECT the VA's real
-- avatar object (so createSignedUrl succeeds and a co-member's face renders); the amego outsider
-- selects zero and lists an empty bucket; Ahmed CANNOT point his avatar_url at the VA's path (22023);
-- the sweep runs against live data leaving the real avatar intact; and a single URL-shaped value
-- makes the sweep RAISE 55000 with the object still present.
--
-- ONE transaction, begin; … rollback;. Nothing is applied. SYNTHETIC fixtures only.
-- Shape: RED (prove the blocker + prove finding 5 is real) -> DDL under test -> GREEN.
--
-- WHAT THIS PROVES
--   RED  1-6  : the bucket is public today; a co-member selects ZERO of a peer's avatar object (so
--               createSignedUrl would fail for every face but your own on flip day); the live trigger
--               rejects a path and accepts only the public URL; and — FINDING 5 — the new
--               exact-equality sweep rule, applied to TODAY's column shape, loses a real reference
--               to a real live object, i.e. it would delete an in-use avatar.
--   GREEN 7-12: bucket private; a co-member CAN now select a peer's REFERENCED object (signing works);
--               an outsider still cannot; the bucket stays un-listable beyond the referenced set.
--   GREEN13-16: own-folder WRITE pinning is untouched (insert, rename-into, and the DELETE policy).
--   GREEN17-22: the rewritten trigger accepts a bare own-uid path and rejects the public URL, an
--               arbitrary https URL, javascript:, ANOTHER user's path, and a sub-path.
--   GREEN23-24: the backfill converted the live row to exactly its object name, and revalidates.
--   GREEN25-28: FINDING 5 — the sweep does NOT collect referenced objects (fixtures AND the real
--               live production object), DOES collect an aged unreferenced one, and the 1-hour age
--               guard still protects a fresh one.
--   GREEN29-30: the fail-safe — a single stale URL-shaped avatar_url makes the sweep RAISE 55000
--               instead of deleting, and the object it would have destroyed is still there.
--
-- HOUSE RULES OBSERVED
--   * postgres here has rolbypassrls=true, so the harness RAISES on: current_user <> authenticated,
--     the role having rolbypassrls, an auth.uid() mismatch, and a known-denied control write not
--     returning 42501.
--   * a session running as authenticated cannot INSERT into a postgres-owned temp table -> every
--     result insert is preceded by `reset role`.
--   * denial assertions pin the exact SQLSTATE.
--   * anti-vacuity pairs throughout (3, 11, 26, 30, and the RED/GREEN pairing of 2/8 and 6/23).
--   * the only DELETEs are the sweep's own, and the sweep is bucket-scoped; fixture objects carry a
--     random suffix so they cannot collide with live data.
-- ============================================================================================

begin;

-- ---------------------------------------------------------------------------
-- (0) HARNESS
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
create temp table _f(k text primary key, v text) on commit drop;
-- objects that existed BEFORE this proof: the real live production avatar(s). Used to prove the
-- sweep interaction against real data, not just fixtures.
create temp table _pre(name text) on commit drop;
insert into _pre select name from storage.objects where bucket_id = 'avatars';

-- ---------------------------------------------------------------------------
-- (1) FIXTURES + RED
-- ---------------------------------------------------------------------------
do $red$
declare
  v_sfx text := replace(gen_random_uuid()::text,'-','');
  uA uuid := gen_random_uuid();   -- member of wsX
  uB uuid := gen_random_uuid();   -- co-member of wsX (the peer whose face must render)
  uC uuid := gen_random_uuid();   -- outsider: wsY only
  wsX uuid := gen_random_uuid();
  wsY uuid := gen_random_uuid();
  pA text; pB text; pBorph text; pFresh text; pC text;
  v_base text := 'https://nqlzjuxqgajeoypyzlnv.supabase.co/storage/v1/object/public/avatars/';
  v_res text; v_n int; v_bool boolean;
begin
  insert into auth.users (id,email,aud,role) values
    (uA,'avp-a-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (uB,'avp-b-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (uC,'avp-c-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.workspaces (id,name,owner_id,slug) values
    (wsX,'AVP X',uA,'avpx-'||v_sfx), (wsY,'AVP Y',uC,'avpy-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (wsX,uA,'owner'), (wsX,uB,'member'), (wsY,uC,'owner');

  pA     := uA::text||'/'||v_sfx||'a.jpg';
  pB     := uB::text||'/'||v_sfx||'b.jpg';
  pBorph := uB::text||'/'||v_sfx||'orph.jpg';
  pFresh := uB::text||'/'||v_sfx||'fresh.jpg';
  pC     := uC::text||'/'||v_sfx||'c.jpg';

  -- created_at 2h back on everything the sweep must JUDGE ON REFERENCE, so their survival is due to
  -- the matching rule and NOT to the 1-hour age guard. pFresh is the age-guard control.
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata,created_at) values
    ('avatars',pA,    uA,uA::text,jsonb_build_object('size',100,'mimetype','image/jpeg'), now()-interval '2 hours'),
    ('avatars',pB,    uB,uB::text,jsonb_build_object('size',100,'mimetype','image/jpeg'), now()-interval '2 hours'),
    ('avatars',pBorph,uB,uB::text,jsonb_build_object('size',100,'mimetype','image/jpeg'), now()-interval '2 hours'),
    ('avatars',pFresh,uB,uB::text,jsonb_build_object('size',100,'mimetype','image/jpeg'), now()),
    ('avatars',pC,    uC,uC::text,jsonb_build_object('size',100,'mimetype','image/jpeg'), now()-interval '2 hours');

  -- reference them the way the app does TODAY: absolute public URLs (the live trigger demands it)
  update public.members set avatar_url = v_base||pA where id = uA;
  update public.members set avatar_url = v_base||pB where id = uB;
  update public.members set avatar_url = v_base||pC where id = uC;

  insert into _f values ('uA',uA::text),('uB',uB::text),('uC',uC::text),
                        ('pA',pA),('pB',pB),('pBorph',pBorph),('pFresh',pFresh),('pC',pC),
                        ('sfx',v_sfx),('base',v_base);

  -- ===================== HARNESS GUARD (raises, never records) =====================
  perform pg_temp.imp(uA);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role is %', current_user; end if;
  if (select rolbypassrls from pg_roles where rolname = current_user) then
    execute 'reset role'; raise exception 'HARNESS BROKEN: current role has rolbypassrls'; end if;
  if auth.uid() is distinct from uA then execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid()=% expected %', auth.uid(), uA; end if;
  -- known-denied control write MUST be 42501, else RLS is not actually engaged
  begin
    update public.members set email = 'control-'||v_sfx||'@x.test' where id = uA;
    v_res := 'ALLOWED';
  exception when others then v_res := sqlstate; end;
  if v_res <> '42501' then execute 'reset role'; raise exception 'HARNESS BROKEN: control write returned % (expected 42501)', v_res; end if;
  execute 'reset role';

  -- ===================== ANTI-VACUITY: fixtures really exist =====================
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name in (pA,pB,pBorph,pFresh,pC);
  if v_n <> 5 then raise exception 'VACUOUS: planted % of 5 fixture objects', v_n; end if;
  if (select count(*) from _pre) < 1 then raise exception 'VACUOUS: no pre-existing live avatar object to test against'; end if;

  -- ===================== RED =====================
  -- R01 the bucket is PUBLIC today (the thing being changed)
  select public into v_bool from storage.buckets where id='avatars';
  insert into _r values (1,'R01 avatars bucket is PUBLIC today','true',v_bool::text,v_bool is true);

  -- R02 [CORE BLOCKER] a co-member of the SAME workspace selects ZERO of the peer's avatar object.
  --     Under a private bucket createSignedUrl needs SELECT, so every peer face would break.
  perform pg_temp.imp(uA);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pB;
  execute 'reset role';
  insert into _r values (2,'R02 CORE BLOCKER: co-member selects 0 of peer''s avatar object (signing would fail)','0',v_n::text,v_n=0);

  -- R03 anti-vacuity pair for R02: the same actor CAN select their OWN object
  perform pg_temp.imp(uA);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pA;
  execute 'reset role';
  insert into _r values (3,'R03 anti-vacuity: same actor CAN select their OWN object','1',v_n::text,v_n=1);

  -- R04 the live trigger REJECTS a bare storage path (finding 1: a signed URL can never satisfy it)
  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = pA where id = uA; v_res:='ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (4,'R04 live trigger REJECTS a bare storage path','22023',v_res,v_res='22023');

  -- R05 anti-vacuity pair for R04: it accepts the public URL
  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = v_base||pA where id = uA; v_res:='OK';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (5,'R05 anti-vacuity: live trigger ACCEPTS the public URL','OK',v_res,v_res='OK');

  -- R06 [FINDING 5] against TODAY's column shape, the new exact-equality rule LOSES references that
  --     the shipped right()-suffix rule finds — on REAL pre-existing objects. Count > 0 means the
  --     sweep would delete a live, in-use avatar if the backfill were skipped.
  select count(*) into v_n
    from storage.objects o
   where o.bucket_id='avatars'
     and o.name in (select name from _pre)
     and exists (select 1 from public.members m
                  where m.avatar_url is not null and right(m.avatar_url, length(o.name)) = o.name)
     and not exists (select 1 from public.members m where m.avatar_url = o.name);
  insert into _r values (6,'R06 FINDING 5 RED: exact-equality rule loses >=1 REAL reference under today''s URL column','>=1',v_n::text,v_n>=1);
end
$red$;

-- ---------------------------------------------------------------------------
-- (2) THE DDL UNDER TEST  (top level — CREATE FUNCTION cannot run inside a DO block)
-- ---------------------------------------------------------------------------

-- PART 1 — bucket flip
update storage.buckets set public = false where id = 'avatars';

-- PART 2 — co-workspace SELECT, gated on the object being REFERENCED (not on the folder)
-- ⚠ SUPERSEDED BY 20260722080911. As originally shipped this called `private.shares_workspace`,
-- which had NO guest clause and let a guest read any co-member's referenced avatar. That helper was
-- DROPPED, so restating the original body here would now fail at function-creation time. The
-- guest-scoped `private.can_see_member_avatar` is substituted; the assertions below concern
-- non-guest and outsider callers only, so none of them changes meaning.
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

-- PART 3 — trigger rewrite (avatar_url = bare path in the ROW OWNER's own folder)
create or replace function public.members_validate_profile() returns trigger
language plpgsql security definer set search_path to '' as $fn$
begin
  if (tg_op = 'INSERT' or new.display_name is distinct from old.display_name) and new.display_name is not null then
    if length(new.display_name) > 60 then
      raise exception 'display name is too long (max 60 characters)' using errcode = '22023';
    end if;
    if private._looks_like_role_title(new.display_name) then
      raise exception 'display name may not impersonate a role or title' using errcode = '42501';
    end if;
  end if;

  if new.status_text is not null then
    if length(new.status_text) > 80 then
      raise exception 'status is too long (max 80 characters)' using errcode = '22023';
    end if;
    if private._looks_like_role_title(new.status_text) then
      raise exception 'status may not impersonate a role or title' using errcode = '42501';
    end if;
  end if;

  if new.status_emoji is not null and length(btrim(new.status_emoji)) > 0 then
    if length(new.status_emoji) > 16 then
      raise exception 'status emoji is too long' using errcode = '22023';
    end if;
    if normalize(new.status_emoji, NFKC) ~ '[[:alnum:]]'
       or new.status_emoji ~ '[①-⓿㈀-㋿\U0001F100-\U0001F1E5\U0001F130-\U0001F189]' then
      raise exception 'status emoji must be an emoji, not letters or letter-like symbols' using errcode = '22023';
    end if;
  end if;

  if new.bio is not null and length(new.bio) > 280 then
    raise exception 'bio is too long (max 280 characters)' using errcode = '22023';
  end if;

  if new.avatar_url is not null and length(btrim(new.avatar_url)) > 0 then
    if length(new.avatar_url) > 2048 then
      raise exception 'avatar_url is too long' using errcode = '22023';
    end if;
    if new.avatar_url !~ ('^' || new.id::text || '/[A-Za-z0-9._-]{1,200}$') then
      raise exception 'avatar_url must be a storage path in your own avatars folder (<your-user-id>/<file>)'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$fn$;
revoke all on function public.members_validate_profile() from public, anon, authenticated;

drop trigger if exists members_validate_profile on public.members;
create trigger members_validate_profile
  before insert or update on public.members
  for each row execute function public.members_validate_profile();

-- PART 4 — backfill URL -> path (AFTER the rewrite; the old trigger rejects a path)
update public.members
   set avatar_url = split_part(
         regexp_replace(avatar_url, '^https?://[^/]+/storage/v1/object/public/avatars/', ''), '?', 1)
 where avatar_url is not null
   and avatar_url ~ '^https?://[^/]+/storage/v1/object/public/avatars/';

do $backfill_guard$
declare v_bad int;
begin
  select count(*) into v_bad from public.members m
   where m.avatar_url is not null
     and length(btrim(m.avatar_url)) > 0
     and m.avatar_url !~ ('^' || m.id::text || '/[A-Za-z0-9._-]{1,200}$');
  if v_bad > 0 then
    raise exception 'BACKFILL INCOMPLETE: % members.avatar_url row(s) are not a bare own-uid path; refusing to commit', v_bad
      using errcode = '55000';
  end if;
end
$backfill_guard$;

-- PART 5 — sweep re-pointed to exact equality + fail-safe
create or replace function private._sweep_orphan_avatars() returns void
language plpgsql security definer set search_path='' as $fn$
declare v_bad int;
begin
  select count(*) into v_bad from public.members m
   where m.avatar_url is not null
     and length(btrim(m.avatar_url)) > 0
     and m.avatar_url !~ ('^' || m.id::text || '/[A-Za-z0-9._-]{1,200}$');
  if v_bad > 0 then
    raise exception 'avatar sweep aborted: % members.avatar_url row(s) are not a bare storage path; refusing to sweep', v_bad
      using errcode = '55000';
  end if;

  set local session_replication_role = replica;

  delete from storage.objects o
   where o.bucket_id = 'avatars'
     and o.created_at < now() - interval '1 hour'
     and not exists (
       select 1 from public.members m
        where m.avatar_url is not null
          and m.avatar_url = o.name);

  set local session_replication_role = origin;
end; $fn$;
revoke execute on function private._sweep_orphan_avatars() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (3) GREEN
-- ---------------------------------------------------------------------------
do $green$
declare
  uA uuid := (select v from _f where k='uA')::uuid;
  uB uuid := (select v from _f where k='uB')::uuid;
  uC uuid := (select v from _f where k='uC')::uuid;
  pA     text := (select v from _f where k='pA');
  pB     text := (select v from _f where k='pB');
  pBorph text := (select v from _f where k='pBorph');
  pFresh text := (select v from _f where k='pFresh');
  pC     text := (select v from _f where k='pC');
  v_sfx  text := (select v from _f where k='sfx');
  v_base text := (select v from _f where k='base');
  v_res text; v_n int; v_bool boolean; v_pre int;
begin
  -- G01 the flip
  select public into v_bool from storage.buckets where id='avatars';
  insert into _r values (7,'G01 avatars bucket is now PRIVATE','false',v_bool::text,v_bool is false);

  -- G02 [CORE] the blocker is closed: the co-member can now SELECT the peer's referenced object,
  --     which is exactly what createSignedUrl requires.
  perform pg_temp.imp(uA);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pB;
  execute 'reset role';
  insert into _r values (8,'G02 CORE: co-member CAN now SELECT peer''s referenced avatar object (signing works)','1',v_n::text,v_n=1);

  -- G03 own object still readable (avatars_select_own retained — the not-yet-referenced upload path)
  perform pg_temp.imp(uA);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pA;
  execute 'reset role';
  insert into _r values (9,'G03 own object still selectable (own-folder policy retained)','1',v_n::text,v_n=1);

  -- G04 an OUTSIDER (different workspace) still cannot
  perform pg_temp.imp(uC);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pA;
  execute 'reset role';
  insert into _r values (10,'G04 outsider (other workspace) CANNOT select the object','0',v_n::text,v_n=0);

  -- G05 anti-vacuity pair for G04
  perform pg_temp.imp(uC);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pC;
  execute 'reset role';
  insert into _r values (11,'G05 anti-vacuity: outsider CAN select their OWN object','1',v_n::text,v_n=1);

  -- G06 UN-LISTABLE beyond the referenced set: uA's bucket-wide listing is exactly {pA own, pB
  --     referenced-by-co-member}. The peer's ORPHAN and FRESH objects stay invisible, and so does
  --     the real production avatar (uA shares no workspace with that member).
  perform pg_temp.imp(uA);
  select count(*) into v_n from storage.objects where bucket_id='avatars';
  execute 'reset role';
  insert into _r values (12,'G06 bucket listing for uA = exactly {own, peer-referenced}; peer orphans + live prod object hidden','2',v_n::text,v_n=2);

  -- ===== write pinning untouched =====
  perform pg_temp.imp(uA);
  begin insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
        values ('avatars', uB::text||'/evil-'||v_sfx||'.jpg', uA, uA::text, jsonb_build_object('size',1,'mimetype','image/jpeg'));
        v_res:='ALLOWED'; exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (13,'G07 uA CANNOT insert into uB''s folder','42501',v_res,v_res='42501');

  perform pg_temp.imp(uA);
  begin update storage.objects set name = uB::text||'/stolen-'||v_sfx||'.jpg'
         where bucket_id='avatars' and name = pA;
        v_res:='ALLOWED'; exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (14,'G08 uA CANNOT rename own object INTO uB''s folder (WITH CHECK)','42501',v_res,v_res='42501');

  -- G09a: readable now, but still not deletable. NOTE THE MECHANISM: storage.protect_delete() is a
  -- STATEMENT-level BEFORE DELETE trigger, so it raises before RLS ever gets to return 0 rows — a
  -- direct SQL delete on storage.objects is refused outright regardless of policy. That shares
  -- SQLSTATE 42501 with an RLS denial, so per house rule the MESSAGE is pinned too, otherwise this
  -- assertion would look like it proved an RLS outcome it never reached.
  perform pg_temp.imp(uA);
  begin delete from storage.objects where bucket_id='avatars' and name = pB; v_res:='ALLOWED';
  exception when others then v_res := sqlstate||'/'||(case when sqlerrm like 'Direct deletion from storage tables%' then 'protect_delete' else sqlerrm end); end;
  execute 'reset role';
  insert into _r values (15,'G09a uA can READ but a direct DELETE is refused (storage.protect_delete guard)','42501/protect_delete',v_res,v_res='42501/protect_delete');

  -- G09b: and the DELETE POLICY itself is untouched by this migration — SELECT was widened, DELETE
  -- was NOT. Asserted on the catalog because the behavioural path above cannot reach RLS. Exactly
  -- one DELETE policy on the bucket, still pinned to the caller's own folder.
  select count(*) into v_n from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relname = 'objects' and p.polname like 'avatars%' and p.polcmd = 'd'
     and pg_get_expr(p.polqual, p.polrelid) like '%foldername%'
     and pg_get_expr(p.polqual, p.polrelid) like '%auth.uid()%';
  insert into _r values (16,'G09b exactly ONE avatars DELETE policy, still pinned to own folder (unchanged)','1',v_n::text,v_n=1);

  -- ===== the rewritten trigger =====
  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = pA where id = uA; v_res:='OK';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (17,'G10 trigger ACCEPTS a bare own-uid storage path','OK',v_res,v_res='OK');

  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = v_base||pA where id = uA; v_res:='ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (18,'G11 trigger REJECTS the old public URL','22023',v_res,v_res='22023');

  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = 'https://evil.example.com/tracker.png' where id = uA; v_res:='ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (19,'G12 trigger REJECTS an arbitrary https URL (tracking-pixel vector stays closed)','22023',v_res,v_res='22023');

  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = 'javascript:alert(1)' where id = uA; v_res:='ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (20,'G13 trigger REJECTS javascript: URI','22023',v_res,v_res='22023');

  -- the new CONTROL: avatar_url now grants read access, so a foreign path must be impossible
  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = pB where id = uA; v_res:='ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (21,'G14 trigger REJECTS ANOTHER user''s path (avatar_url is a read grant)','22023',v_res,v_res='22023');

  perform pg_temp.imp(uA);
  begin update public.members set avatar_url = uA::text||'/sub/deep.jpg' where id = uA; v_res:='ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (22,'G15 trigger REJECTS a sub-path (single segment only)','22023',v_res,v_res='22023');

  -- ===== the backfill =====
  -- G16: the finding-5 RED metric is now ZERO on the SAME real pre-existing objects
  select count(*) into v_n
    from storage.objects o
   where o.bucket_id='avatars'
     and o.name in (select name from _pre)
     and not exists (select 1 from public.members m where m.avatar_url = o.name);
  insert into _r values (23,'G16 backfill: every REAL pre-existing avatar object is matched by exact equality','0',v_n::text,v_n=0);

  -- G17: a backfilled value re-validates through the new trigger (round-trip, as authenticated)
  perform pg_temp.imp(uB);
  begin update public.members set avatar_url = (select avatar_url from public.members where id = uB) where id = uB;
        v_res:='OK'; exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (24,'G17 a backfilled value re-validates through the new trigger','OK',v_res,v_res='OK');

  -- ===== FINDING 5: the sweep =====
  select count(*) into v_pre from _pre;
  perform private._sweep_orphan_avatars();

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name in (pA,pB);
  insert into _r values (25,'G18 FINDING 5 CORE: sweep does NOT collect REFERENCED objects (aged 2h, so not age-guarded)','2',v_n::text,v_n=2);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pBorph;
  insert into _r values (26,'G19 anti-vacuity: sweep DOES collect an aged UNREFERENCED object','0',v_n::text,v_n=0);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pFresh;
  insert into _r values (27,'G20 1-hour age guard (BUG B) intact: a FRESH unreferenced object survives','1',v_n::text,v_n=1);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name in (select name from _pre);
  insert into _r values (28,'G21 FINDING 5 real-world: the REAL live production avatar object survived the sweep',v_pre::text,v_n::text,v_n=v_pre);

  -- ===== the fail-safe =====
  -- reintroduce a URL-shaped value the only way it could ever happen post-migration (a restore, a
  -- hand-edit, a reverted client) — by going around the validation trigger.
  execute 'alter table public.members disable trigger members_validate_profile';
  update public.members set avatar_url = v_base||pA where id = uA;
  execute 'alter table public.members enable trigger members_validate_profile';

  begin perform private._sweep_orphan_avatars(); v_res:='SWEPT';
  exception when others then v_res := sqlstate; end;
  insert into _r values (29,'G22 FAIL-SAFE: one URL-shaped avatar_url makes the sweep RAISE, not delete','55000',v_res,v_res='55000');

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name = pA;
  insert into _r values (30,'G23 anti-vacuity: the object the aborted sweep would have destroyed is still present','1',v_n::text,v_n=1);
end
$green$;

-- ---------------------------------------------------------------------------
-- (4) VERDICT — raises on a NULL pass or an unexpected assertion count
-- ---------------------------------------------------------------------------
do $verdict$
declare v_n int;
begin
  select count(*) into v_n from _r;
  if v_n <> 30 then raise exception 'INCOMPLETE: % assertions recorded, expected 30', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value in _r'; end if;
end
$verdict$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;
