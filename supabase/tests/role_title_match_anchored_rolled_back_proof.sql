-- ============================================================================================
-- ROLLED-BACK PROOF — anchored role-title matching (private._looks_like_role_title)
-- STATUS: RUN GREEN 31/31 on 2026-07-18 against nqlzjuxqgajeoypyzlnv, before applying. Shipped as
--         migration 20260718195827_role_title_match_anchored.sql. RESTRUCTURED with a REWIND
--         section after that migration went live, and re-run as a regression suite (32 assertions:
--         the 31 originals plus the rewind anti-vacuity control).
--
-- 32 assertions. NOTHING IS APPLIED. The whole file is one transaction ending in ROLLBACK.
--
-- Run the WHOLE file as ONE execute_sql call. Read the `failed` column of the result — a RED run
-- still returns success from execute_sql.
--
-- SHAPE (house convention):
--   (0) harness plumbing + synthetic fixtures + a harness that RAISES on a broken impersonation
--   (1) REWIND to the pre-fix (20260716110514) function body + an anti-vacuity assertion that the
--       rewind actually took effect
--   (2) the RED phase against those rewound rules
--   (3) the DDL UNDER TEST at TOP LEVEL — a bare CREATE OR REPLACE FUNCTION cannot run inside a
--       plpgsql DO block, and it must land AFTER the RED phase so RED really tests the old rules
--   (4) a GREEN phase: still-blocked, now-allowed, end-to-end through the live
--       members_validate_profile trigger, and a no-regression scan over already-stored values
--   (5) a VERDICT that RAISES on any NULL pass or an unexpected assertion count
--
-- FIXTURES ARE SYNTHETIC. The one actor is a gen_random_uuid() auth user created inside this
-- transaction; no live member, workspace or profile row is mutated. The no-regression scan at the
-- end READS live display names / statuses / workspace names — deliberately, that is its whole job —
-- but writes nothing.
--
-- METHODOLOGY (why the harness RAISES instead of recording): `postgres` on this project has
-- rolbypassrls = true, so an assertion that forgets `set local role authenticated` silently bypasses
-- RLS and proves nothing. The harness checks the ROLE PROPERTY, not just the role NAME, plus
-- auth.uid() and a known-denied control write, and aborts the run on failure — a control observable
-- only after the fact, in a table nobody re-reads, is not a control. Assertion 27 keeps the
-- RLS-live check as a RECORDED control as well, so the table itself carries the evidence.
--
-- `grant insert on _r to authenticated` — a session running as `authenticated` cannot insert into a
-- temp table created by `postgres`. Scratch results table only; no assertion depends on it.
--
-- LANDMINE (house rule, 20260718195827): this file RE-CREATES the DDL under test, in BOTH its
-- pre-fix and post-fix forms. So does supabase/tests/profile_and_avatar_rolled_back_proof.sql. If
-- this rule changes again, CHANGE IT IN ALL THREE PLACES — otherwise these suites silently prove a
-- body that no longer ships.
-- ============================================================================================

begin;

-- ---------------------------------------------------------------------------
-- (0) HARNESS PLUMBING + FIXTURES
-- ---------------------------------------------------------------------------
create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;
create temp table _f(k text primary key, v text) on commit drop;
grant insert on _r to authenticated;

create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role','authenticated','email', coalesce(v_email,''))::text, true);
end $fn$;

do $fixtures$
declare
  v_sfx text := replace(gen_random_uuid()::text,'-','');
  u1 uuid := gen_random_uuid();
begin
  -- handle_new_user stamps the matching public.members row; the e2e phase writes to that row only.
  insert into auth.users (id,email,aud,role)
    values (u1,'rt-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into _f values ('u1',u1::text),('sfx',v_sfx);
end $fixtures$;

-- ============================================================ HARNESS (aborts on failure)
do $harness$
declare u1 uuid; v_sfx text; v_state text; v_bypass boolean;
begin
  select v::uuid into u1    from _f where k='u1';
  select v      into v_sfx  from _f where k='sfx';

  perform pg_temp.imp(u1);

  if current_user <> 'authenticated' then
    execute 'reset role'; raise exception 'HARNESS BROKEN: role is %, expected authenticated', current_user;
  end if;

  -- The PROPERTY, not the name. This is the control the rolbypassrls lesson exists for.
  select rolbypassrls into v_bypass from pg_roles where rolname = current_user;
  if coalesce(v_bypass,true) then
    execute 'reset role'; raise exception 'HARNESS BROKEN: current role bypasses RLS';
  end if;

  if auth.uid() is distinct from u1 then
    execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid()=% expected %', auth.uid(), u1;
  end if;

  -- A write we KNOW is denied must be denied WITH 42501. `workspaces` is SELECT-only under RLS for
  -- authenticated (no INSERT policy, no INSERT grant), and the id/slug are freshly random, so a
  -- unique violation cannot masquerade as a denial.
  begin
    insert into public.workspaces (id,name,owner_id,slug)
      values (gen_random_uuid(),'RT control probe',u1,'rt-ctl-'||v_sfx);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  if v_state <> '42501' then
    raise exception 'HARNESS BROKEN: control write returned %, expected 42501 (RLS not engaged)', v_state;
  end if;
end $harness$;

-- ---------------------------------------------------------------------------
-- (1) REWIND — recreate the PRE-MIGRATION state
--
-- This file has TWO lifecycles, and they conflict. BEFORE 20260718195827 was applied, assertions
-- 2-4 demonstrated the substring bug against the then-live body; now that the migration is LIVE the
-- same three assertions are permanently false, and the file reported 3 failures on every run. They
-- were not regressions — they were a proof written for a world that no longer exists — but an
-- "expected red" is corrosive: nobody can tell it from a real one at a glance, and the suite stops
-- being a usable gate.
--
-- So REWIND first: restore a faithful copy of the pre-fix rule, transaction-locally, so RED can
-- still demonstrate the disease. THE DDL UNDER TEST below then re-applies the fix and GREEN
-- re-proves the cure — the arrangement that makes this a real regression suite rather than a
-- one-shot. All of it is inside the enclosing transaction and is undone by the final rollback.
--
-- The body below is 20260716110514's, reproduced EXACTLY: same NFKC fold, same separator strip, but
-- UNANCHORED, so any value merely CONTAINING a role word matched.
-- ---------------------------------------------------------------------------
create or replace function private._looks_like_role_title(p_text text) returns boolean
language sql immutable set search_path to '' as $fn$
  select p_text is not null
    and regexp_replace(lower(normalize(p_text, NFKC)), '[^a-z0-9]', '', 'g')
          ~ '(owner|admin|administrator|moderator|superadmin|sysadmin|superuser|founder|official|staff|verified)';
$fn$;
revoke all on function private._looks_like_role_title(text) from public, anon, authenticated;

-- Anti-vacuity for the RED phase. The three RED assertions are largely self-guarding (if the rewind
-- silently failed they would go red rather than pass), but "red for the wrong reason" is exactly the
-- failure mode this section exists to kill, so assert the rewound state STRUCTURALLY and by name.
-- If the function is missing entirely this inserts 0 rows and the VERDICT's count guard fires.
insert into _r
select 1,'REWIND: the unanchored substring rule is live, so RED can demonstrate the disease',
  'unanchored (no ^…$ anchors)',
  case when p.prosrc like '%^(the)?%' then 'ANCHORED — rewind did not take effect' else 'unanchored' end,
  p.prosrc not like '%^(the)?%'
  and p.prosrc like '%(owner|admin|administrator%'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'private' and p.proname = '_looks_like_role_title';

-- ---------------------------------------------------------------------------
-- (2) RED — the disease, demonstrated against the rewound rules
-- The old rule SUBSTRING-matched the folded/stripped text, so any value CONTAINING a role word was
-- rejected as impersonation: an ordinary status, an ordinary sentence, and a real human name.
-- ---------------------------------------------------------------------------
insert into _r values
 (2,'RED: pre-fix rule blocks ''staff meeting'' (the bug)','true',private._looks_like_role_title('staff meeting')::text,private._looks_like_role_title('staff meeting') = true),
 (3,'RED: pre-fix rule blocks ''Staffan'' (known false positive)','true',private._looks_like_role_title('Staffan')::text,private._looks_like_role_title('Staffan') = true),
 (4,'RED: pre-fix rule blocks ''verified the deploy''','true',private._looks_like_role_title('verified the deploy')::text,private._looks_like_role_title('verified the deploy') = true);

-- ---------------------------------------------------------------------------
-- (3) THE DDL UNDER TEST — verbatim from 20260718195827 (top level: a bare CREATE OR REPLACE
--     FUNCTION cannot execute inside a plpgsql DO block; DDL is transactional, so it still rolls back)
-- ---------------------------------------------------------------------------
create or replace function private._looks_like_role_title(p_text text) returns boolean
language sql immutable set search_path to '' as $fn$
  -- Anchored (^…$): the whole folded/stripped value must be a role title — optionally
  -- 'the'-prefixed, scope-prefixed, or pluralized — never merely contain one.
  select p_text is not null
    and regexp_replace(lower(normalize(p_text, NFKC)), '[^a-z0-9]', '', 'g')
          ~ '^(the)?(workspace|team|site|app|global|super|sys)?(owner|admin|administrator|moderator|superadmin|sysadmin|superuser|founder|official|staff|verified)s?$';
$fn$;
revoke all on function private._looks_like_role_title(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (4) GREEN
-- ---------------------------------------------------------------------------
do $green$
declare
  u1 uuid;
  v_n int; v_actual text; v_stored text;
begin
  select v::uuid into u1 from _f where k='u1';

  -- ===== still blocked (real impersonation + lookalikes) =====
  insert into _r values (5,'blocked: Admin','true',private._looks_like_role_title('Admin')::text,private._looks_like_role_title('Admin'));
  insert into _r values (6,'blocked: ADMIN!','true',private._looks_like_role_title('ADMIN!')::text,private._looks_like_role_title('ADMIN!'));
  insert into _r values (7,'blocked: A D M I N','true',private._looks_like_role_title('A D M I N')::text,private._looks_like_role_title('A D M I N'));
  insert into _r values (8,'blocked: fullwidth admin','true',private._looks_like_role_title('ａｄｍｉｎ')::text,private._looks_like_role_title('ａｄｍｉｎ'));
  insert into _r values (9,'blocked: math-bold Owner','true',private._looks_like_role_title('𝗢𝘄𝗻𝗲𝗿')::text,private._looks_like_role_title('𝗢𝘄𝗻𝗲𝗿'));
  insert into _r values (10,'blocked: Workspace Owner','true',private._looks_like_role_title('Workspace Owner')::text,private._looks_like_role_title('Workspace Owner'));
  insert into _r values (11,'blocked: The Admin','true',private._looks_like_role_title('The Admin')::text,private._looks_like_role_title('The Admin'));
  insert into _r values (12,'blocked: Admins (plural)','true',private._looks_like_role_title('Admins')::text,private._looks_like_role_title('Admins'));
  insert into _r values (13,'blocked: owner.','true',private._looks_like_role_title('owner.')::text,private._looks_like_role_title('owner.'));
  insert into _r values (14,'blocked: Verified','true',private._looks_like_role_title('Verified')::text,private._looks_like_role_title('Verified'));
  insert into _r values (15,'blocked: sysadmin','true',private._looks_like_role_title('sysadmin')::text,private._looks_like_role_title('sysadmin'));
  insert into _r values (16,'blocked: zero-width admin','true',private._looks_like_role_title('a'||chr(8203)||'d'||chr(8203)||'m'||chr(8203)||'i'||chr(8203)||'n')::text,private._looks_like_role_title('a'||chr(8203)||'d'||chr(8203)||'m'||chr(8203)||'i'||chr(8203)||'n'));
  insert into _r values (17,'blocked: superuser (expanded blocklist, W07 parity)','true',private._looks_like_role_title('superuser')::text,private._looks_like_role_title('superuser'));
  insert into _r values (18,'blocked: -- Admin -- (decoration stripped)','true',private._looks_like_role_title('-- Admin --')::text,private._looks_like_role_title('-- Admin --'));

  -- ===== now allowed (ordinary language + names) — the three RED cases, cured =====
  insert into _r values (19,'allowed: staff meeting','false',private._looks_like_role_title('staff meeting')::text,not private._looks_like_role_title('staff meeting'));
  insert into _r values (20,'allowed: verified the deploy','false',private._looks_like_role_title('verified the deploy')::text,not private._looks_like_role_title('verified the deploy'));
  insert into _r values (21,'allowed: on official leave','false',private._looks_like_role_title('on official leave')::text,not private._looks_like_role_title('on official leave'));
  insert into _r values (22,'allowed: Staffan','false',private._looks_like_role_title('Staffan')::text,not private._looks_like_role_title('Staffan'));
  insert into _r values (23,'allowed: Ahmed Magdy','false',private._looks_like_role_title('Ahmed Magdy')::text,not private._looks_like_role_title('Ahmed Magdy'));
  insert into _r values (24,'allowed: pinging the admin about it','false',private._looks_like_role_title('pinging the admin about it')::text,not private._looks_like_role_title('pinging the admin about it'));
  insert into _r values (25,'allowed: empty string','false',private._looks_like_role_title('')::text,not private._looks_like_role_title(''));
  -- documented residual, out of scope (matches W08/W09 in profile_and_avatar proof)
  insert into _r values (26,'residual (documented): Cyrillic confusable allowed','false',private._looks_like_role_title('оwner')::text,not private._looks_like_role_title('оwner'));

  -- ===== END-TO-END through the live members_validate_profile trigger =====
  perform pg_temp.imp(u1);

  -- Recorded twin of the harness control: as `authenticated`, another member's row is not writable.
  update public.members set display_name='hijack' where id <> u1;
  get diagnostics v_n = row_count;
  insert into _r values (27,'CONTROL: RLS live — cannot update another member row','0 rows',v_n::text||' rows',v_n = 0);

  update public.members set status_text = 'staff meeting' where id = u1;
  get diagnostics v_n = row_count;
  execute 'reset role'; select status_text into v_stored from public.members where id=u1; perform pg_temp.imp(u1);
  insert into _r values (28,'e2e: status ''staff meeting'' saves + stored','1|staff meeting',v_n::text||'|'||coalesce(v_stored,'NULL'),v_n = 1 and v_stored='staff meeting');

  begin update public.members set status_text = 'Workspace Owner' where id = u1; v_actual:='ALLOWED';
  exception when sqlstate '42501' then v_actual:='42501'; when others then v_actual:=sqlstate; end;
  insert into _r values (29,'e2e: status ''Workspace Owner'' still rejected','42501',v_actual,v_actual='42501');

  begin update public.members set display_name = 'Admin' where id = u1; v_actual:='ALLOWED';
  exception when sqlstate '42501' then v_actual:='42501'; when others then v_actual:=sqlstate; end;
  insert into _r values (30,'e2e: display_name ''Admin'' still rejected','42501',v_actual,v_actual='42501');

  update public.members set display_name = 'Staffan' where id = u1;
  get diagnostics v_n = row_count;
  execute 'reset role'; select display_name into v_stored from public.members where id=u1;
  insert into _r values (31,'e2e: display_name ''Staffan'' saves + stored','1|Staffan',v_n::text||'|'||coalesce(v_stored,'NULL'),v_n = 1 and v_stored='Staffan');

  -- ===== NO-REGRESSION: every already-stored value still passes the new rule =====
  -- The anchored rule is strictly NARROWER than the rewound one, so this can only ever shrink; the
  -- scan is what turns "can only ever" into evidence, over real stored values rather than fixtures.
  select count(*) into v_n from (
    select display_name v from public.members where display_name is not null
    union all select status_text from public.members where status_text is not null
    union all select name from public.workspaces) s
  where private._looks_like_role_title(s.v);
  insert into _r values (32,'no-regression: 0 existing stored values newly blocked','0',v_n::text,v_n = 0);
end $green$;

-- ---------------------------------------------------------------------------
-- (5) VERDICT
-- ---------------------------------------------------------------------------
do $verdict$
declare v_total int; v_null int; v_fail int;
begin
  select count(*), count(*) filter (where pass is null), count(*) filter (where pass is false)
    into v_total, v_null, v_fail from _r;
  -- A NULL pass is counted by NEITHER "passed" nor "failed" in a naive tally, so a broken assertion
  -- can read green. Guard it explicitly. (NB: raising here aborts before the diagnostic SELECTs
  -- below, so on INCOMPLETE you get the error string, not the table — deliberate fail-loud.)
  if v_null > 0    then raise exception 'INCOMPLETE: % assertion(s) returned NULL pass', v_null; end if;
  if v_total <> 32 then raise exception 'INCOMPLETE: % assertion rows, expected 32', v_total; end if;
  if v_fail > 0    then raise notice 'RED: % assertion(s) FAILED — read the table below', v_fail; end if;
end $verdict$;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from _r;

select id, name, expected, actual, pass from _r order by id;

rollback;
