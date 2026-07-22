-- ============================================================================================
-- GUEST AVATAR OVER-EXPOSURE — scope the avatar predicate to the ROSTER's guest rule
-- ROLLED-BACK PROOF (13 assertions).  Migration: 20260722080911_guest_scoped_avatar_visibility.sql
-- STATUS: APPLIED 2026-07-22, after this proof ran 13/13 GREEN. Then re-run post-apply: 13/13.
--
-- ⚠ THIS FILE IS BUILT ON THE **REWIND** PATTERN, SO IT STAYS RE-RUNNABLE FOREVER.
--   Its RED phase demonstrates a leak the migration has since closed. Rather than let that rot into
--   an "expected failure" (the proof-lifecycle trap that bit five suites in the 2026-07-19 pass), the
--   pre-fix predicate is restored TRANSACTION-LOCALLY, RED proves the disease against it, then the
--   shipped body is re-applied and GREEN proves the cure. Nothing here commits.
--   NOTE the rewound body INLINES the old membership-overlap check rather than calling
--   `private.shares_workspace` — that helper was DROPPED by this migration precisely because it was
--   the last guest-blind visibility helper left. The inlined SQL is byte-equivalent to what it did.
--
-- ============================================================================================
-- THE DEFECT (found by the post-deploy audit of 20260722061442, confirmed by RUNNING against live)
-- ============================================================================================
-- `private.is_visible_avatar_object` gated on `private.shares_workspace` — plain membership overlap,
-- NO guest clause. So a GUEST could SELECT (hence sign a URL for) the avatar object of an ARBITRARY
-- co-member: someone the roster deliberately hides from them, and whose `members` row they cannot
-- read at all. Measured live: guest → non-peer avatar object = 1 row, while the SAME guest got 0
-- from `public.members` and 0 from `workspace_members_list`.
--
-- WHY, because the shape will recur: the helper is SECURITY DEFINER *on purpose* (a storage policy
-- whose correctness rides on another table's RLS is a coupling that breaks quietly). But DEFINER
-- means the guest exclusion baked into `public.members`' own policy no longer applies, so the share
-- check had to be restated by hand — and it reached for the PRE-2026-07-06 helper instead of the
-- guest-scoped rule that 20260706035653 introduced everywhere else. Contrast
-- `voice_notes_select_member`, a NON-definer EXISTS over `messages`, which inherits the guest
-- exclusion for free (verified: a guest reads 0 of a team-chat voice-note object).
--
-- THE FIX IS **NOT** `can_see_member_profile`. Its guest branch is `me.role <> 'guest'`, so for a
-- GUEST CALLER it collapses to `p_target = auth.uid()` — self only. That would have returned 0 for a
-- guest's genuine task/DM peers and degraded their faces to initials. R03 below pins the product
-- intent empirically: the roster DOES return those peers to the guest, so they must keep rendering.
-- ============================================================================================

begin;

create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role','authenticated','email', coalesce(v_email,''))::text, true);
end $fn$;
create function pg_temp.anon() returns void language plpgsql as $fn$
begin execute 'reset role'; execute 'set local role anon'; perform set_config('request.jwt.claims', null, true); end $fn$;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;
grant insert on _r to authenticated, anon;
create temp table _f(k text primary key, v text) on commit drop;

-- ---------------------------------------------------------------------------
-- (1) REWIND — restore the PRE-FIX predicate, transaction-locally
-- ---------------------------------------------------------------------------
create or replace function private.is_visible_avatar_object(p_name text) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.members m
     where m.avatar_url = p_name
       and (m.id = auth.uid()
            or exists (                       -- the dropped private.shares_workspace, inlined
              select 1 from public.workspace_members me
              join public.workspace_members them on them.workspace_id = me.workspace_id
              where me.user_id = auth.uid() and them.user_id = m.id))
  );
$fn$;

-- ---------------------------------------------------------------------------
-- (2) FIXTURES + RED
-- ---------------------------------------------------------------------------
do $red$
declare
  sfx text := replace(gen_random_uuid()::text,'-','');
  ws uuid := gen_random_uuid(); wsX uuid := gen_random_uuid();
  uO uuid := gen_random_uuid();   -- owner (non-guest co-member)
  uT uuid := gen_random_uuid();   -- TASK peer of the guest
  uD uuid := gen_random_uuid();   -- DM peer of the guest
  uN uuid := gen_random_uuid();   -- NON-peer co-member  <- the leak
  uG uuid := gen_random_uuid();   -- the GUEST
  uX uuid := gen_random_uuid();   -- outsider (other workspace)
  pO text; pT text; pD text; pN text; pG text;
  conv uuid := gen_random_uuid();
  v_n int; v_res text;
begin
  insert into auth.users (id,email,aud,role)
  select v, 'gfx-'||k||'-'||sfx||'@example.invalid','authenticated','authenticated'
  from (values ('o',uO),('t',uT),('d',uD),('n',uN),('g',uG),('x',uX)) s(k,v);

  insert into public.workspaces (id,name,owner_id,slug) values (ws,'GFX',uO,'gfx-'||sfx),(wsX,'GFXX',uX,'gfxx-'||sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (ws,uO,'owner'),(ws,uT,'member'),(ws,uD,'member'),(ws,uN,'member'),(ws,uG,'guest'),(wsX,uX,'owner');

  -- the guest shares a TASK with uT and a DM with uD, and NOTHING with uN
  insert into public.tasks (id,title,privacy,project,status,workspace_id,created_by,assignee_id)
  values ('gfx-t-'||sfx,'shared task','workspace','other','inbox',ws,uT,uG);
  insert into public.dm_conversations (id,workspace_id,user_lo,user_hi)
  values (conv, ws, least(uG,uD), greatest(uG,uD));

  pO := uO::text||'/'||sfx||'o.jpg'; pT := uT::text||'/'||sfx||'t.jpg';
  pD := uD::text||'/'||sfx||'d.jpg'; pN := uN::text||'/'||sfx||'n.jpg';
  pG := uG::text||'/'||sfx||'g.jpg';
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
  select 'avatars', v, u, u::text, jsonb_build_object('size',100,'mimetype','image/jpeg')
  from (values (pO,uO),(pT,uT),(pD,uD),(pN,uN),(pG,uG)) s(v,u);
  update public.members set avatar_url = pO where id=uO;
  update public.members set avatar_url = pT where id=uT;
  update public.members set avatar_url = pD where id=uD;
  update public.members set avatar_url = pN where id=uN;
  update public.members set avatar_url = pG where id=uG;

  insert into _f values ('uO',uO::text),('uT',uT::text),('uD',uD::text),('uN',uN::text),
                        ('uG',uG::text),('uX',uX::text),('ws',ws::text),
                        ('pO',pO),('pT',pT),('pD',pD),('pN',pN),('pG',pG);

  -- ===== HARNESS GUARD (raises, never records) =====
  perform pg_temp.imp(uG);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN role=%',current_user; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN bypassrls'; end if;
  if auth.uid() is distinct from uG then execute 'reset role'; raise exception 'HARNESS BROKEN uid'; end if;
  begin update public.members set email='ctl@x.test' where id=uG; v_res:='ALLOWED';
  exception when others then v_res:=sqlstate; end;
  if v_res <> '42501' then execute 'reset role'; raise exception 'HARNESS BROKEN control=%',v_res; end if;
  execute 'reset role';

  -- ===== ANTI-VACUITY: everything the assertions judge exists FIRST =====
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name in (pO,pT,pD,pN,pG);
  if v_n <> 5 then raise exception 'VACUOUS: %/5 objects planted', v_n; end if;
  select count(*) into v_n from public.members where id in (uO,uT,uD,uN,uG) and avatar_url is not null;
  if v_n <> 5 then raise exception 'VACUOUS: %/5 avatar_url references', v_n; end if;

  -- ===== RED, against the REWOUND predicate =====
  perform pg_temp.imp(uG);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pN;
  execute 'reset role';
  insert into _r values (1,'R01 [THE LEAK] under the pre-fix predicate a guest CAN select a NON-peer co-member''s avatar object','1 (leaking)',v_n::text,v_n=1);

  perform pg_temp.imp(uG);
  select count(*) into v_n from public.workspace_members_list(ws) where user_id=uN;
  execute 'reset role';
  insert into _r values (2,'R02 pair: the roster correctly HIDES that same non-peer from the guest (the inconsistency)','0',v_n::text,v_n=0);

  perform pg_temp.imp(uG);
  select count(*) into v_n from public.workspace_members_list(ws) where user_id in (uT,uD);
  execute 'reset role';
  insert into _r values (3,'R03 pair [PRODUCT INTENT] the roster DOES show the guest their task+DM peers - so those faces must keep rendering','2',v_n::text,v_n=2);
end
$red$;

-- ---------------------------------------------------------------------------
-- (3) THE SHIPPED FIX (re-applied; identical to the migration)
-- ---------------------------------------------------------------------------
create or replace function private.is_visible_avatar_object(p_name text) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.members m
     where m.avatar_url = p_name
       and private.can_see_member_avatar(m.id)
  );
$fn$;

-- ---------------------------------------------------------------------------
-- (4) GREEN
-- ---------------------------------------------------------------------------
do $green$
declare
  uG uuid := (select v from _f where k='uG')::uuid;
  uO uuid := (select v from _f where k='uO')::uuid;
  uX uuid := (select v from _f where k='uX')::uuid;
  pO text := (select v from _f where k='pO'); pT text := (select v from _f where k='pT');
  pD text := (select v from _f where k='pD'); pN text := (select v from _f where k='pN');
  pG text := (select v from _f where k='pG');
  v_n int;
begin
  perform pg_temp.imp(uG);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pN;
  execute 'reset role';
  insert into _r values (4,'G01 [CURE of R01] guest now selects ZERO of a NON-peer co-member''s avatar object','0',v_n::text,v_n=0);

  perform pg_temp.imp(uG);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pT;
  execute 'reset role';
  insert into _r values (5,'G02 [INTENDED] guest CAN still select their TASK-peer''s avatar (face keeps rendering)','1',v_n::text,v_n=1);

  perform pg_temp.imp(uG);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pD;
  execute 'reset role';
  insert into _r values (6,'G03 [INTENDED] guest CAN still select their DM-peer''s avatar','1',v_n::text,v_n=1);

  perform pg_temp.imp(uG);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pG;
  execute 'reset role';
  insert into _r values (7,'G04 guest can still select their OWN avatar object','1',v_n::text,v_n=1);

  perform pg_temp.imp(uG);
  select count(*) into v_n from storage.objects where bucket_id='avatars';
  execute 'reset role';
  insert into _r values (8,'G05 guest whole-bucket listing = exactly {own, task-peer, DM-peer} and nothing else','3',v_n::text,v_n=3);

  perform pg_temp.imp(uO);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name in (pN,pT,pD,pG);
  execute 'reset role';
  insert into _r values (9,'G06 UNCHANGED: a NON-guest co-member still sees every referenced avatar in the workspace','4',v_n::text,v_n=4);

  perform pg_temp.imp(uX);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name in (pO,pT,pD,pN,pG);
  execute 'reset role';
  insert into _r values (10,'G07 UNCHANGED: outsider still selects ZERO','0',v_n::text,v_n=0);

  perform pg_temp.anon();
  begin select count(*) into v_n from storage.objects where bucket_id='avatars'; exception when others then v_n:=-1; end;
  execute 'reset role';
  insert into _r values (11,'G08 UNCHANGED: anon selects ZERO','0',v_n::text,v_n<=0);
end
$green$;

-- ---------------------------------------------------------------------------
-- (5) ANTI-VACUITY MUTATION — revert ONLY the predicate; the leak must RETURN
-- ---------------------------------------------------------------------------
create or replace function private.is_visible_avatar_object(p_name text) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.members m
     where m.avatar_url = p_name
       and (m.id = auth.uid()
            or exists (
              select 1 from public.workspace_members me
              join public.workspace_members them on them.workspace_id = me.workspace_id
              where me.user_id = auth.uid() and them.user_id = m.id))
  );
$fn$;

do $mut$
declare
  uG uuid := (select v from _f where k='uG')::uuid;
  pN text := (select v from _f where k='pN');
  v_n int;
begin
  perform pg_temp.imp(uG);
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=pN;
  execute 'reset role';
  insert into _r values (12,'M01 [ANTI-VACUITY] reverting the predicate to plain membership overlap makes the non-peer leak RETURN','1 (leak returns)',v_n::text,v_n=1);
end
$mut$;

-- restore the SHIPPED body before the dead-code scan
create or replace function private.is_visible_avatar_object(p_name text) returns boolean
language sql stable security definer set search_path to '' as $fn$
  select exists (
    select 1 from public.members m
     where m.avatar_url = p_name
       and private.can_see_member_avatar(m.id)
  );
$fn$;

-- ---------------------------------------------------------------------------
-- (6) DEAD-CODE: the old helper is gone AND unreferenced
-- ---------------------------------------------------------------------------
do $dead$
declare v_n int;
begin
  select count(*) into v_n from (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where p.prokind='f' and n.nspname in ('public','private','storage')
       and pg_get_functiondef(p.oid) like '%shares_workspace%'
    union all
    select 1 from pg_policy pol
     where coalesce(pg_get_expr(pol.polqual,pol.polrelid),'')||coalesce(pg_get_expr(pol.polwithcheck,pol.polrelid),'') like '%shares_workspace%'
    union all
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='private' and p.proname='shares_workspace'
  ) s;
  insert into _r values (13,'D01 private.shares_workspace is DROPPED and has ZERO remaining references anywhere','0',v_n::text,v_n=0);
end
$dead$;

-- ---------------------------------------------------------------------------
-- (7) VERDICT
-- ---------------------------------------------------------------------------
do $verdict$
declare v_n int;
begin
  select count(*) into v_n from _r;
  if v_n <> 13 then raise exception 'INCOMPLETE: % rows, expected 13', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$verdict$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id,name,expected,actual,pass from _r order by id;

rollback;
