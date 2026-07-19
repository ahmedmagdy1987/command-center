-- ============================================================================================
-- ROLLED-BACK PROOF — invitation email-confirm guard (`private._accept_invitation`)
-- STATUS: RUN GREEN 17/17 on 2026-07-18 against nqlzjuxqgajeoypyzlnv, before applying. Shipped as
--         migration 20260718195854_accept_invitation_email_confirm_guard.sql. RESTRUCTURED with a
--         REWIND section after that migration went live, and re-run GREEN 18/18 as a regression suite.
--
-- 18 assertions. NOTHING IS APPLIED. The whole file is one transaction ending in ROLLBACK.
--
-- Run the WHOLE file as ONE execute_sql call. Read the `failed` column of the result — a RED run
-- still returns success from execute_sql.
--
-- SHAPE (house convention):
--   (0) harness plumbing + SYNTHETIC fixtures
--   (1) HARNESS GUARD — raises, never records
--   (2) REWIND to the pre-fix (20260602041903) function body + an anti-vacuity assertion that the
--       rewind actually took effect
--   (3) the RED phase against those rewound rules
--   (4) the DDL UNDER TEST at TOP LEVEL — a bare CREATE OR REPLACE FUNCTION cannot run inside a
--       plpgsql DO block, and it must land AFTER the RED phase so RED really tests the old rules
--   (5) a GREEN phase re-proving the cure plus the full regression surface
--   (6) a VERDICT that RAISES on any NULL pass or an unexpected assertion count
--
-- FIXTURES ARE SYNTHETIC. Every actor, workspace and invitation is gen_random_uuid()-derived and
-- created inside this transaction — including the INVITER, which earlier revisions of this file took
-- from `select id from auth.users order by created_at limit 1`, i.e. a live human. No live member,
-- workspace or invitation is read or mutated. (Assertion 16 counts live unconfirmed accounts, but it
-- only COUNTS: that environmental fact is the whole point of the assertion.)
--
-- Denial assertions pin SQLSTATE **and** message text. That matters more than usual here: the new
-- guard deliberately reuses 42501, the SAME sqlstate as the pre-existing 'not authenticated' raise
-- four lines above it. Asserting the code alone would pass with the guard deleted.
--
-- Harness facts learned live and worth keeping:
--   * `invitations` carries UNIQUE (workspace_id, lower(email)) WHERE status='pending'
--     (`invitations_one_pending`) — so the expired-invite fixture must live in a SECOND throwaway
--     workspace or setup dies with 23505.
--   * `grant insert on _r to authenticated` — a session running as `authenticated` cannot write a
--     temp table created by `postgres`, and the failed insert would abort the whole suite. Scratch
--     table only; no assertion depends on its grants.
--   * `postgres` here has rolbypassrls=true, so the harness guard (role name + the rolbypassrls
--     PROPERTY + auth.uid() + a known-denied control write) is what makes every assertion meaningful.
--
-- Fixtures are planted as the service role to CONSTRUCT the scenario; every ASSERTION runs as
-- `authenticated` through the PUBLIC accept_invitation wrapper, so the real invoker→definer path is
-- under test.
--
-- LANDMINE (house rule, 20260718195827): this file RE-CREATES the DDL under test, in BOTH its
-- pre-fix and post-fix forms. If the shipped migration's body, grants or raise messages change,
-- CHANGE THEM HERE TOO — otherwise this suite silently proves a body that no longer ships.
-- ============================================================================================

begin;

-- ---------------------------------------------------------------------------
-- (0) HARNESS PLUMBING + SYNTHETIC FIXTURES
-- ---------------------------------------------------------------------------
create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;
grant insert, select on _r to authenticated;

do $setup$ begin perform set_config('proof.sfx', replace(gen_random_uuid()::text,'-',''), true); end $setup$;

do $s$
declare
  sfx text := current_setting('proof.sfx');
  ws uuid := gen_random_uuid(); ws2 uuid := gen_random_uuid();
  inviter uuid := gen_random_uuid();
begin
  -- The inviter is SYNTHETIC and email-confirmed. handle_new_user (AFTER INSERT on auth.users)
  -- creates the public.members rows for all four.
  insert into auth.users (id,email,aud,role,email_confirmed_at) values
    (inviter,'ecg-inviter-'||sfx||'@example.invalid','authenticated','authenticated',now()),
    (('11111111-0000-0000-0000-'||left(sfx,12))::uuid,'unconf-a-'||sfx||'@example.invalid','authenticated','authenticated',null),
    (('22222222-0000-0000-0000-'||left(sfx,12))::uuid,'unconf-b-'||sfx||'@example.invalid','authenticated','authenticated',null),
    (('33333333-0000-0000-0000-'||left(sfx,12))::uuid,'conf-'||sfx||'@example.invalid','authenticated','authenticated',now());

  insert into public.workspaces (id,name,owner_id,slug) values
    (ws,'ECG Proof WS',inviter,'ecg-proof-'||left(sfx,8)),
    (ws2,'ECG Proof WS2',inviter,'ecg-proof2-'||left(sfx,8));
  insert into public.workspace_members (workspace_id,user_id,role) values (ws,inviter,'owner'),(ws2,inviter,'owner');
  perform set_config('proof.ws', ws::text, true);
  perform set_config('proof.inviter', inviter::text, true);

  -- expired invite goes in ws2: invitations_one_pending forbids a 2nd pending invite
  -- for the same (workspace, email) as the guest invite below.
  insert into public.invitations (workspace_id,email,role,token,status,invited_by,expires_at) values
    (ws, 'unconf-a-'||sfx||'@example.invalid','member',('aaaaaaaa-0000-0000-0000-'||left(sfx,12))::uuid,'pending',inviter,now()+interval '7 days'),
    (ws, 'unconf-b-'||sfx||'@example.invalid','member',('bbbbbbbb-0000-0000-0000-'||left(sfx,12))::uuid,'pending',inviter,now()+interval '7 days'),
    (ws, 'conf-'||sfx||'@example.invalid','guest', ('cccccccc-0000-0000-0000-'||left(sfx,12))::uuid,'pending',inviter,now()+interval '7 days'),
    (ws, 'someone-else-'||sfx||'@example.invalid','member',('dddddddd-0000-0000-0000-'||left(sfx,12))::uuid,'pending',inviter,now()+interval '7 days'),
    (ws2,'conf-'||sfx||'@example.invalid','member',('eeeeeeee-0000-0000-0000-'||left(sfx,12))::uuid,'pending',inviter,now()-interval '1 day'),
    (ws, 'conf-'||sfx||'@example.invalid','member',('ffffffff-0000-0000-0000-'||left(sfx,12))::uuid,'revoked',inviter,now()+interval '7 days');
end $s$;

-- ---------------------------------------------------------------------------
-- (1) HARNESS GUARD — RAISES, never records
--
-- postgres has rolbypassrls=true on this project, so a proof that forgets to switch role proves
-- NOTHING. All four checks abort the run rather than recording a pass: a control observable only
-- after the fact, in a table nobody re-reads, is not a control.
-- ---------------------------------------------------------------------------
do $harness$
declare
  sfx text := current_setting('proof.sfx');
  ws uuid := current_setting('proof.ws')::uuid;
  u_conf uuid := ('33333333-0000-0000-0000-'||left(sfx,12))::uuid;
  v_bypass boolean; v_state text;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u_conf,'role','authenticated')::text, true);

  if current_user <> 'authenticated' then
    execute 'reset role'; raise exception 'HARNESS BROKEN: role is %, expected authenticated', current_user;
  end if;

  -- The PROPERTY, not the name. This is the control the rolbypassrls lesson exists for.
  select rolbypassrls into v_bypass from pg_roles where rolname = current_user;
  if coalesce(v_bypass,true) then
    execute 'reset role'; raise exception 'HARNESS BROKEN: current role bypasses RLS';
  end if;

  if auth.uid() is distinct from u_conf then
    execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid()=% expected %', auth.uid(), u_conf;
  end if;

  -- A write we KNOW is denied must be denied WITH 42501. workspace_members is SELECT-only under RLS
  -- (create_workspace / accept_invitation are its sole write paths), and this user holds no row in
  -- that workspace, so a unique violation cannot masquerade as a denial. If RLS were being bypassed
  -- this would SUCCEED — and it would also hand the caller the very membership row the whole guard
  -- exists to withhold, making every assertion below fake.
  begin
    insert into public.workspace_members (workspace_id,user_id,role) values (ws,u_conf,'owner');
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  if v_state <> '42501' then
    raise exception 'HARNESS BROKEN: control write returned %, expected 42501 (RLS is not gating)', v_state;
  end if;
end $harness$;

-- ---------------------------------------------------------------------------
-- (2) REWIND — recreate the PRE-MIGRATION state
--
-- This file has TWO lifecycles, and they conflict. BEFORE 20260718195854 was applied it demonstrated
-- a missing guard against the then-live body; now that the migration is LIVE it has to serve as a
-- re-runnable REGRESSION suite. The RED phase below has an unconfirmed account accept an invitation
-- and asserts that it WORKS — which the live guard now correctly rejects with 42501, so on every
-- post-apply run two assertions went red BY DESIGN. Expected failures are corrosive: nobody can tell
-- an expected red from a real one at a glance, and the suite stops being a usable gate.
--
-- So REWIND first: restore a faithful copy of the pre-fix rules, transaction-locally, so RED can
-- still demonstrate the disease. THE DDL UNDER TEST below then re-applies the fix and GREEN re-proves
-- the cure — the arrangement that makes this a real regression suite rather than a one-shot. All of
-- it is inside the enclosing transaction and is undone by the final rollback.
--
-- The body below is 20260602041903's, reproduced EXACTLY (that migration is the last one to touch
-- this function before the fix; verified by grep across supabase/migrations). It differs from the
-- shipped body in exactly one way: it never reads email_confirmed_at and never raises on it.
-- ---------------------------------------------------------------------------
create or replace function private._accept_invitation(p_token uuid)
returns public.workspaces language plpgsql security definer set search_path = '' as $$
declare inv public.invitations; v_email text; ws public.workspaces;
begin
  select email into v_email from auth.users where id = (select auth.uid());
  if v_email is null then raise exception 'not authenticated' using errcode = '42501'; end if;

  -- NO EMAIL-CONFIRM GUARD HERE. That absence IS the disease; assertions 2-3 pin it.

  select * into inv from public.invitations where token = p_token for update;
  if inv.id is null then raise exception 'invitation not found' using errcode = 'P0002'; end if;
  if inv.status = 'revoked' then raise exception 'this invitation was revoked'; end if;
  if inv.status = 'accepted' then
    select * into ws from public.workspaces where id = inv.workspace_id; return ws;   -- idempotent
  end if;
  if inv.expires_at <= now() then raise exception 'this invitation has expired'; end if;
  if lower(inv.email) <> lower(v_email) then raise exception 'this invitation is for a different email'; end if;

  if not exists (select 1 from public.workspace_members where workspace_id = inv.workspace_id and user_id = (select auth.uid())) then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (inv.workspace_id, (select auth.uid()), inv.role);
  end if;
  update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = (select auth.uid()) where id = inv.id;
  select * into ws from public.workspaces where id = inv.workspace_id;
  return ws;
end; $$;
revoke all on function private._accept_invitation(uuid) from public;
grant execute on function private._accept_invitation(uuid) to authenticated;

-- ANTI-VACUITY for the whole RED phase, and the replacement for the old "1-2 pass only BEFORE the
-- fix" disclaimer. If the rewind silently failed, RED would be attacking the FIXED body and would go
-- red for entirely the wrong reason. Assert the rewound state explicitly instead. This assertion is
-- true in BOTH worlds (pre-apply the guard was never there; post-apply the rewind removes it), so it
-- is a real control rather than a historical claim.
insert into _r
select 1,'REWIND: pre-fix body restored — the email-confirm guard is absent from the live definition',
  'absent',
  case when position('confirm your email address before accepting an invitation' in pg_get_functiondef(p.oid)) > 0
       then 'PRESENT (rewind failed)' else 'absent' end,
  position('confirm your email address before accepting an invitation' in pg_get_functiondef(p.oid)) = 0
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'private' and p.proname = '_accept_invitation';

-- ---------------------------------------------------------------------------
-- (3) RED — the disease, against the REWOUND (pre-fix) rules
-- ---------------------------------------------------------------------------
do $red$
declare
  sfx text := current_setting('proof.sfx');
  u uuid := ('11111111-0000-0000-0000-'||left(sfx,12))::uuid;
  v_actual text; v_n int;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: bypassrls'; end if;

  begin perform public.accept_invitation(('aaaaaaaa-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  execute 'reset role';
  insert into _r values (2,'RED: pre-fix body lets an UNCONFIRMED email accept (the gap)','ACCEPTED',v_actual,v_actual='ACCEPTED');

  select count(*) into v_n from public.workspace_members where workspace_id=current_setting('proof.ws')::uuid and user_id=u;
  insert into _r values (3,'RED: and it created the membership row (real tenant access, not a no-op)','1',v_n::text,v_n=1);
end $red$;

-- ---------------------------------------------------------------------------
-- (4) THE DDL UNDER TEST — top level (a bare CREATE OR REPLACE cannot run in a DO block).
--     Byte-identical to the shipped 20260718195854. Rolled back with everything else at the end.
-- ---------------------------------------------------------------------------
create or replace function private._accept_invitation(p_token uuid)
returns public.workspaces language plpgsql security definer set search_path = '' as $$
declare inv public.invitations; v_email text; v_confirmed timestamptz; ws public.workspaces;
begin
  select email, email_confirmed_at into v_email, v_confirmed
    from auth.users where id = (select auth.uid());
  if v_email is null then raise exception 'not authenticated' using errcode = '42501'; end if;

  -- THE FIX — defense-in-depth: the invite is EMAIL-BOUND, so the binding is only as
  -- strong as the email's verification. Checked before the token is even looked at,
  -- so an unconfirmed account learns nothing about any token's validity.
  if v_confirmed is null then
    raise exception 'confirm your email address before accepting an invitation' using errcode = '42501';
  end if;

  select * into inv from public.invitations where token = p_token for update;
  if inv.id is null then raise exception 'invitation not found' using errcode = 'P0002'; end if;
  if inv.status = 'revoked' then raise exception 'this invitation was revoked'; end if;
  if inv.status = 'accepted' then
    select * into ws from public.workspaces where id = inv.workspace_id; return ws;   -- idempotent
  end if;
  if inv.expires_at <= now() then raise exception 'this invitation has expired'; end if;
  if lower(inv.email) <> lower(v_email) then raise exception 'this invitation is for a different email'; end if;

  if not exists (select 1 from public.workspace_members where workspace_id = inv.workspace_id and user_id = (select auth.uid())) then
    insert into public.workspace_members (workspace_id, user_id, role)
    values (inv.workspace_id, (select auth.uid()), inv.role);
  end if;
  update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = (select auth.uid()) where id = inv.id;
  select * into ws from public.workspaces where id = inv.workspace_id;
  return ws;
end; $$;
revoke all on function private._accept_invitation(uuid) from public;
grant execute on function private._accept_invitation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- (5) GREEN — the cure, plus the full regression surface
-- ---------------------------------------------------------------------------
do $green$
declare
  sfx text := current_setting('proof.sfx'); ws uuid := current_setting('proof.ws')::uuid;
  u_unconf uuid := ('22222222-0000-0000-0000-'||left(sfx,12))::uuid;
  u_conf   uuid := ('33333333-0000-0000-0000-'||left(sfx,12))::uuid;
  v_actual text; v_n int; v_role text; v_status text; v_by uuid;
  c_guard constant text := '42501:confirm your email address before accepting an invitation';
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u_unconf,'role','authenticated')::text, true);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN'; end if;

  -- 4. The RED scenario, now dead. Pins the MESSAGE as well as 42501: 'not authenticated' four lines
  -- above the guard raises the SAME sqlstate, so a code-only assertion would pass with the guard gone.
  begin perform public.accept_invitation(('bbbbbbbb-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (4,'unconfirmed email REJECTED — EXACT sqlstate AND message',c_guard,v_actual,v_actual=c_guard);

  -- 5. guard runs BEFORE the token lookup, so a garbage token yields no P0002 validity oracle
  begin perform public.accept_invitation(gen_random_uuid()); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (5,'guard precedes token lookup (no P0002 oracle)',c_guard,v_actual,v_actual=c_guard);
  execute 'reset role';

  -- 6-7. the rejection is atomic: no membership, no invitation state change
  select count(*) into v_n from public.workspace_members where workspace_id=ws and user_id=u_unconf;
  insert into _r values (6,'unconfirmed created NO membership row','0',v_n::text,v_n=0);
  select status into v_status from public.invitations where token=('bbbbbbbb-0000-0000-0000-'||left(sfx,12))::uuid;
  insert into _r values (7,'unconfirmed left the invitation pending (not burned)','pending',v_status,v_status='pending');

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u_conf,'role','authenticated')::text, true);

  -- 8. ANTI-VACUITY for the whole denial block: the guard rejects the UNCONFIRMED, not everybody.
  begin perform public.accept_invitation(('cccccccc-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (8,'anti-vacuity: a CONFIRMED email still ACCEPTS (no regression)','ACCEPTED',v_actual,v_actual='ACCEPTED');

  begin perform public.accept_invitation(('cccccccc-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (9,'idempotent re-accept still returns the workspace','ACCEPTED',v_actual,v_actual='ACCEPTED');

  begin perform public.accept_invitation(('eeeeeeee-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlerrm; end;
  insert into _r values (10,'expired invite still rejected','this invitation has expired',v_actual,v_actual='this invitation has expired');

  begin perform public.accept_invitation(('ffffffff-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlerrm; end;
  insert into _r values (11,'revoked invite still rejected','this invitation was revoked',v_actual,v_actual='this invitation was revoked');

  begin perform public.accept_invitation(('dddddddd-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlerrm; end;
  insert into _r values (12,'email-binding still enforced (wrong-email invite)','this invitation is for a different email',v_actual,
    v_actual='this invitation is for a different email');
  execute 'reset role';

  select role into v_role from public.workspace_members where workspace_id=ws and user_id=u_conf;
  insert into _r values (13,'invite-as-role preserved: joined as guest','guest',coalesce(v_role,'NULL'),v_role='guest');
  select status, accepted_by into v_status, v_by from public.invitations where token=('cccccccc-0000-0000-0000-'||left(sfx,12))::uuid;
  insert into _r values (14,'invitation accepted + accepted_by = caller','accepted|caller',
    v_status||'|'||(case when v_by=u_conf then 'caller' else coalesce(v_by::text,'NULL') end), v_status='accepted' and v_by=u_conf);

  -- 15. the guard must not SHADOW the pre-existing not-authenticated path. Same sqlstate, different
  -- message — the pair (4, 15) is what proves the two raises are still distinct.
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims','{}', true);
  begin perform public.accept_invitation(('bbbbbbbb-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (15,'unauthenticated still 42501 not authenticated','42501:not authenticated',v_actual,v_actual='42501:not authenticated');
  execute 'reset role';

  -- 16. Environmental: the guard locks out any account that never confirmed. Excludes this proof's
  -- two synthetic unconfirmed fixtures. A red here is a REAL signal (a live unconfirmed account now
  -- exists and cannot accept invites), not a proof defect.
  select count(*) into v_n from auth.users where email_confirmed_at is null and id not in
    (('11111111-0000-0000-0000-'||left(sfx,12))::uuid, ('22222222-0000-0000-0000-'||left(sfx,12))::uuid);
  insert into _r values (16,'no real user locked out (0 pre-existing unconfirmed)','0',v_n::text,v_n=0);

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='private' and p.proname='_accept_invitation' and p.prosecdef
     and array_to_string(p.proconfig,',') like '%search_path=%';
  insert into _r values (17,'DEFINER + search_path survives CREATE OR REPLACE','1',v_n::text,v_n=1);

  -- `expected` reads 'true|false', not 't|f': has_function_privilege()::text renders the long form,
  -- and an expected/actual pair that does not visibly agree on a PASSING row trains readers to
  -- skim the columns. The pass boolean was always computed from the privileges themselves.
  insert into _r values (18,'EXECUTE authenticated-only','true|false',
    has_function_privilege('authenticated','private._accept_invitation(uuid)','execute')::text||'|'||
    has_function_privilege('anon','private._accept_invitation(uuid)','execute')::text,
    has_function_privilege('authenticated','private._accept_invitation(uuid)','execute')
    and not has_function_privilege('anon','private._accept_invitation(uuid)','execute'));
end $green$;

-- ---------------------------------------------------------------------------
-- (6) VERDICT — raises on a NULL pass or an unexpected assertion count
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
  if v_total <> 18 then raise exception 'INCOMPLETE: % assertion rows, expected 18', v_total; end if;
  if v_fail > 0    then raise notice 'RED: % assertion(s) FAILED — read the table below', v_fail; end if;
end $verdict$;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from _r;

select id, name, expected, actual, pass from _r order by id;

rollback;
