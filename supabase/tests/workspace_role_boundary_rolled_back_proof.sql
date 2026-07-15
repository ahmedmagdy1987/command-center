-- ============================================================================
-- WORKSPACE-ROLE BOUNDARY PROOF — CORRECTED  (owner > admin > member > guest)
-- 138 assertions. Rolled back. Verified green against nqlzjuxqgajeoypyzlnv.
--
-- Corrections vs the reviewed 125-assertion version (all verified live):
--   FIX 1  Harness impersonation guard. probe/probe_val/probe_msg refuse to run unless
--          current_user='authenticated'. Without this, group A (A01-A07) passes VERBATIM as
--          the service role — private.workspace_role* are SECURITY DEFINER and read
--          request.jwt.claims, not the session role — so a dropped `set local role
--          authenticated` would silently degrade an RLS proof into a bypass-RLS test.
--          PROVEN: as postgres with claims set, A01->3 / A05->0 / A06->'guest', identical.
--   FIX 2  A00 (guard fires err:P0001 when not impersonated) + A08 (current_user is
--          'authenticated' inline). A00 is the meta-assertion that FIX 1 is live.
--   FIX 3  Group O — comments (9). The reviewed script left these unasserted and leaned on
--          "they inherit task RLS transitively". Now proven, not assumed: comments_select_visible
--          is EXISTS(SELECT 1 FROM tasks t WHERE t.id=comments.task_id) — safe only because
--          tasks.id is a globally-unique TEXT PK. O02/O04 prove privacy (not rank) walls off
--          admin AND member from a private task's comments.
--   FIX 4  The four service-role read-backs (M02/M04/M20/N02) use probe_val_root, which REFUSES
--          to run impersonated. Previously they used the same probe_val as the RLS assertions,
--          so a stray `set local role authenticated` would have turned a bypass-RLS read-back
--          into an RLS-filtered one and silently changed its meaning.
--   FIX 5  M09/M11/M12 relabelled + M21/M22 added. Those three were labelled "self-escalation"
--          but trip an EARLIER guard. PROVEN by sqlerrm: admin self->owner raises "admins cannot
--          modify owners or admins" (target-rank guard); member/guest self->up raises "only an
--          owner or admin can change roles" (caller-rank gate). The self-escalation branch
--          `if p_user = auth.uid() and v_new_rank > v_caller_rank` in private._set_member_role is
--          UNREACHABLE dead code: rank<2 callers trip gate 1; rank-2 callers trip the target-rank
--          or the new-rank>=2 guard; a rank-3 owner can never request v_new_rank > 3. Defence in
--          depth, not a vuln — but the reviewed proof did NOT prove what it claimed for those 3.
--
-- Throwaway namespace (all rolled back):
--   WS = 0e5aa5e0-0000-4000-8000-000000000000  (slug zz-role-proof-throwaway)
--   O=..a1 owner  A=..a2 admin  M=..a3 member  G=..a4 guest
--   O2=..a5 second owner (last-owner test)  X=..a6 outsider  A2=..a7 second admin
--   invitation ..b1
--
-- SAFETY: no COMMIT anywhere; every write is inside this transaction. A mid-script error aborts
-- the txn and skips to ROLLBACK — nothing can commit. `on commit drop` on the temp table means a
-- one-word edit (rollback -> commit) would silently COMMIT the throwaway rows into prod: ALWAYS
-- run the residue check below afterwards.
--
-- POST-RUN RESIDUE CHECK (must be all zeros):
--   select (select count(*) from auth.users where id::text like '0e5aa5e0%') as users,
--          (select count(*) from public.workspaces where slug='zz-role-proof-throwaway') as ws,
--          (select count(*) from public.tasks where id like 'rp-%') as tasks,
--          (select count(*) from public.invitations where email like '%roleproof.test') as invs;
-- ============================================================================
begin;

-- ---------------------------------------------------------------- harness ---
create temporary table role_proof(
  id text primary key, name text, expected text, actual text, pass boolean
) on commit drop;
grant select, insert on role_proof to authenticated;

-- FIX 1: any probe that runs while impersonation is NOT in effect fails loudly (err:P0001).
create or replace function pg_temp.guard() returns void language plpgsql as $fn$
begin
  if current_user <> 'authenticated' then
    raise exception 'IMPERSONATION LOST: current_user=%', current_user using errcode='P0001';
  end if;
end $fn$;

-- run a statement as the CURRENT (impersonated) role -> 'ok:<rowcount>' | 'err:<sqlstate>'
create or replace function pg_temp.probe(p_sql text) returns text
language plpgsql as $fn$
declare n bigint;
begin
  perform pg_temp.guard();
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok:' || n;
exception when others then
  return 'err:' || sqlstate;
end $fn$;

-- evaluate a scalar select as the CURRENT role -> its text value | 'err:<sqlstate>'
create or replace function pg_temp.probe_val(p_sql text) returns text
language plpgsql as $fn$
declare v text;
begin
  perform pg_temp.guard();
  execute p_sql into v;
  return coalesce(v::text, '<null>');
exception when others then
  return 'err:' || sqlstate;
end $fn$;

-- like probe, but returns '<sqlstate>|<message>' so we can assert WHICH guard fired
create or replace function pg_temp.probe_msg(p_sql text) returns text
language plpgsql as $fn$
begin
  perform pg_temp.guard();
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate || '|' || sqlerrm;
end $fn$;

-- FIX 4: deliberate service-role read-back (verifies an RPC's EFFECT past RLS).
-- Refuses to run impersonated, so it can never be silently confused with an RLS assertion.
create or replace function pg_temp.probe_val_root(p_sql text) returns text
language plpgsql as $fn$
declare v text;
begin
  if current_user = 'authenticated' then
    raise exception 'root probe ran impersonated' using errcode='P0001';
  end if;
  execute p_sql into v;
  return coalesce(v::text, '<null>');
exception when others then
  return 'err:' || sqlstate;
end $fn$;

create or replace function pg_temp.rec(p_id text, p_name text, p_expected text, p_actual text)
returns text language plpgsql as $fn$
begin
  insert into pg_temp.role_proof(id, name, expected, actual, pass)
  values (p_id, p_name, p_expected, p_actual, p_actual is not distinct from p_expected);
  return p_id;
end $fn$;

-- ------------------------------------------------------------------ setup ---
-- throwaway auth users (on_auth_user_created -> handle_new_user creates the members rows)
insert into auth.users (id, email) values
  ('0e5aa5e0-0000-4000-8000-0000000000a1','rp-owner@roleproof.test'),
  ('0e5aa5e0-0000-4000-8000-0000000000a2','rp-admin@roleproof.test'),
  ('0e5aa5e0-0000-4000-8000-0000000000a3','rp-member@roleproof.test'),
  ('0e5aa5e0-0000-4000-8000-0000000000a4','rp-guest@roleproof.test'),
  ('0e5aa5e0-0000-4000-8000-0000000000a5','rp-owner2@roleproof.test'),
  ('0e5aa5e0-0000-4000-8000-0000000000a6','rp-outsider@roleproof.test'),
  ('0e5aa5e0-0000-4000-8000-0000000000a7','rp-admin2@roleproof.test');

insert into public.workspaces (id, name, owner_id, slug)
values ('0e5aa5e0-0000-4000-8000-000000000000','Role Proof WS',
        '0e5aa5e0-0000-4000-8000-0000000000a1','zz-role-proof-throwaway');

create or replace function pg_temp.reset_roles() returns void language plpgsql as $fn$
begin
  delete from public.workspace_members where workspace_id='0e5aa5e0-0000-4000-8000-000000000000';
  insert into public.workspace_members (workspace_id, user_id, role) values
    ('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a1','owner'),
    ('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a2','admin'),
    ('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','member'),
    ('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a4','guest'),
    ('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a7','admin');
end $fn$;

create or replace function pg_temp.reseed() returns void language plpgsql as $fn$
begin
  delete from public.notifications    where workspace_id='0e5aa5e0-0000-4000-8000-000000000000';
  delete from public.dm_conversations where workspace_id='0e5aa5e0-0000-4000-8000-000000000000';
  delete from public.invitations      where workspace_id='0e5aa5e0-0000-4000-8000-000000000000';
  delete from public.comments         where workspace_id='0e5aa5e0-0000-4000-8000-000000000000';
  delete from public.messages         where workspace_id='0e5aa5e0-0000-4000-8000-000000000000';
  delete from public.tasks            where workspace_id='0e5aa5e0-0000-4000-8000-000000000000';
  delete from public.projects         where workspace_id='0e5aa5e0-0000-4000-8000-000000000000';

  insert into public.projects (id,name,color,icon,created_by,workspace_id)
  values ('rp-proj-1','Role Proof Project','#64748b','#',
          '0e5aa5e0-0000-4000-8000-0000000000a1','0e5aa5e0-0000-4000-8000-000000000000');

  insert into public.tasks (id,title,privacy,project,status,created_by,assignee_id,workspace_id) values
   ('rp-t-owner','owner ws task','workspace','rp-proj-1','inbox',
     '0e5aa5e0-0000-4000-8000-0000000000a1','0e5aa5e0-0000-4000-8000-0000000000a1','0e5aa5e0-0000-4000-8000-000000000000'),
   ('rp-t-member','member ws task','workspace','rp-proj-1','inbox',
     '0e5aa5e0-0000-4000-8000-0000000000a3','0e5aa5e0-0000-4000-8000-0000000000a3','0e5aa5e0-0000-4000-8000-000000000000'),
   ('rp-t-guest','guest own task','workspace','rp-proj-1','inbox',
     '0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-000000000000'),
   ('rp-t-unassigned','unassigned ws task','workspace','rp-proj-1','inbox',
     '0e5aa5e0-0000-4000-8000-0000000000a1',null,'0e5aa5e0-0000-4000-8000-000000000000'),
   ('rp-t-priv-owner','owner private task','private','rp-proj-1','inbox',
     '0e5aa5e0-0000-4000-8000-0000000000a1','0e5aa5e0-0000-4000-8000-0000000000a1','0e5aa5e0-0000-4000-8000-000000000000'),
   ('rp-t-guest-asgn','task assigned to guest','workspace','rp-proj-1','inbox',
     '0e5aa5e0-0000-4000-8000-0000000000a1','0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-000000000000');

  insert into public.messages (sender_id, body, workspace_id)
  values ('0e5aa5e0-0000-4000-8000-0000000000a1','team chat baseline','0e5aa5e0-0000-4000-8000-000000000000');

  -- FIX 3: comment fixtures — one on a member ws task, one on the guest's own task,
  -- one on the owner's PRIVATE task (the privacy-inheritance probe).
  insert into public.comments (task_id, author_id, body, workspace_id) values
   ('rp-t-member','0e5aa5e0-0000-4000-8000-0000000000a3','c on member task','0e5aa5e0-0000-4000-8000-000000000000'),
   ('rp-t-guest','0e5aa5e0-0000-4000-8000-0000000000a4','c on guest task','0e5aa5e0-0000-4000-8000-000000000000'),
   ('rp-t-priv-owner','0e5aa5e0-0000-4000-8000-0000000000a1','c on owner private','0e5aa5e0-0000-4000-8000-000000000000');
end $fn$;

select pg_temp.reset_roles();
select pg_temp.reseed();

-- =====================================================================
-- A. ROLE RESOLUTION + HARNESS INTEGRITY
-- =====================================================================
reset role;
-- FIX 2 / A00: proves the guard is live. A01-A07 alone do NOT prove impersonation.
select pg_temp.rec('A00','HARNESS: probe refuses to run when impersonation is not in effect','err:P0001',
  pg_temp.probe($p$select 1$p$));

set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('A01','owner  -> workspace_role_rank = 3','3',
  pg_temp.probe_val($p$select private.workspace_role_rank('0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('A02','owner  -> workspace_role = owner','owner',
  pg_temp.probe_val($p$select private.workspace_role('0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('A08','HARNESS: impersonation IS in effect (current_user)','authenticated',
  pg_temp.probe_val($p$select current_user$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('A03','admin  -> workspace_role_rank = 2','2',
  pg_temp.probe_val($p$select private.workspace_role_rank('0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('A04','member -> workspace_role_rank = 1','1',
  pg_temp.probe_val($p$select private.workspace_role_rank('0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('A05','guest  -> workspace_role_rank = 0','0',
  pg_temp.probe_val($p$select private.workspace_role_rank('0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('A06','guest  -> workspace_role = guest','guest',
  pg_temp.probe_val($p$select private.workspace_role('0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('A07','outsider -> workspace_role_rank = -1 (no membership)','-1',
  pg_temp.probe_val($p$select private.workspace_role_rank('0e5aa5e0-0000-4000-8000-000000000000')$p$));

-- =====================================================================
-- B. TASK VISIBILITY  (tasks_select_role: membership AND privacy AND guest scope)
-- =====================================================================
reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('B01','owner sees all 5 workspace tasks + own private = 6','6',
  pg_temp.probe_val($p$select count(*) from public.tasks where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('B02','admin sees the 5 workspace tasks (not owner private) = 5','5',
  pg_temp.probe_val($p$select count(*) from public.tasks where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('B03','admin CANNOT read owner private task (rank does not beat privacy)','0',
  pg_temp.probe_val($p$select count(*) from public.tasks where id='rp-t-priv-owner'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('B04','member sees the 5 workspace tasks = 5','5',
  pg_temp.probe_val($p$select count(*) from public.tasks where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('B05','member CANNOT read owner private task','0',
  pg_temp.probe_val($p$select count(*) from public.tasks where id='rp-t-priv-owner'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('B06','guest sees ONLY own + assigned = 2','2',
  pg_temp.probe_val($p$select count(*) from public.tasks where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('B07','guest CANNOT read another member workspace task','0',
  pg_temp.probe_val($p$select count(*) from public.tasks where id='rp-t-member'$p$));
select pg_temp.rec('B08','guest CAN read the task assigned to them','1',
  pg_temp.probe_val($p$select count(*) from public.tasks where id='rp-t-guest-asgn'$p$));

-- =====================================================================
-- O. COMMENTS  (FIX 3 — inheritance PROVEN, not assumed)
-- comments_select_visible = EXISTS(SELECT 1 FROM tasks t WHERE t.id=comments.task_id):
-- no workspace check of its own; safe ONLY because tasks.id is a globally-unique TEXT PK.
-- =====================================================================
reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('O01','member CAN read the comment on a visible workspace task','1',
  pg_temp.probe_val($p$select count(*) from public.comments where task_id='rp-t-member'$p$));
select pg_temp.rec('O02','member CANNOT read the comment on the owner PRIVATE task (privacy inherited)','0',
  pg_temp.probe_val($p$select count(*) from public.comments where task_id='rp-t-priv-owner'$p$));
select pg_temp.rec('O03','member CANNOT forge comment author_id','err:42501',
  pg_temp.probe($p$insert into public.comments (task_id,author_id,body,workspace_id)
   values ('rp-t-member','0e5aa5e0-0000-4000-8000-0000000000a1','forged','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('O04','admin CANNOT read the comment on the owner PRIVATE task (rank does not beat privacy, transitively)','0',
  pg_temp.probe_val($p$select count(*) from public.comments where task_id='rp-t-priv-owner'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('O05','guest CANNOT read the comment on a task they cannot see','0',
  pg_temp.probe_val($p$select count(*) from public.comments where task_id='rp-t-member'$p$));
select pg_temp.rec('O06','guest CAN read the comment on their OWN task','1',
  pg_temp.probe_val($p$select count(*) from public.comments where task_id='rp-t-guest'$p$));
select pg_temp.rec('O07','guest CANNOT comment on a task they cannot see','err:42501',
  pg_temp.probe($p$insert into public.comments (task_id,author_id,body,workspace_id)
   values ('rp-t-member','0e5aa5e0-0000-4000-8000-0000000000a4','sneak','0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('O08','guest CAN comment on their OWN task','ok:1',
  pg_temp.probe($p$insert into public.comments (task_id,author_id,body,workspace_id)
   values ('rp-t-guest','0e5aa5e0-0000-4000-8000-0000000000a4','mine','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('O09','outsider reads NO comments','0',
  pg_temp.probe_val($p$select count(*) from public.comments where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

-- =====================================================================
-- C. TASK INSERT  (guest self-assign floor + V-2 created_by pin)
-- C01/C02 are a differential pair: identical row shape, only created_by differs.
-- =====================================================================
reset role;
select pg_temp.reseed();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('C01','member CAN create a workspace task assigned to someone else','ok:1',
  pg_temp.probe($p$insert into public.tasks (id,title,privacy,project,status,created_by,assignee_id,workspace_id)
   values ('rp-c01','m creates for owner','workspace','rp-proj-1','inbox',
   '0e5aa5e0-0000-4000-8000-0000000000a3','0e5aa5e0-0000-4000-8000-0000000000a1','0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('C02','member CANNOT forge created_by (V-2 pin)','err:42501',
  pg_temp.probe($p$insert into public.tasks (id,title,privacy,project,status,created_by,assignee_id,workspace_id)
   values ('rp-c02','forged author','workspace','rp-proj-1','inbox',
   '0e5aa5e0-0000-4000-8000-0000000000a1','0e5aa5e0-0000-4000-8000-0000000000a3','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('C03','admin CAN create a workspace task assigned to a member','ok:1',
  pg_temp.probe($p$insert into public.tasks (id,title,privacy,project,status,created_by,assignee_id,workspace_id)
   values ('rp-c03','a creates for member','workspace','rp-proj-1','inbox',
   '0e5aa5e0-0000-4000-8000-0000000000a2','0e5aa5e0-0000-4000-8000-0000000000a3','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('C04','guest CAN create a SELF-assigned task','ok:1',
  pg_temp.probe($p$insert into public.tasks (id,title,privacy,project,status,created_by,assignee_id,workspace_id)
   values ('rp-c04','guest self task','workspace','rp-proj-1','inbox',
   '0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('C05','guest CANNOT create a task assigned to someone else','err:42501',
  pg_temp.probe($p$insert into public.tasks (id,title,privacy,project,status,created_by,assignee_id,workspace_id)
   values ('rp-c05','guest assigns out','workspace','rp-proj-1','inbox',
   '0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-0000000000a3','0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('C06','guest CAN create a self-assigned PRIVATE task','ok:1',
  pg_temp.probe($p$insert into public.tasks (id,title,privacy,project,status,created_by,assignee_id,workspace_id)
   values ('rp-c06','guest private','private','rp-proj-1','inbox',
   '0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('C07','outsider CANNOT create a task in the workspace','err:42501',
  pg_temp.probe($p$insert into public.tasks (id,title,privacy,project,status,created_by,assignee_id,workspace_id)
   values ('rp-c07','outsider task','workspace','rp-proj-1','inbox',
   '0e5aa5e0-0000-4000-8000-0000000000a6','0e5aa5e0-0000-4000-8000-0000000000a6','0e5aa5e0-0000-4000-8000-000000000000')$p$));

-- =====================================================================
-- D. TASK UPDATE  (member/guest = own or assigned only; admin+ = any)
-- D02 pairs with D04, D03 with E06, D07 with D01/D06 — every deny has a matching allow,
-- so an 'ok:0' can never be a vacuous "row didn't exist".
-- =====================================================================
reset role;
select pg_temp.reseed();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('D01','member CAN update their OWN task','ok:1',
  pg_temp.probe($p$update public.tasks set title='edited by member' where id='rp-t-member'$p$));
select pg_temp.rec('D02','member CANNOT update the owner workspace task','ok:0',
  pg_temp.probe($p$update public.tasks set title='hacked' where id='rp-t-owner'$p$));
select pg_temp.rec('D03','member CANNOT update an UNASSIGNED workspace task they did not create','ok:0',
  pg_temp.probe($p$update public.tasks set title='hacked' where id='rp-t-unassigned'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('D04','admin CAN update any workspace task','ok:1',
  pg_temp.probe($p$update public.tasks set title='edited by admin' where id='rp-t-owner'$p$));
select pg_temp.rec('D05','admin CANNOT update the owner PRIVATE task','ok:0',
  pg_temp.probe($p$update public.tasks set title='hacked' where id='rp-t-priv-owner'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('D06','owner CAN update any workspace task','ok:1',
  pg_temp.probe($p$update public.tasks set title='edited by owner' where id='rp-t-member'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('D07','guest CANNOT update another member task (own/assigned rule, same path as D02)','ok:0',
  pg_temp.probe($p$update public.tasks set title='hacked' where id='rp-t-member'$p$));
select pg_temp.rec('D08','guest CAN update their OWN task','ok:1',
  pg_temp.probe($p$update public.tasks set title='edited by guest' where id='rp-t-guest'$p$));

-- =====================================================================
-- E. TASK DELETE  (same ladder as update)
-- =====================================================================
reset role;
select pg_temp.reseed();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('E01','member CANNOT delete the owner workspace task','ok:0',
  pg_temp.probe($p$delete from public.tasks where id='rp-t-owner'$p$));
select pg_temp.rec('E02','member CAN delete their OWN task','ok:1',
  pg_temp.probe($p$delete from public.tasks where id='rp-t-member'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('E03','guest CANNOT delete an unassigned workspace task','ok:0',
  pg_temp.probe($p$delete from public.tasks where id='rp-t-unassigned'$p$));
select pg_temp.rec('E04','guest CAN delete their OWN task','ok:1',
  pg_temp.probe($p$delete from public.tasks where id='rp-t-guest'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('E05','admin CAN delete any workspace task','ok:1',
  pg_temp.probe($p$delete from public.tasks where id='rp-t-owner'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('E06','owner CAN delete any workspace task','ok:1',
  pg_temp.probe($p$delete from public.tasks where id='rp-t-unassigned'$p$));

-- =====================================================================
-- F. PROJECTS  (guest excluded; member CRU; delete = owner+admin only)
-- Live policy is projects_delete_admin (rank>=2) — NOT the projects_delete_owner named in CLAUDE.md.
-- =====================================================================
reset role;
select pg_temp.reseed();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('F01','owner sees projects','1',
  pg_temp.probe_val($p$select count(*) from public.projects where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('F02','admin sees projects','1',
  pg_temp.probe_val($p$select count(*) from public.projects where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('F03','member sees projects','1',
  pg_temp.probe_val($p$select count(*) from public.projects where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('F04','member CAN create a project','ok:1',
  pg_temp.probe($p$insert into public.projects (id,name,color,icon,created_by,workspace_id)
   values ('rp-p-m','member project','#64748b','#','0e5aa5e0-0000-4000-8000-0000000000a3','0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('F05','member CAN rename a project','ok:1',
  pg_temp.probe($p$update public.projects set name='renamed by member' where id='rp-proj-1'$p$));
select pg_temp.rec('F06','member CANNOT delete a project (pairs with F10: same row, admin CAN)','ok:0',
  pg_temp.probe($p$delete from public.projects where id='rp-proj-1'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('F07','guest sees NO projects','0',
  pg_temp.probe_val($p$select count(*) from public.projects where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('F08','guest CANNOT create a project','err:42501',
  pg_temp.probe($p$insert into public.projects (id,name,color,icon,created_by,workspace_id)
   values ('rp-p-g','guest project','#64748b','#','0e5aa5e0-0000-4000-8000-0000000000a4','0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('F09','guest CANNOT delete a project','ok:0',
  pg_temp.probe($p$delete from public.projects where id='rp-proj-1'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('F10','admin CAN delete a project','ok:1',
  pg_temp.probe($p$delete from public.projects where id='rp-proj-1'$p$));

reset role;
select pg_temp.reseed();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('F11','owner CAN delete a project','ok:1',
  pg_temp.probe($p$delete from public.projects where id='rp-proj-1'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('F12','outsider CANNOT create a project in the workspace','err:42501',
  pg_temp.probe($p$insert into public.projects (id,name,color,icon,created_by,workspace_id)
   values ('rp-p-x','outsider project','#64748b','#','0e5aa5e0-0000-4000-8000-0000000000a6','0e5aa5e0-0000-4000-8000-000000000000')$p$));

-- =====================================================================
-- G. TEAM CHAT  (messages: guest excluded entirely; sender pinned)
-- =====================================================================
reset role;
select pg_temp.reseed();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('G01','owner reads team chat','1',
  pg_temp.probe_val($p$select count(*) from public.messages where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('G02','admin reads team chat','1',
  pg_temp.probe_val($p$select count(*) from public.messages where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('G03','member reads team chat','1',
  pg_temp.probe_val($p$select count(*) from public.messages where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('G04','member CAN post to team chat','ok:1',
  pg_temp.probe($p$insert into public.messages (sender_id, body, workspace_id)
   values ('0e5aa5e0-0000-4000-8000-0000000000a3','hi from member','0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('G05','member CANNOT forge sender_id','err:42501',
  pg_temp.probe($p$insert into public.messages (sender_id, body, workspace_id)
   values ('0e5aa5e0-0000-4000-8000-0000000000a1','forged sender','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('G06','guest reads NOTHING from team chat','0',
  pg_temp.probe_val($p$select count(*) from public.messages where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('G07','guest CANNOT post to team chat','err:42501',
  pg_temp.probe($p$insert into public.messages (sender_id, body, workspace_id)
   values ('0e5aa5e0-0000-4000-8000-0000000000a4','hi from guest','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('G08','outsider reads NOTHING from team chat','0',
  pg_temp.probe_val($p$select count(*) from public.messages where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

-- =====================================================================
-- H. DIRECT MESSAGES  (guest CAN DM; participant-gated)
-- =====================================================================
reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('H01','guest CAN open a DM with the owner','ok:1',
  pg_temp.probe($p$select public.get_or_create_dm_conversation(
    '0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a1')$p$));
select pg_temp.rec('H02','guest CAN send a DM','ok:1',
  pg_temp.probe($p$insert into public.dm_messages (conversation_id, workspace_id, sender_id, body)
   select c.id,'0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a4','hi from guest'
   from public.dm_conversations c where c.workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('H03','guest reads their own DM thread','1',
  pg_temp.probe_val($p$select count(*) from public.dm_messages where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('H04','guest CANNOT DM a non-member (outsider)','err:42501',
  pg_temp.probe($p$select public.get_or_create_dm_conversation(
    '0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a6')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('H05','admin (non-participant) reads NO DM messages','0',
  pg_temp.probe_val($p$select count(*) from public.dm_messages where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('H06','admin (non-participant) reads NO DM conversations','0',
  pg_temp.probe_val($p$select count(*) from public.dm_conversations where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

-- =====================================================================
-- I. INVITATIONS  (create/revoke/list = owner+admin; invite-as-role <= member|guest)
-- =====================================================================
reset role;
select pg_temp.reseed();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('I01','owner CAN invite as member','ok:1',
  pg_temp.probe($p$select public.create_invitation('0e5aa5e0-0000-4000-8000-000000000000','rp-inv1@roleproof.test','member')$p$));
select pg_temp.rec('I02','owner CANNOT invite as owner (owner/admin only via set_member_role)','err:42501',
  pg_temp.probe($p$select public.create_invitation('0e5aa5e0-0000-4000-8000-000000000000','rp-inv3@roleproof.test','owner')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('I03','admin CAN invite as guest','ok:1',
  pg_temp.probe($p$select public.create_invitation('0e5aa5e0-0000-4000-8000-000000000000','rp-inv2@roleproof.test','guest')$p$));
select pg_temp.rec('I04','admin CANNOT invite as admin','err:42501',
  pg_temp.probe($p$select public.create_invitation('0e5aa5e0-0000-4000-8000-000000000000','rp-inv4@roleproof.test','admin')$p$));
select pg_temp.rec('I05','admin CAN list the workspace invitations','2',
  pg_temp.probe_val($p$select count(*) from public.invitations where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('I06','member CANNOT invite','err:42501',
  pg_temp.probe($p$select public.create_invitation('0e5aa5e0-0000-4000-8000-000000000000','rp-inv5@roleproof.test','member')$p$));
select pg_temp.rec('I07','member CANNOT list the workspace invitations','0',
  pg_temp.probe_val($p$select count(*) from public.invitations where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('I08','guest CANNOT invite','err:42501',
  pg_temp.probe($p$select public.create_invitation('0e5aa5e0-0000-4000-8000-000000000000','rp-inv6@roleproof.test','member')$p$));
select pg_temp.rec('I09','guest CANNOT list the workspace invitations','0',
  pg_temp.probe_val($p$select count(*) from public.invitations where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('I10','outsider CANNOT invite into the workspace','err:42501',
  pg_temp.probe($p$select public.create_invitation('0e5aa5e0-0000-4000-8000-000000000000','rp-inv7@roleproof.test','member')$p$));

-- deterministic invitation id, seeded as postgres, so the revoke probes hit the RANK gate
-- (a subquery for the id would be RLS-filtered to 0 rows for member/guest and raise P0002 instead)
reset role;
insert into public.invitations (id, workspace_id, email, role, invited_by)
values ('0e5aa5e0-0000-4000-8000-0000000000b1','0e5aa5e0-0000-4000-8000-000000000000',
        'rp-inv8@roleproof.test','member','0e5aa5e0-0000-4000-8000-0000000000a1');

set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('I11','member CANNOT revoke an invitation','err:42501',
  pg_temp.probe($p$select public.revoke_invitation('0e5aa5e0-0000-4000-8000-0000000000b1')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('I12','guest CANNOT revoke an invitation','err:42501',
  pg_temp.probe($p$select public.revoke_invitation('0e5aa5e0-0000-4000-8000-0000000000b1')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('I13','admin CAN revoke an invitation','ok:1',
  pg_temp.probe($p$select public.revoke_invitation('0e5aa5e0-0000-4000-8000-0000000000b1')$p$));

-- =====================================================================
-- J. ROSTER / MEMBER PROFILES  (guest roster scoping + email withholding)
-- =====================================================================
reset role;
select pg_temp.reseed();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('J01','member sees the full roster (5)','5',
  pg_temp.probe_val($p$select count(*) from public.workspace_members_list('0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('J02','member roster carries all 5 emails','5',
  pg_temp.probe_val($p$select count(email) from public.workspace_members_list('0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('J03','member sees the 5 co-member profiles','5',
  pg_temp.probe_val($p$select count(*) from public.members where id::text like '0e5aa5e0-0000-4000-8000-0000000000a%'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('J04','guest roster = self + task counterpart only (2)','2',
  pg_temp.probe_val($p$select count(*) from public.workspace_members_list('0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('J05','guest roster withholds EVERY email','0',
  pg_temp.probe_val($p$select count(email) from public.workspace_members_list('0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('J06','guest sees only their OWN member profile','1',
  pg_temp.probe_val($p$select count(*) from public.members where id::text like '0e5aa5e0-0000-4000-8000-0000000000a%'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('J07','outsider gets an EMPTY roster','0',
  pg_temp.probe_val($p$select count(*) from public.workspace_members_list('0e5aa5e0-0000-4000-8000-000000000000')$p$));
select pg_temp.rec('J08','outsider sees only their own member profile','1',
  pg_temp.probe_val($p$select count(*) from public.members where id::text like '0e5aa5e0-0000-4000-8000-0000000000a%'$p$));

-- =====================================================================
-- K. WRITE-PATH LOCK  (workspace_members is RPC-only; workspaces is read-only)
-- K04/K05 record DOC DRIFT: "owner can delete/rename the workspace" is NOT implemented.
-- Live: workspaces has exactly one policy (workspaces_select_member, SELECT) and
-- authenticated holds SELECT only; no delete_workspace RPC exists in pg_proc.
-- =====================================================================
reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('K01','owner CANNOT directly UPDATE workspace_members.role (no grant)','err:42501',
  pg_temp.probe($p$update public.workspace_members set role='guest'
   where workspace_id='0e5aa5e0-0000-4000-8000-000000000000' and user_id='0e5aa5e0-0000-4000-8000-0000000000a3'$p$));
select pg_temp.rec('K02','owner CANNOT directly INSERT workspace_members (no grant)','err:42501',
  pg_temp.probe($p$insert into public.workspace_members (workspace_id,user_id,role)
   values ('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a6','owner')$p$));
select pg_temp.rec('K03','owner CANNOT directly DELETE workspace_members (no grant)','err:42501',
  pg_temp.probe($p$delete from public.workspace_members
   where workspace_id='0e5aa5e0-0000-4000-8000-000000000000' and user_id='0e5aa5e0-0000-4000-8000-0000000000a3'$p$));
select pg_temp.rec('K04','DOC-DRIFT: owner CANNOT delete the workspace (no policy/grant exists)','err:42501',
  pg_temp.probe($p$delete from public.workspaces where id='0e5aa5e0-0000-4000-8000-000000000000'$p$));
select pg_temp.rec('K05','DOC-DRIFT: owner CANNOT rename the workspace (no UPDATE policy/grant)','err:42501',
  pg_temp.probe($p$update public.workspaces set name='renamed' where id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('K06','member sees only their OWN workspace_members row','1',
  pg_temp.probe_val($p$select count(*) from public.workspace_members
   where workspace_id='0e5aa5e0-0000-4000-8000-000000000000'$p$));

-- =====================================================================
-- L. project_task_count RPC  (owner+admin only — gate is workspace_role_rank < 2,
-- NOT is_workspace_owner as CLAUDE.md still claims)
-- =====================================================================
reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('L01','owner CAN run project_task_count','ok:1',
  pg_temp.probe($p$select public.project_task_count('rp-proj-1','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('L02','admin CAN run project_task_count','ok:1',
  pg_temp.probe($p$select public.project_task_count('rp-proj-1','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('L03','member CANNOT run project_task_count','err:42501',
  pg_temp.probe($p$select public.project_task_count('rp-proj-1','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('L04','guest CANNOT run project_task_count','err:42501',
  pg_temp.probe($p$select public.project_task_count('rp-proj-1','0e5aa5e0-0000-4000-8000-000000000000')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('L05','outsider CANNOT run project_task_count','err:42501',
  pg_temp.probe($p$select public.project_task_count('rp-proj-1','0e5aa5e0-0000-4000-8000-000000000000')$p$));

-- =====================================================================
-- M. set_member_role GUARDRAILS
-- =====================================================================
reset role;
select pg_temp.reset_roles();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('M01','owner CAN promote member -> admin','ok:1',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','admin')$p$));
reset role;
select pg_temp.rec('M02','...and the role actually changed to admin','admin',
  pg_temp.probe_val_root($p$select role from public.workspace_members
   where workspace_id='0e5aa5e0-0000-4000-8000-000000000000' and user_id='0e5aa5e0-0000-4000-8000-0000000000a3'$p$));

select pg_temp.reset_roles();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('M03','admin CAN demote member -> guest','ok:1',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','guest')$p$));
reset role;
select pg_temp.rec('M04','...and the role actually changed to guest','guest',
  pg_temp.probe_val_root($p$select role from public.workspace_members
   where workspace_id='0e5aa5e0-0000-4000-8000-000000000000' and user_id='0e5aa5e0-0000-4000-8000-0000000000a3'$p$));

select pg_temp.reset_roles();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('M05','admin CAN promote guest -> member (below-admin management)','ok:1',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a4','member')$p$));
select pg_temp.rec('M06','admin CANNOT grant admin','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','admin')$p$));
select pg_temp.rec('M07','admin CANNOT modify an OWNER','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a1','member')$p$));
select pg_temp.rec('M08','admin CANNOT modify another ADMIN','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a7','member')$p$));
-- FIX 5: relabelled. Outcome (admin cannot become owner) is real, but the guard that fires is the
-- target-rank guard, NOT the self-escalation branch. M21 proves which.
select pg_temp.rec('M09','admin self->owner REJECTED (guard: target-rank, not self-escalation)','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a2','owner')$p$));
select pg_temp.rec('M21','DEAD CODE: self-escalation guard UNREACHABLE — admin self->owner trips the target-rank guard first','42501|admins cannot modify owners or admins',
  pg_temp.probe_msg($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a2','owner')$p$));

reset role;
select pg_temp.reset_roles();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('M10','member CANNOT change anyone role','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a4','member')$p$));
select pg_temp.rec('M11','member self->admin REJECTED (guard: caller rank < 2, same path as M10)','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','admin')$p$));
select pg_temp.rec('M22','DEAD CODE: member self->admin trips the caller-rank gate, not the self-escalation guard','42501|only an owner or admin can change roles',
  pg_temp.probe_msg($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','admin')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('M12','guest self->owner REJECTED (guard: caller rank < 2, same path as M10)','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a4','owner')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('M13','outsider CANNOT change roles in the workspace','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','guest')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('M14','LAST OWNER cannot self-demote','err:42501',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a1','member')$p$));
select pg_temp.rec('M15','invalid role value is rejected (22023)','err:22023',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','superuser')$p$));
select pg_temp.rec('M16','role change for a NON-member is rejected (P0002)','err:P0002',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a6','member')$p$));
select pg_temp.rec('M17','owner CAN grant owner','ok:1',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3','owner')$p$));
select pg_temp.rec('M18','owner CAN demote an admin','ok:1',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a2','member')$p$));

-- second owner present -> self-demote now allowed (the guard protects the LAST owner only)
reset role;
select pg_temp.reset_roles();
insert into public.workspace_members (workspace_id,user_id,role)
values ('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a5','owner');
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('M19','with a 2nd owner, an owner CAN self-demote','ok:1',
  pg_temp.probe($p$select public.set_member_role('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a1','member')$p$));
reset role;
select pg_temp.rec('M20','...and they are now a plain member','member',
  pg_temp.probe_val_root($p$select role from public.workspace_members
   where workspace_id='0e5aa5e0-0000-4000-8000-000000000000' and user_id='0e5aa5e0-0000-4000-8000-0000000000a1'$p$));

-- =====================================================================
-- N. remove_member GUARDRAILS
-- =====================================================================
reset role;
select pg_temp.reset_roles();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('N01','admin CAN remove a member','ok:1',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3')$p$));
reset role;
select pg_temp.rec('N02','...and the membership row is gone','0',
  pg_temp.probe_val_root($p$select count(*) from public.workspace_members
   where workspace_id='0e5aa5e0-0000-4000-8000-000000000000' and user_id='0e5aa5e0-0000-4000-8000-0000000000a3'$p$));

select pg_temp.reset_roles();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a2","role":"authenticated","email":"rp-admin@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('N03','admin CAN remove a guest','ok:1',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a4')$p$));
select pg_temp.rec('N04','admin CANNOT remove an OWNER','err:42501',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a1')$p$));
select pg_temp.rec('N05','admin CANNOT remove another ADMIN','err:42501',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a7')$p$));

reset role;
select pg_temp.reset_roles();
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a3","role":"authenticated","email":"rp-member@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('N06','member CANNOT remove anyone','err:42501',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a4')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a4","role":"authenticated","email":"rp-guest@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('N07','guest CANNOT remove anyone','err:42501',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a6","role":"authenticated","email":"rp-outsider@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('N08','outsider CANNOT remove anyone','err:42501',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a3')$p$));

reset role;
set local request.jwt.claims = '{"sub":"0e5aa5e0-0000-4000-8000-0000000000a1","role":"authenticated","email":"rp-owner@roleproof.test"}';
set local role authenticated;
select pg_temp.rec('N09','LAST OWNER cannot remove themselves','err:42501',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a1')$p$));
select pg_temp.rec('N10','removing a NON-member is rejected (P0002)','err:P0002',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a6')$p$));
select pg_temp.rec('N11','owner CAN remove an admin','ok:1',
  pg_temp.probe($p$select public.remove_member('0e5aa5e0-0000-4000-8000-000000000000','0e5aa5e0-0000-4000-8000-0000000000a2')$p$));

-- ----------------------------------------------------------------- output ---
reset role;
select count(*) as assertions,
       count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       coalesce(string_agg(id||' ['||name||'] expected='||expected||' actual='||actual, ' | ' order by id)
                filter (where not pass), '<none>') as failures
from pg_temp.role_proof;
-- swap the aggregate above for the detail view when iterating:
--   select id, name, expected, actual, pass from pg_temp.role_proof order by id;

rollback;
