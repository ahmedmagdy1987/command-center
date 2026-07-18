-- ============================================================================
-- ANCHORED ROLE-TITLE MATCHING — ROLLED-BACK PROOF (31 assertions)
-- Proves migration 20260718195827_role_title_match_anchored.
-- VERIFIED GREEN live against nqlzjuxqgajeoypyzlnv on 2026-07-18: 31/31, 0 residue.
-- Run in ONE execute_sql call: begin; … rollback;
-- ============================================================================
-- Supersedes the 26-assertion draft in supabase/proposed/ (which carried a
-- DRAFT MARKER placeholder and was not runnable). Differences:
--   * The DDL under test sits at TOP LEVEL, not inside the DO block — a bare
--     CREATE OR REPLACE FUNCTION cannot execute inside plpgsql. DDL is
--     transactional, so it still rolls back.
--   * ADDED 3 RED anti-vacuity checks (the live substring rule must actually
--     exhibit the bug first, else the GREEN half proves nothing).
--   * ADDED an RLS-live control: as `authenticated`, a known-denied write to
--     another member's row must affect 0 rows. `postgres` here has
--     rolbypassrls=true, so a proof that forgets `set local role authenticated`
--     silently bypasses RLS and proves nothing.
--   * ADDED '-- Admin --' (decoration) and 'superuser' (W07 parity).
--   * ADDED a no-regression scan over every already-stored display_name /
--     status_text / workspace name.
--   * `grant insert on _r to authenticated` — scratch results table only; no
--     assertion depends on it.
-- ============================================================================

begin;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;
grant insert on _r to authenticated;

-- ===== (1) RED — anti-vacuity: the LIVE fn wrongly blocks innocent phrases =====
-- NOTE: these 3 pass only BEFORE the fix. Re-running this file against a DB that
-- already has the anchored rule applied will fail 1-3 by design — that is the
-- anti-vacuity guard doing its job, not a regression.
insert into _r values
 (1,'RED: live fn blocks ''staff meeting'' (the bug)','true',private._looks_like_role_title('staff meeting')::text,private._looks_like_role_title('staff meeting') = true),
 (2,'RED: live fn blocks ''Staffan'' (known false positive)','true',private._looks_like_role_title('Staffan')::text,private._looks_like_role_title('Staffan') = true),
 (3,'RED: live fn blocks ''verified the deploy''','true',private._looks_like_role_title('verified the deploy')::text,private._looks_like_role_title('verified the deploy') = true);

-- ===== (2) APPLY THE FIX — verbatim from 20260718195827 =====
create or replace function private._looks_like_role_title(p_text text) returns boolean
language sql immutable set search_path to '' as $fn$
  select p_text is not null
    and regexp_replace(lower(normalize(p_text, NFKC)), '[^a-z0-9]', '', 'g')
          ~ '^(the)?(workspace|team|site|app|global|super|sys)?(owner|admin|administrator|moderator|superadmin|sysadmin|superuser|founder|official|staff|verified)s?$';
$fn$;
revoke all on function private._looks_like_role_title(text) from public, anon, authenticated;

do $proof$
declare
  v_sfx text := replace(gen_random_uuid()::text,'-','');
  u1 uuid := gen_random_uuid();
  v_n int; v_actual text; v_stored text;
begin
  -- ===== (3) GREEN — still blocked (real impersonation + lookalikes) =====
  insert into _r values (4,'blocked: Admin','true',private._looks_like_role_title('Admin')::text,private._looks_like_role_title('Admin'));
  insert into _r values (5,'blocked: ADMIN!','true',private._looks_like_role_title('ADMIN!')::text,private._looks_like_role_title('ADMIN!'));
  insert into _r values (6,'blocked: A D M I N','true',private._looks_like_role_title('A D M I N')::text,private._looks_like_role_title('A D M I N'));
  insert into _r values (7,'blocked: fullwidth admin','true',private._looks_like_role_title('ａｄｍｉｎ')::text,private._looks_like_role_title('ａｄｍｉｎ'));
  insert into _r values (8,'blocked: math-bold Owner','true',private._looks_like_role_title('𝗢𝘄𝗻𝗲𝗿')::text,private._looks_like_role_title('𝗢𝘄𝗻𝗲𝗿'));
  insert into _r values (9,'blocked: Workspace Owner','true',private._looks_like_role_title('Workspace Owner')::text,private._looks_like_role_title('Workspace Owner'));
  insert into _r values (10,'blocked: The Admin','true',private._looks_like_role_title('The Admin')::text,private._looks_like_role_title('The Admin'));
  insert into _r values (11,'blocked: Admins (plural)','true',private._looks_like_role_title('Admins')::text,private._looks_like_role_title('Admins'));
  insert into _r values (12,'blocked: owner.','true',private._looks_like_role_title('owner.')::text,private._looks_like_role_title('owner.'));
  insert into _r values (13,'blocked: Verified','true',private._looks_like_role_title('Verified')::text,private._looks_like_role_title('Verified'));
  insert into _r values (14,'blocked: sysadmin','true',private._looks_like_role_title('sysadmin')::text,private._looks_like_role_title('sysadmin'));
  insert into _r values (15,'blocked: zero-width admin','true',private._looks_like_role_title('a'||chr(8203)||'d'||chr(8203)||'m'||chr(8203)||'i'||chr(8203)||'n')::text,private._looks_like_role_title('a'||chr(8203)||'d'||chr(8203)||'m'||chr(8203)||'i'||chr(8203)||'n'));
  insert into _r values (16,'blocked: superuser (expanded blocklist, W07 parity)','true',private._looks_like_role_title('superuser')::text,private._looks_like_role_title('superuser'));
  insert into _r values (17,'blocked: -- Admin -- (decoration stripped)','true',private._looks_like_role_title('-- Admin --')::text,private._looks_like_role_title('-- Admin --'));

  -- ===== (4) GREEN — now allowed (ordinary language + names) =====
  insert into _r values (18,'allowed: staff meeting','false',private._looks_like_role_title('staff meeting')::text,not private._looks_like_role_title('staff meeting'));
  insert into _r values (19,'allowed: verified the deploy','false',private._looks_like_role_title('verified the deploy')::text,not private._looks_like_role_title('verified the deploy'));
  insert into _r values (20,'allowed: on official leave','false',private._looks_like_role_title('on official leave')::text,not private._looks_like_role_title('on official leave'));
  insert into _r values (21,'allowed: Staffan','false',private._looks_like_role_title('Staffan')::text,not private._looks_like_role_title('Staffan'));
  insert into _r values (22,'allowed: Ahmed Magdy','false',private._looks_like_role_title('Ahmed Magdy')::text,not private._looks_like_role_title('Ahmed Magdy'));
  insert into _r values (23,'allowed: pinging the admin about it','false',private._looks_like_role_title('pinging the admin about it')::text,not private._looks_like_role_title('pinging the admin about it'));
  insert into _r values (24,'allowed: empty string','false',private._looks_like_role_title('')::text,not private._looks_like_role_title(''));
  -- documented residual, out of scope (matches W08/W09 in profile_and_avatar proof)
  insert into _r values (25,'residual (documented): Cyrillic confusable allowed','false',private._looks_like_role_title('оwner')::text,not private._looks_like_role_title('оwner'));

  -- ===== (5) END-TO-END through the live members_validate_profile trigger =====
  insert into auth.users (id,email,aud,role) values (u1,'rt-'||v_sfx||'@example.invalid','authenticated','authenticated');

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u1,'role','authenticated','email','rt-'||v_sfx||'@example.invalid')::text, true);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: bypassrls'; end if;

  update public.members set display_name='hijack' where id <> u1;
  get diagnostics v_n = row_count;
  insert into _r values (26,'CONTROL: RLS live — cannot update another member row','0 rows',v_n::text||' rows',v_n = 0);

  update public.members set status_text = 'staff meeting' where id = u1;
  get diagnostics v_n = row_count;
  execute 'reset role'; select status_text into v_stored from public.members where id=u1; execute 'set local role authenticated';
  insert into _r values (27,'e2e: status ''staff meeting'' saves + stored','1|staff meeting',v_n::text||'|'||coalesce(v_stored,'NULL'),v_n = 1 and v_stored='staff meeting');

  begin update public.members set status_text = 'Workspace Owner' where id = u1; v_actual:='ALLOWED';
  exception when sqlstate '42501' then v_actual:='42501'; when others then v_actual:=sqlstate; end;
  insert into _r values (28,'e2e: status ''Workspace Owner'' still rejected','42501',v_actual,v_actual='42501');

  begin update public.members set display_name = 'Admin' where id = u1; v_actual:='ALLOWED';
  exception when sqlstate '42501' then v_actual:='42501'; when others then v_actual:=sqlstate; end;
  insert into _r values (29,'e2e: display_name ''Admin'' still rejected','42501',v_actual,v_actual='42501');

  update public.members set display_name = 'Staffan' where id = u1;
  get diagnostics v_n = row_count;
  execute 'reset role'; select display_name into v_stored from public.members where id=u1; execute 'set local role authenticated';
  insert into _r values (30,'e2e: display_name ''Staffan'' saves + stored','1|Staffan',v_n::text||'|'||coalesce(v_stored,'NULL'),v_n = 1 and v_stored='Staffan');

  execute 'reset role';

  -- ===== (6) NO-REGRESSION: every already-stored value still passes the new rule =====
  select count(*) into v_n from (
    select display_name v from public.members where display_name is not null
    union all select status_text from public.members where status_text is not null
    union all select name from public.workspaces) s
  where private._looks_like_role_title(s.v);
  insert into _r values (31,'no-regression: 0 existing stored values newly blocked','0',v_n::text,v_n = 0);

  -- completeness guard
  select count(*) into v_n from _r;
  if v_n <> 31 then raise exception 'INCOMPLETE: % assertion rows, expected 31', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end $proof$;

select id, name, expected, actual, pass from _r order by id;
select count(*) filter (where pass) || '/' || count(*) as score, bool_and(pass) as all_green from _r;

rollback;
