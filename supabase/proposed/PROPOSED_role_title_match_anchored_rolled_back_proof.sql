-- ============================================================================
-- PROPOSED PROOF — anchored role-title matching — ROLLED-BACK (26 assertions)
-- Run in ONE execute_sql call (MCP session): begin; ... rollback;
-- NOT YET RUN against the live DB (drafted 2026-07-18, session without MCP).
-- Companion of PROPOSED_role_title_match_anchored.sql.
-- ============================================================================

begin;

create temp table _r(id int primary key, name text, expected boolean, actual boolean, pass boolean) on commit drop;

do $proof$
declare
  v_sfx text := replace(gen_random_uuid()::text,'-','');
  u1 uuid := gen_random_uuid();
  v_n int; v_ok boolean;
begin
  -- ===== (1) RED — anti-vacuity: the LIVE fn wrongly blocks innocent phrases =====
  insert into _r values (1,'RED: live fn blocks ''staff meeting'' (the bug)', true, private._looks_like_role_title('staff meeting'), private._looks_like_role_title('staff meeting') = true);
  insert into _r values (2,'RED: live fn blocks ''Staffan'' (known false positive)', true, private._looks_like_role_title('Staffan'), private._looks_like_role_title('Staffan') = true);

  -- ===== (2) APPLY THE FIX (the proposed DDL, verbatim) =====
  -- <<< paste the CREATE OR REPLACE from PROPOSED_role_title_match_anchored.sql here when
  --     running live; kept out of this draft so there is exactly ONE copy of the DDL >>>
  raise exception 'DRAFT MARKER: paste the anchored-rule DDL above this line before running';

  -- ===== (3) GREEN — still blocked (real impersonation + lookalikes) =====
  insert into _r values (3,'blocked: Admin',            true, private._looks_like_role_title('Admin'),            private._looks_like_role_title('Admin'));
  insert into _r values (4,'blocked: ADMIN!',           true, private._looks_like_role_title('ADMIN!'),           private._looks_like_role_title('ADMIN!'));
  insert into _r values (5,'blocked: A D M I N',        true, private._looks_like_role_title('A D M I N'),        private._looks_like_role_title('A D M I N'));
  insert into _r values (6,'blocked: fullwidth admin',  true, private._looks_like_role_title('ａｄｍｉｎ'),        private._looks_like_role_title('ａｄｍｉｎ'));
  insert into _r values (7,'blocked: math-bold admin',  true, private._looks_like_role_title('𝗮𝗱𝗺𝗶𝗻'),        private._looks_like_role_title('𝗮𝗱𝗺𝗶𝗻'));
  insert into _r values (8,'blocked: Workspace Owner',  true, private._looks_like_role_title('Workspace Owner'),  private._looks_like_role_title('Workspace Owner'));
  insert into _r values (9,'blocked: The Admin',        true, private._looks_like_role_title('The Admin'),        private._looks_like_role_title('The Admin'));
  insert into _r values (10,'blocked: Admins (plural)', true, private._looks_like_role_title('Admins'),           private._looks_like_role_title('Admins'));
  insert into _r values (11,'blocked: owner.',          true, private._looks_like_role_title('owner.'),           private._looks_like_role_title('owner.'));
  insert into _r values (12,'blocked: Verified',        true, private._looks_like_role_title('Verified'),         private._looks_like_role_title('Verified'));
  insert into _r values (13,'blocked: sysadmin',        true, private._looks_like_role_title('sysadmin'),         private._looks_like_role_title('sysadmin'));
  insert into _r values (14,'blocked: zero-width admin',true, private._looks_like_role_title('ad' || chr(8203) || 'min'), private._looks_like_role_title('ad' || chr(8203) || 'min'));

  -- ===== (4) GREEN — now allowed (ordinary language + names) =====
  insert into _r values (15,'allowed: staff meeting',        false, private._looks_like_role_title('staff meeting'),        not private._looks_like_role_title('staff meeting'));
  insert into _r values (16,'allowed: verified the deploy',  false, private._looks_like_role_title('verified the deploy'),  not private._looks_like_role_title('verified the deploy'));
  insert into _r values (17,'allowed: on official leave',    false, private._looks_like_role_title('on official leave'),    not private._looks_like_role_title('on official leave'));
  insert into _r values (18,'allowed: Staffan',              false, private._looks_like_role_title('Staffan'),              not private._looks_like_role_title('Staffan'));
  insert into _r values (19,'allowed: Ahmed Magdy',          false, private._looks_like_role_title('Ahmed Magdy'),          not private._looks_like_role_title('Ahmed Magdy'));
  insert into _r values (20,'allowed: pinging the admin about it', false, private._looks_like_role_title('pinging the admin about it'), not private._looks_like_role_title('pinging the admin about it'));
  insert into _r values (21,'allowed: empty string',         false, private._looks_like_role_title(''),                     not private._looks_like_role_title(''));

  -- Residuals stay residual (documented in the original design; W08/W09 analogues):
  insert into _r values (22,'residual: Cyrillic confusable still allowed', false, private._looks_like_role_title('Аdmin'), not private._looks_like_role_title('Аdmin'));

  -- ===== (5) END-TO-END through the trigger, as authenticated =====
  insert into auth.users (id,email,aud,role) values (u1,'rt-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.members (id,email,display_name,role) values (u1,'rt-'||v_sfx||'@example.invalid','RT Test','member');

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated','email','rt-'||v_sfx||'@example.invalid')::text, true);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: bypassrls'; end if;

  -- innocent status now saves
  update public.members set status_text = 'staff meeting' where id = u1;
  get diagnostics v_n = row_count;
  insert into _r values (23,'e2e: status ''staff meeting'' saves', true, v_n = 1, v_n = 1);

  -- impersonation status still rejected 42501
  begin
    update public.members set status_text = 'Workspace Owner' where id = u1;
    insert into _r values (24,'e2e: status ''Workspace Owner'' rejected', true, false, false);
  exception when sqlstate '42501' then
    insert into _r values (24,'e2e: status ''Workspace Owner'' rejected', true, true, true);
  end;

  -- impersonation display_name still rejected 42501 (change-gated path)
  begin
    update public.members set display_name = 'Admin' where id = u1;
    insert into _r values (25,'e2e: display_name ''Admin'' rejected', true, false, false);
  exception when sqlstate '42501' then
    insert into _r values (25,'e2e: display_name ''Admin'' rejected', true, true, true);
  end;

  -- ordinary display_name saves
  update public.members set display_name = 'Staffan' where id = u1;
  get diagnostics v_n = row_count;
  insert into _r values (26,'e2e: display_name ''Staffan'' saves', true, v_n = 1, v_n = 1);

  execute 'reset role';
end $proof$;

select id, name, expected, actual, pass from _r order by id;
select count(*) filter (where pass) || '/' || count(*) as score from _r;

rollback;
