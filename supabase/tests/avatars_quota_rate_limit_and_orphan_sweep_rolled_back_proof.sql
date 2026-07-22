-- ============================================================================================
-- ROLLED-BACK PROOF for 20260722061032_avatars_quota_rate_limit_and_orphan_sweep.sql (37 assertions)
-- STATUS: APPLIED 2026-07-22 as 20260722061032, after this proof ran 37/37 GREEN against the live DB.
--         This whole file is ONE begin;…rollback; — nothing here commits.
--
-- ⚠⚠ THIS FILE NO LONGER RUNS AT ALL POST-APPLY — AND IT IS WORSE THAN "SOME ASSERTIONS FAIL".
--   Measured 2026-07-22: the transaction **ABORTS INSIDE THE GREEN BLOCK** and reports NOTHING.
--   Rows 1-22 were inserted into _r but the final SELECTs never execute, so no verdict is emitted:
--       ERROR: 22023 avatar_url must be a storage path in your own avatars folder
--       at line ~515:  update public.members set avatar_url = v_url_pfx||n_ref_old where id = uS;
--   The sweep fixtures reference avatars by the OLD public-URL shape; 20260722061442 converted the
--   column to a bare storage path and its trigger now rejects a URL.
--   Separately, R03/R04 assert that no avatars upload-log trigger and no _sweep_orphan_avatars/cron
--   job EXIST — both are now live, so they would fail too if execution ever reached them.
--   **To run this as a regression it needs the REWIND pattern** (restore the pre-migration trigger
--   body and predicate transaction-locally before RED, re-apply before GREEN). See
--   guest_scoped_avatar_visibility_rolled_back_proof.sql for a worked example.
--   The value of the file as shipped is the GREEN half — in particular S00, the permanent regression
--   guard against reintroducing set_config() in place of SET LOCAL.
--
-- ⚠ ALSO SUPERSEDED: the sweep body proven here matches by right()-suffix, correct for the URL-shaped
--   avatar_url column of its time. 20260722061442 converts the column to a bare storage PATH and
--   replaces that rule with EXACT EQUALITY plus a raise-not-delete fail-safe. See
--   avatars_private_bucket_and_signed_urls_rolled_back_proof.sql, whose R06 demonstrates exactly why.
-- ============================================================================================
--
-- ############################################################################################
-- ## HISTORY — THIS PROOF ALREADY CAUGHT ONE REAL DEFECT, AND THE PROPOSAL WAS FIXED.        ##
-- ##                                                                                         ##
-- ## The previous run was 37/38. The single failure (then-D01) was NOT a bad assertion — it   ##
-- ## was a genuine defect in the proposal. `private._sweep_orphan_avatars()` used             ##
-- ##     perform set_config('session_replication_role','replica', true);                      ##
-- ## so it could save and restore the prior value. That body RAISES                           ##
-- ##     42501 "permission denied to set parameter session_replication_role"                  ##
-- ## on EVERY call. `session_replication_role` is PGC_SUSET; set_config() requests it at       ##
-- ## `superuser() ? PGC_SUSET : PGC_USERSET`, and this project's `postgres` role is NOT a      ##
-- ## superuser (rolsuper=false, rolbypassrls=true), so the request downgrades and is refused.  ##
-- ## SECURITY DEFINER does not help — the effective user inside the function is the owner,     ##
-- ## which is that same non-superuser postgres. The cron job would have errored every hour     ##
-- ## forever and collected nothing, silently.                                                 ##
-- ##                                                                                         ##
-- ## THE PROPOSAL NOW USES THE SHIPPED PRECEDENT'S IDIOM (20260712124726 / 20260715142424):    ##
-- ##     set local session_replication_role = replica;  …  set local session_replication_role = origin; ##
-- ## The SET *utility statement* takes a different permission path and is accepted for this    ##
-- ## role. The save/restore was dropped as unnecessary: a SET LOCAL made inside a function      ##
-- ## that carries its own SET clause (this one has `set search_path=''`) reverts automatically  ##
-- ## when the function exits.                                                                  ##
-- ##                                                                                         ##
-- ## CONSEQUENTLY THIS FILE NO LONGER CARRIES A RED DEFECT ASSERTION OR AN INLINE CORRECTION.  ##
-- ## Section (2) installs the sweep VERBATIM FROM THE PROPOSAL and the proof simply runs it.   ##
-- ## S00 is the surviving regression guard for that defect: it asserts the sweep — as the       ##
-- ## proposal actually ships it — EXECUTES. If anyone ever "improves" the idiom back into       ##
-- ## set_config(), S00 fails again. Every other assertion is unchanged from the 37 that passed. ##
-- ############################################################################################
--
-- WHAT IS PROVEN
--   RED  (against the CURRENT live rules, BEFORE the DDL under test):
--     * `avatars_insert_own` is a bare two-clause policy: one user uploads 25 objects totalling
--       250 MB with no rate limit, no object cap and no byte quota. The 13th upload — the exact one
--       the proposed policy rejects — is accepted today.
--     * No avatars upload-log trigger exists (nothing counts operations).
--     * An avatars object with NO referencing members.avatar_url, aged 2 hours, is collected by
--       NOTHING: `private._sweep_orphan_avatars` does not exist, no cron job references the bucket,
--       and the one sweep that DOES exist (task-attachments) leaves it standing. Because the bucket
--       is public=true, that orphan stays WORLD-READABLE forever.
--   CURE / GREEN (after applying the proposed DDL, verbatim, inside this transaction):
--     * the sweep AS PROPOSED runs at all (S00 — the fixed defect, guarded against regression).
--     * the SAME actor performing the SAME action RED accepted is now rejected (C01), and the SAME
--       orphan RED showed surviving is now collected (S03).
--     * 12/hr rate limit blocks the 13th AND is DELETE-RESISTANT (the 20260712111044 lesson: the log
--       is append-only, so delete-then-reupload cannot reset it) — proven, not assumed.
--     * object cap (<20) and byte quota (<=20 MB, INCLUSIVE of the incoming row) each block, each
--       with an isolation assertion showing the OTHER two clauses would have passed. RLS returns the
--       same sqlstate AND the same message for every failing clause, so clause attribution is done by
--       evaluating the gate functions directly, never by matching message text.
--     * the happy path still works (fresh user, single upload) and own-folder pinning still holds.
--     * THE AGE GUARD both directions incl. the 59-vs-61-minute boundary; a referenced object is
--       never collected at any age; suffix matching is per-OBJECT, so an unreferenced object in the
--       SAME uid folder as a referenced one IS collected (the folder-level footgun the design warns
--       about).
--     * hardening posture: log table + fns revoked/granted as specified.
--
-- HOUSE RULES OBSERVED
--   * SYNTHETIC FIXTURES ONLY. Every actor/object is gen_random_uuid()-minted inside the txn. No
--     live member, workspace, project or task is read or mutated.
--   * postgres has rolbypassrls=true here, so the HARNESS GUARD RAISES (does not record) unless
--     current_user='authenticated', the role's rolbypassrls PROPERTY is false, auth.uid() is the
--     impersonated id, and a known-denied control write returns exactly 42501.
--   * The results table is written only after `reset role` (an authenticated session cannot write a
--     temp table created by postgres); an explicit grant is added as a second layer.
--   * Every cleanup DELETE is scoped to fixture uids / fixture object names. There is no unqualified
--     delete anywhere in this file.
--   * DDL under test sits at TOP LEVEL (a bare CREATE OR REPLACE FUNCTION cannot run inside a
--     plpgsql DO block).
--
-- DELIBERATE OMISSION: pg_cron. The proposal's `cron.schedule('avatar-orphan-sweep', …)` is NOT run
--   here. Scheduling is out of scope for a rolled-back proof; the sweep FUNCTION is invoked directly
--   instead, which is what the schedule would call. Verify the job exists as a post-apply step.
--
-- SIDE EFFECTS INSIDE THE TXN (all rolled back): R05 invokes the existing task-attachment sweep, and
--   the GREEN block invokes the new avatars sweep — both are global DELETEs over their own bucket, so
--   they would collect any pre-existing live orphan. Live recon 2026-07-19: 1 avatars object, 1
--   member with an avatar_url, 0 orphans. The rollback is the guarantee regardless.
--
-- storage.protect_delete() blocks direct DELETEs on storage.objects unless the storage GUC is set
-- (the real Storage API sets it; the sweeps use session_replication_role='replica' instead). It is
-- set once below so the proof can exercise the delete-resistance path as a real authenticated user.
-- ============================================================================================

begin;

select set_config('storage.allow_delete_query', 'true', true);

-- ---------------------------------------------------------------------------
-- (0) HARNESS + FIXTURES
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
grant insert on _r to authenticated;   -- scratch only; nothing asserts on this table's contents

create temp table _cfg on commit drop as select replace(gen_random_uuid()::text,'-','') as sfx;

-- A=RED uploader · P=happy path · X=pinning victim · R=rate limit · N=rate-limit control (other user)
-- C=object cap · Q=byte quota · S=sweep folder (referenced + orphan folder-mates) · Y=referenced-at-5h
create temp table _fx(k text primary key, uid uuid not null default gen_random_uuid()) on commit drop;
insert into _fx(k) values ('A'),('P'),('X'),('R'),('N'),('C'),('Q'),('S'),('Y');

insert into auth.users (id, email, aud, role)
select f.uid, 'av-'||lower(f.k)||'-'||c.sfx||'@example.invalid', 'authenticated', 'authenticated'
from _fx f cross join _cfg c;   -- on_auth_user_created/handle_new_user mints the public.members row

-- ---------------------------------------------------------------------------
-- (1) RED — the disease, against the CURRENT live rules
-- ---------------------------------------------------------------------------
do $red$
declare
  uA uuid; v_sfx text; v_res text; v_n int; v_ok int := 0; i int;
  v_red_orphan text;
begin
  select uid into uA from _fx where k='A';
  select sfx into v_sfx from _cfg;

  -- ===== HARNESS GUARD (RAISES, never records) =====
  perform pg_temp.imp(uA);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: current_user=%', current_user; end if;
  if (select rolbypassrls from pg_roles where rolname = current_user) then
    execute 'reset role'; raise exception 'HARNESS BROKEN: session role has rolbypassrls'; end if;
  if auth.uid() is distinct from uA then execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid()=% expected %', auth.uid(), uA; end if;
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', (select uid from _fx where k='X')::text||'/harness.jpg', uA, uA::text,
            jsonb_build_object('size',1,'mimetype','image/jpeg'));
    v_res := 'ALLOWED';
  exception when others then v_res := sqlstate; end;
  if v_res <> '42501' then execute 'reset role'; raise exception 'HARNESS BROKEN: control write returned % (expected 42501)', v_res; end if;
  execute 'reset role';

  -- ---- R01: baseline — a single upload into A's own folder is accepted today ----
  perform pg_temp.imp(uA);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uA::text||'/red-'||v_sfx||'-001.jpg', uA, uA::text,
            jsonb_build_object('size',10485760,'mimetype','image/jpeg'));
    v_res := 'OK';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (1,'R01 baseline (non-vacuous): A CAN upload into their own folder today','OK',v_res,v_res='OK');

  -- ---- R02 CORE: 24 more (25 total, 250 MB) — no rate limit, no object cap, no byte quota ----
  perform pg_temp.imp(uA);
  for i in 2..25 loop
    begin
      insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
      values ('avatars', uA::text||'/red-'||v_sfx||'-'||lpad(i::text,3,'0')||'.jpg', uA, uA::text,
              jsonb_build_object('size',10485760,'mimetype','image/jpeg'));
      v_ok := v_ok + 1;
    exception when others then null; end;
  end loop;
  select count(*) into v_n from storage.objects
   where bucket_id='avatars' and name like uA::text||'/red-'||v_sfx||'-%';
  execute 'reset role';
  insert into _r values (2,
    'R02 [CORE DISEASE] A uploads 25 objects / 250 MB unimpeded - the 13th upload, the 21st object and the 21st MB are all accepted today',
    '25 objects', v_n::text||' objects', v_n = 25);

  -- ---- R03: no operations counter exists for this bucket ----
  select count(*) into v_n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='storage' and c.relname='objects' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) like '%avatars%';
  insert into _r values (3,'R03 no avatars upload-log trigger exists today (nothing counts operations)','0',v_n::text,v_n=0);

  -- ---- R04: no collector exists for this bucket ----
  select (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='private' and p.proname='_sweep_orphan_avatars')
       + (select count(*) from cron.job where jobname='avatar-orphan-sweep' or command like '%avatar%')
    into v_n;
  insert into _r values (4,'R04 no private._sweep_orphan_avatars and no avatars cron job exist today','0',v_n::text,v_n=0);

  -- ---- plant the RED orphan: 2 hours old, NO members.avatar_url references it ----
  v_red_orphan := uA::text||'/red-orphan-'||v_sfx||'.jpg';
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata,created_at)
  values ('avatars', v_red_orphan, uA, uA::text,
          jsonb_build_object('size',1000,'mimetype','image/jpeg'), now() - interval '2 hours');

  -- ---- R06 pair (established BEFORE R05 so R05 is not vacuous): it really is unreferenced ----
  select count(*) into v_n from public.members m
   where m.avatar_url is not null and right(m.avatar_url, length(v_red_orphan)) = v_red_orphan;
  insert into _r values (6,'R06 pair (non-vacuous): the planted 2h object genuinely has NO referencing members.avatar_url','0',v_n::text,v_n=0);

  -- ---- R05 CORE: run the ONLY sweep that exists — the orphan survives; nothing collects it ----
  perform private._sweep_orphan_task_attachments();
  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=v_red_orphan;
  insert into _r values (5,
    'R05 [CORE DISEASE] a 2h-old UNREFERENCED avatars object survives the only sweep that exists - it stays world-readable forever (public bucket)',
    '1 (still there)', v_n::text, v_n = 1);

  select count(*) into v_n from _r;
  if v_n <> 6 then raise exception 'RED INCOMPLETE: % rows, expected 6', v_n; end if;
end
$red$;

-- ---------------------------------------------------------------------------
-- (2) THE DDL UNDER TEST — verbatim from the proposal, MINUS the cron.schedule
-- ---------------------------------------------------------------------------
create table if not exists private.avatar_upload_log(
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists avatar_upload_log_user_time_idx on private.avatar_upload_log(user_id, created_at);
revoke all on private.avatar_upload_log from anon, authenticated, public;

create or replace function private.log_avatar_upload() returns trigger
language plpgsql security definer set search_path='' as $fn$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return new; end if;   -- service-role / sweep writes are not rate-limited
  insert into private.avatar_upload_log(user_id) values (v_uid);
  delete from private.avatar_upload_log where user_id = v_uid and created_at < now() - interval '1 hour';
  return new;
end; $fn$;
revoke execute on function private.log_avatar_upload() from public, anon, authenticated;

drop trigger if exists avatar_upload_log on storage.objects;
create trigger avatar_upload_log after insert on storage.objects
  for each row when (new.bucket_id = 'avatars')
  execute function private.log_avatar_upload();

create or replace function private.avatar_upload_allowed() returns boolean
language sql stable security definer set search_path='' as $fn$
  select (select count(*) from private.avatar_upload_log l
            where l.user_id = auth.uid() and l.created_at > now() - interval '1 hour') < 12;
$fn$;
revoke execute on function private.avatar_upload_allowed() from public, anon;
grant  execute on function private.avatar_upload_allowed() to authenticated;

create or replace function private.user_avatar_bytes(p_uid uuid) returns bigint
language sql stable security definer set search_path='' as $fn$
  select coalesce(sum((o.metadata->>'size')::bigint),0)::bigint from storage.objects o
   where o.bucket_id='avatars' and (storage.foldername(o.name))[1] = p_uid::text;
$fn$;
create or replace function private.user_avatar_object_count(p_uid uuid) returns int
language sql stable security definer set search_path='' as $fn$
  select count(*)::int from storage.objects o
   where o.bucket_id='avatars' and (storage.foldername(o.name))[1] = p_uid::text;
$fn$;
revoke execute on function private.user_avatar_bytes(uuid), private.user_avatar_object_count(uuid) from public, anon;
grant  execute on function private.user_avatar_bytes(uuid), private.user_avatar_object_count(uuid) to authenticated;

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects for insert to authenticated
  with check (bucket_id='avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and private.user_avatar_bytes((select auth.uid())) + coalesce((metadata->>'size')::bigint,0) <= 20971520
    and private.user_avatar_object_count((select auth.uid())) < 20
    and private.avatar_upload_allowed());

-- The sweep, EXACTLY as the proposal now ships it: the precedent's SET LOCAL utility statement, no
-- set_config(), no save/restore. S00 below is the regression guard on this idiom.
create or replace function private._sweep_orphan_avatars() returns void
language plpgsql security definer set search_path='' as $fn$
begin
  set local session_replication_role = replica;

  delete from storage.objects o
   where o.bucket_id = 'avatars'
     and o.created_at < now() - interval '1 hour'
     and not exists (
       select 1 from public.members m
        where m.avatar_url is not null
          and right(m.avatar_url, length(o.name)) = o.name);

  set local session_replication_role = origin;
end; $fn$;
revoke execute on function private._sweep_orphan_avatars() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (3) GREEN — the cure
-- ---------------------------------------------------------------------------
do $green$
declare
  uA uuid; uP uuid; uX uuid; uR uuid; uN uuid; uC uuid; uQ uuid; uS uuid; uY uuid;
  v_sfx text; v_res text; v_n int; v_b bigint; v_ok int := 0; v_allowed boolean; i int;
  v_url_pfx text := 'https://nqlzjuxqgajeoypyzlnv.supabase.co/storage/v1/object/public/avatars/';
  v_red_orphan text;
  n_ref_old text; n_orphan_old text; n_young text; n_59 text; n_61 text; n_ref_5h text;
  v_cvictim text;
begin
  select uid into uA from _fx where k='A';  select uid into uP from _fx where k='P';
  select uid into uX from _fx where k='X';  select uid into uR from _fx where k='R';
  select uid into uN from _fx where k='N';  select uid into uC from _fx where k='C';
  select uid into uQ from _fx where k='Q';  select uid into uS from _fx where k='S';
  select uid into uY from _fx where k='Y';
  select sfx into v_sfx from _cfg;
  v_red_orphan := uA::text||'/red-orphan-'||v_sfx||'.jpg';

  -- ===== HARNESS GUARD, re-asserted after the DDL =====
  perform pg_temp.imp(uP);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: current_user=%', current_user; end if;
  if (select rolbypassrls from pg_roles where rolname = current_user) then
    execute 'reset role'; raise exception 'HARNESS BROKEN: session role has rolbypassrls'; end if;
  if auth.uid() is distinct from uP then execute 'reset role'; raise exception 'HARNESS BROKEN: uid'; end if;
  execute 'reset role';

  -- ================= C01 — THE CURE, same actor + same action RED accepted =================
  perform pg_temp.imp(uA);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uA::text||'/red-'||v_sfx||'-026.jpg', uA, uA::text,
            jsonb_build_object('size',10485760,'mimetype','image/jpeg'));
    v_res := 'ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (7,'C01 [CURE of R02] the SAME actor doing the SAME upload RED accepted is now REJECTED','42501',v_res,v_res='42501');

  -- ================= happy path + own-folder pinning =================
  perform pg_temp.imp(uP);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uP::text||'/ok-'||v_sfx||'.jpg', uP, uP::text,
            jsonb_build_object('size',90000,'mimetype','image/jpeg'));
    v_res := 'OK';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (8,'G01 [ANTI-VACUITY] a fresh user normal single upload still SUCCEEDS','OK',v_res,v_res='OK');

  perform pg_temp.imp(uP);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uX::text||'/steal-'||v_sfx||'.jpg', uP, uP::text,
            jsonb_build_object('size',90000,'mimetype','image/jpeg'));
    v_res := 'ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (9,'G02 own-folder pinning still holds: P CANNOT insert into X uid folder','42501',v_res,v_res='42501');

  -- ================= RATE LIMIT: 12/hr, delete-resistant =================
  perform pg_temp.imp(uR);
  for i in 1..12 loop
    begin
      insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
      values ('avatars', uR::text||'/rate-'||v_sfx||'-'||lpad(i::text,2,'0')||'.jpg', uR, uR::text,
              jsonb_build_object('size',1000,'mimetype','image/jpeg'));
      v_ok := v_ok + 1;
    exception when others then null; end;
  end loop;
  execute 'reset role';
  insert into _r values (10,'G03 the first 12 uploads in the hour all succeed (the cap is 12, not 0)','12 ok',v_ok::text||' ok',v_ok=12);

  perform pg_temp.imp(uR);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uR::text||'/rate-'||v_sfx||'-13.jpg', uR, uR::text,
            jsonb_build_object('size',1000,'mimetype','image/jpeg'));
    v_res := 'ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (11,'G04 [CORE] the 13th upload within the hour is BLOCKED','42501',v_res,v_res='42501');

  -- clause attribution: RLS returns the same sqlstate AND message for every failing clause, so the
  -- intended clause is identified by evaluating the gate functions directly, never by text.
  perform pg_temp.imp(uR);
  select private.avatar_upload_allowed() into v_allowed;
  execute 'reset role';
  insert into _r values (12,'G05 clause attribution: as R, private.avatar_upload_allowed() is FALSE','false',coalesce(v_allowed::text,'null'),v_allowed is false);

  perform pg_temp.imp(uR);
  select private.user_avatar_object_count(uR), private.user_avatar_bytes(uR) into v_n, v_b;
  execute 'reset role';
  insert into _r values (13,'G06 clause attribution: R count (12) < 20 AND bytes (12000) <= 20971520 - only the RATE clause is failing',
    '12 objs / 12000 B', v_n::text||' objs / '||v_b::text||' B', v_n=12 and v_b=12000);

  -- DELETE-RESISTANCE: destroy every object, retry — the append-only log must still block.
  perform pg_temp.imp(uR);
  delete from storage.objects where bucket_id='avatars' and name like uR::text||'/rate-'||v_sfx||'-%';  -- fixture-scoped
  select private.user_avatar_object_count(uR) into v_n;
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uR::text||'/rate-'||v_sfx||'-retry.jpg', uR, uR::text,
            jsonb_build_object('size',1000,'mimetype','image/jpeg'));
    v_res := 'ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (14,'G07 [CORE] DELETE-RESISTANT: R deletes all 12 objects (survivor count 0) and the retry is STILL blocked',
    '0 objs / 42501', v_n::text||' objs / '||v_res, v_n=0 and v_res='42501');

  select count(*) into v_n from private.avatar_upload_log where user_id=uR;
  insert into _r values (15,'G08 the append-only log still records 12 OPERATIONS for R after the deletes','12',v_n::text,v_n=12);

  perform pg_temp.imp(uN);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uN::text||'/other-'||v_sfx||'.jpg', uN, uN::text,
            jsonb_build_object('size',1000,'mimetype','image/jpeg'));
    v_res := 'OK';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (16,'G09 pair (non-vacuous): a DIFFERENT user uploads fine at the same instant - the cap is per-user, not global','OK',v_res,v_res='OK');

  -- ================= OBJECT CAP: < 20 =================
  -- planted as postgres, so auth.uid() is null in the log trigger and NO rate-limit ops are consumed.
  for i in 1..20 loop
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uC::text||'/cap-'||v_sfx||'-'||lpad(i::text,2,'0')||'.jpg', uC, uC::text,
            jsonb_build_object('size',1000,'mimetype','image/jpeg'));
  end loop;

  perform pg_temp.imp(uC);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uC::text||'/cap-'||v_sfx||'-21.jpg', uC, uC::text,
            jsonb_build_object('size',1000,'mimetype','image/jpeg'));
    v_res := 'ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (17,'G10 [CORE] the 20-object cap BLOCKS the 21st object','42501',v_res,v_res='42501');

  perform pg_temp.imp(uC);
  select private.avatar_upload_allowed(), private.user_avatar_object_count(uC), private.user_avatar_bytes(uC)
    into v_allowed, v_n, v_b;
  execute 'reset role';
  insert into _r values (18,'G11 clause attribution: as C, rate is ALLOWED and bytes (20000) are far under quota - only the COUNT clause is failing (count=20)',
    'true / 20 / 20000', coalesce(v_allowed::text,'null')||' / '||v_n::text||' / '||v_b::text,
    v_allowed is true and v_n=20 and v_b=20000);

  v_cvictim := uC::text||'/cap-'||v_sfx||'-01.jpg';
  perform pg_temp.imp(uC);
  delete from storage.objects where bucket_id='avatars' and name = v_cvictim;   -- fixture-scoped
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uC::text||'/cap-'||v_sfx||'-21.jpg', uC, uC::text,
            jsonb_build_object('size',1000,'mimetype','image/jpeg'));
    v_res := 'OK';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (19,'G12 pair (non-vacuous): deleting ONE object (count 19) lets the SAME upload through - the cap is a survivor count, correctly',
    'OK',v_res,v_res='OK');

  -- ================= BYTE QUOTA: <= 20 MB, INCLUSIVE of the incoming row =================
  insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
  values ('avatars', uQ::text||'/quota-'||v_sfx||'-base.jpg', uQ, uQ::text,
          jsonb_build_object('size',20971420,'mimetype','image/jpeg'));   -- 20 MB - 100 B

  perform pg_temp.imp(uQ);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uQ::text||'/quota-'||v_sfx||'-exact.jpg', uQ, uQ::text,
            jsonb_build_object('size',100,'mimetype','image/jpeg'));      -- lands on EXACTLY 20971520
    v_res := 'OK';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (20,'G13 quota BOUNDARY: an upload landing on EXACTLY 20971520 B is allowed (<= is inclusive of the incoming row)','OK',v_res,v_res='OK');

  perform pg_temp.imp(uQ);
  begin
    insert into storage.objects (bucket_id,name,owner,owner_id,metadata)
    values ('avatars', uQ::text||'/quota-'||v_sfx||'-over.jpg', uQ, uQ::text,
            jsonb_build_object('size',1,'mimetype','image/jpeg'));        -- 20971521 > cap
    v_res := 'ALLOWED';
  exception when others then v_res := sqlstate; end;
  execute 'reset role';
  insert into _r values (21,'G14 [CORE] one byte over 20 MB is BLOCKED','42501',v_res,v_res='42501');

  perform pg_temp.imp(uQ);
  select private.avatar_upload_allowed(), private.user_avatar_object_count(uQ), private.user_avatar_bytes(uQ)
    into v_allowed, v_n, v_b;
  execute 'reset role';
  insert into _r values (22,'G15 clause attribution: as Q, rate is ALLOWED and count (2) < 20 - only the BYTE clause is failing (bytes=20971520)',
    'true / 2 / 20971520', coalesce(v_allowed::text,'null')||' / '||v_n::text||' / '||v_b::text,
    v_allowed is true and v_n=2 and v_b=20971520);

  -- ================= ORPHAN SWEEP: age guard + per-object suffix matching =================
  n_ref_old    := uS::text||'/sweep-'||v_sfx||'-ref-old.jpg';       -- 2h, REFERENCED
  n_orphan_old := uS::text||'/sweep-'||v_sfx||'-orp-old.jpg';       -- 2h, same folder, UNREFERENCED
  n_young      := uS::text||'/sweep-'||v_sfx||'-young.jpg';         -- 0s, UNREFERENCED (modal open)
  n_59         := uS::text||'/sweep-'||v_sfx||'-b59.jpg';           -- 59m, UNREFERENCED
  n_61         := uS::text||'/sweep-'||v_sfx||'-b61.jpg';           -- 61m, UNREFERENCED
  n_ref_5h     := uY::text||'/sweep-'||v_sfx||'-ref-5h.jpg';        -- 5h, REFERENCED

  insert into storage.objects (bucket_id,name,owner,owner_id,metadata,created_at) values
    ('avatars', n_ref_old,    uS, uS::text, jsonb_build_object('size',1000,'mimetype','image/jpeg'), now()-interval '2 hours'),
    ('avatars', n_orphan_old, uS, uS::text, jsonb_build_object('size',1000,'mimetype','image/jpeg'), now()-interval '2 hours'),
    ('avatars', n_young,      uS, uS::text, jsonb_build_object('size',1000,'mimetype','image/jpeg'), now()),
    ('avatars', n_59,         uS, uS::text, jsonb_build_object('size',1000,'mimetype','image/jpeg'), now()-interval '59 minutes'),
    ('avatars', n_61,         uS, uS::text, jsonb_build_object('size',1000,'mimetype','image/jpeg'), now()-interval '61 minutes'),
    ('avatars', n_ref_5h,     uY, uY::text, jsonb_build_object('size',1000,'mimetype','image/jpeg'), now()-interval '5 hours');

  -- the two references (members rows already exist via handle_new_user; only avatar_url is written)
  update public.members set avatar_url = v_url_pfx||n_ref_old where id = uS;
  update public.members set avatar_url = v_url_pfx||n_ref_5h  where id = uY;

  -- ---- S01 anti-vacuity: everything the sweep will judge exists FIRST ----
  select (select count(*) from storage.objects
            where bucket_id='avatars' and name in (n_ref_old,n_orphan_old,n_young,n_59,n_61,n_ref_5h))
       + (select count(*) from storage.objects where bucket_id='avatars' and name=v_red_orphan)
       + (select count(*) from public.members where id in (uS,uY) and avatar_url is not null)
    into v_n;
  insert into _r values (23,'S01 [ANTI-VACUITY] 6 sweep fixtures + the RED orphan + 2 avatar_url references all exist pre-sweep','9',v_n::text,v_n=9);

  -- ---- S02 mechanism (asserted pre-sweep, while BOTH folder-mates still exist) ----
  select (select count(*) from public.members m where m.avatar_url is not null and right(m.avatar_url,length(n_ref_old))    = n_ref_old)
       - (select count(*) from public.members m where m.avatar_url is not null and right(m.avatar_url,length(n_orphan_old)) = n_orphan_old)
    into v_n;
  insert into _r values (24,'S02 suffix matching is per-OBJECT: the referenced name matches exactly 1 members row, its SAME-FOLDER neighbour matches 0','1 - 0 = 1',v_n::text,v_n=1);

  -- ============================ INVOKE THE SWEEP ONCE ============================
  -- S00 is the REGRESSION GUARD for the fixed defect: the proposal's own body, unmodified, must run.
  -- The previous set_config() draft raised 42501 here on every call.
  begin
    perform private._sweep_orphan_avatars();
    v_res := 'ran';
  exception when others then v_res := sqlstate||' ('||sqlerrm||')'; end;
  insert into _r values (25,'S00 [REGRESSION GUARD - the fixed defect] the sweep AS PROPOSED (precedent SET LOCAL idiom, 20260715142424) EXECUTES; the set_config() variant raised 42501 here','ran',v_res,v_res='ran');

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=v_red_orphan;
  insert into _r values (26,'S03 [CURE of R05] the SAME orphan RED showed surviving forever is now COLLECTED','0 (gone)',v_n::text,v_n=0);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=n_ref_old;
  insert into _r values (27,'S04 a REFERENCED object (2h) survives','1 (kept)',v_n::text,v_n=1);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=n_orphan_old;
  insert into _r values (28,'S05 [CORE] the folder-level FOOTGUN is avoided: an UNREFERENCED 2h object in the SAME uid folder as a referenced one IS collected','0 (gone)',v_n::text,v_n=0);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=n_young;
  insert into _r values (29,'S06 [CORE - BUG B] a 0-second UNREFERENCED object SURVIVES (the user profile modal is still open)','1 (kept)',v_n::text,v_n=1);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=n_59;
  insert into _r values (30,'S07 age BOUNDARY: 59 minutes (< 1h) survives','1 (kept)',v_n::text,v_n=1);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=n_61;
  insert into _r values (31,'S08 age BOUNDARY: 61 minutes (> 1h) is collected - the guard delays, it does not disable','0 (gone)',v_n::text,v_n=0);

  select count(*) into v_n from storage.objects where bucket_id='avatars' and name=n_ref_5h;
  insert into _r values (32,'S09 a REFERENCED object is never collected at ANY age (5 hours)','1 (kept)',v_n::text,v_n=1);

  -- ================= HARDENING POSTURE =================
  -- anon/authenticated are non-superuser and inherit any PUBLIC grant, so "neither has it" also
  -- proves PUBLIC does not have it.
  select (case when has_table_privilege('anon','private.avatar_upload_log','SELECT') then 1 else 0 end
        + case when has_table_privilege('anon','private.avatar_upload_log','INSERT') then 1 else 0 end
        + case when has_table_privilege('anon','private.avatar_upload_log','UPDATE') then 1 else 0 end
        + case when has_table_privilege('anon','private.avatar_upload_log','DELETE') then 1 else 0 end
        + case when has_table_privilege('authenticated','private.avatar_upload_log','SELECT') then 1 else 0 end
        + case when has_table_privilege('authenticated','private.avatar_upload_log','INSERT') then 1 else 0 end
        + case when has_table_privilege('authenticated','private.avatar_upload_log','UPDATE') then 1 else 0 end
        + case when has_table_privilege('authenticated','private.avatar_upload_log','DELETE') then 1 else 0 end)
    into v_n;
  insert into _r values (33,'H01 private.avatar_upload_log: no SELECT/INSERT/UPDATE/DELETE for anon, authenticated or PUBLIC','0 privileges',v_n::text||' privileges',v_n=0);

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='private' and p.proname='log_avatar_upload'
     and p.prosecdef and p.proconfig = array['search_path=""']
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  insert into _r values (34,'H02 private.log_avatar_upload(): DEFINER + search_path empty + EXECUTE revoked from anon/authenticated/PUBLIC','1',v_n::text,v_n=1);

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='private'
     and p.proname in ('avatar_upload_allowed','user_avatar_bytes','user_avatar_object_count')
     and p.prosecdef and p.proconfig = array['search_path=""']
     and has_function_privilege('authenticated', p.oid, 'EXECUTE')
     and not has_function_privilege('anon', p.oid, 'EXECUTE');
  insert into _r values (35,'H03 the 3 gate fns: DEFINER + search_path empty + EXECUTE to authenticated ONLY (not anon/PUBLIC)','3',v_n::text,v_n=3);

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='private' and p.proname='_sweep_orphan_avatars'
     and p.prosecdef and p.proconfig = array['search_path=""']
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  insert into _r values (36,'H04 private._sweep_orphan_avatars(): DEFINER + search_path empty + EXECUTE revoked from anon/authenticated/PUBLIC','1',v_n::text,v_n=1);

  select count(*) into v_n from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='storage' and c.relname='objects' and t.tgname='avatar_upload_log'
     and pg_get_triggerdef(t.oid) like 'CREATE TRIGGER avatar_upload_log AFTER INSERT ON storage.objects%'
     and pg_get_triggerdef(t.oid) like '%bucket_id = ''avatars''%';
  insert into _r values (37,'H05 the avatar_upload_log trigger is AFTER INSERT on storage.objects, scoped WHEN bucket_id=avatars','1',v_n::text,v_n=1);
end
$green$;

-- ---------------------------------------------------------------------------
-- (4) VERDICT — raises on a NULL pass or an unexpected assertion count
-- ---------------------------------------------------------------------------
do $verdict$
declare v_n int;
begin
  select count(*) into v_n from _r;
  if v_n <> 37 then raise exception 'INCOMPLETE: % assertion rows, expected 37', v_n; end if;
  if exists (select 1 from _r where pass is null) then
    raise exception 'NULL pass value - an assertion evaluated to NULL and would have counted as neither';
  end if;
end
$verdict$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;
