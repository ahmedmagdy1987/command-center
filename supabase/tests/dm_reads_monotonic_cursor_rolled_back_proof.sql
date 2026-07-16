-- ============================================================================
-- Command Center — DM READ-CURSOR MONOTONICITY PROOF (9 assertions)
-- ============================================================================
-- Surface: public.dm_reads.last_read_at monotonicity + participant-gating.
-- Objects under test (migration 20260715235959_dm_reads_monotonic_cursor.sql
--   on top of 20260604125857_direct_messages.sql):
--   * trigger  dm_reads_monotonic  (BEFORE UPDATE) -> public.dm_reads_monotonic_cursor()
--       CLAMPS a backward write: if new.last_read_at < old.last_read_at then
--       new.last_read_at := old.last_read_at.  It does NOT raise — a backward
--       markRead is a legitimate re-write of an older cover time, so the row
--       still updates (row_count=1) but the stored cursor never regresses.
--   * policies dm_reads_update_own / dm_reads_insert_own — user_id = auth.uid()
--       AND private.is_dm_participant(conversation_id): only a participant may
--       write, and only their own cursor row.
--
-- WHAT DISCRIMINATES (this repo has a history of vacuous proofs):
--   * R05 is the CORE property. Forward advance (R01/R02) moves the stored value;
--     the backward write (R04/R05) must leave it at the forward value. If the
--     trigger were removed, the backward UPDATE would store the OLDER value and
--     R05 goes RED. So R05 fails iff the guard is absent.
--   * R04 pins that a backward write is CLAMPED, not rejected (1 row, no error) —
--     the deliberate design choice (vs a 42501 immutability trigger).
--   * R06 shows the clamp does not freeze the row: a later forward write still
--     advances — so R05 can't pass by the row simply being locked.
--   * The participant-gating denies (R08 insert, R09 update) are paired with a
--     matching ALLOW (R07: the OTHER participant inserts their own cursor). So an
--     'ok:0'/'42501' can't be a vacuous "nobody can ever write / row absent".
--
-- Method: fixtures planted as `postgres` (bypassrls) to CONSTRUCT the scenario;
-- EVERY assertion runs as `authenticated` + request.jwt.claims, so RLS + the
-- trigger are under test. HARNESS GUARD proves the impersonation is real (else the
-- whole script silently passes as bypassrls postgres). ANTI-VACUITY GUARD proves a
-- legit participant sees the cursor row and the non-participant is a real workspace
-- member (so the deny is participant-specific, not membership). Fully rolled back;
-- fixtures carry a unique suffix; verified no residue.
-- ============================================================================

begin;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;

create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role','authenticated','email', coalesce(v_email,''))::text, true);
end $fn$;

do $mono$
declare
  v_sfx text := replace(gen_random_uuid()::text,'-','');
  v_u1 uuid := gen_random_uuid();   -- participant A (owns the cursor row under test)
  v_u2 uuid := gen_random_uuid();   -- participant B (allow-control writer)
  v_u3 uuid := gen_random_uuid();   -- non-participant, but a real member of the workspace
  v_ws uuid := gen_random_uuid();
  v_lo uuid; v_hi uuid; d_conv uuid;
  v_base  timestamptz := now() - interval '3 hours';
  v_fwd   timestamptz := now() - interval '1 hour';   -- forward from base
  v_back  timestamptz := now() - interval '2 hours';  -- backward from fwd (> base, < fwd)
  v_fwd2  timestamptz := now() + interval '1 hour';   -- forward from fwd
  v_stored timestamptz;
  v_n int; v_actual text;
begin
  -- ===== fixtures (as postgres / bypassrls) =====
  insert into auth.users (id,email,aud,role) values
    (v_u1,'mono-u1-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_u2,'mono-u2-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_u3,'mono-u3-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.workspaces (id,name,owner_id,slug)
    values (v_ws,'MONO Throwaway WS',v_u1,'mono-ws-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_ws,v_u1,'owner'),(v_ws,v_u2,'member'),(v_ws,v_u3,'member');

  v_lo := least(v_u1,v_u2); v_hi := greatest(v_u1,v_u2);
  insert into public.dm_conversations (workspace_id,user_lo,user_hi)
    values (v_ws,v_lo,v_hi) returning id into d_conv;
  -- genesis cursor row for participant A (BEFORE UPDATE trigger does not fire on INSERT)
  insert into public.dm_reads (conversation_id,user_id,last_read_at) values (d_conv,v_u1,v_base);

  -- ===== HARNESS GUARD: impersonation must be real, else every assertion is worthless =====
  perform pg_temp.imp(v_u1);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role not switched (current_user=%)', current_user; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: assertion role bypasses RLS'; end if;
  if auth.uid() is distinct from v_u1 then execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid() != impersonated uid'; end if;
  execute 'reset role';

  -- ===== ANTI-VACUITY GUARD =====
  -- (a) participant A can actually SEE the cursor row under test (so its value reads are real)
  perform pg_temp.imp(v_u1);
  select count(*) into v_n from public.dm_reads where conversation_id=d_conv and user_id=v_u1;
  if v_n <> 1 then execute 'reset role'; raise exception 'VACUOUS: participant cannot see own cursor row (count=%)', v_n; end if;
  execute 'reset role';
  -- (b) the non-participant IS a genuine member of the workspace (so the deny is participant-gating, not membership)
  perform pg_temp.imp(v_u3);
  select count(*) into v_n from public.workspace_members where workspace_id=v_ws and user_id=v_u3;
  if v_n <> 1 then execute 'reset role'; raise exception 'VACUOUS: non-participant is not a workspace member (count=%)', v_n; end if;
  select count(*) into v_n from public.dm_reads where conversation_id=d_conv;   -- non-participant can't read the cursor
  if v_n <> 0 then execute 'reset role'; raise exception 'VACUOUS/LEAK: non-participant sees dm_reads (count=%)', v_n; end if;
  execute 'reset role';

  -- ========================= ASSERTIONS =========================

  -- R01/R02 — forward advance succeeds and STORES the advanced value (allow control)
  perform pg_temp.imp(v_u1);
  update public.dm_reads set last_read_at=v_fwd where conversation_id=d_conv and user_id=v_u1;
  get diagnostics v_n=row_count;
  select last_read_at into v_stored from public.dm_reads where conversation_id=d_conv and user_id=v_u1;
  execute 'reset role';
  insert into _r values (1,'R01 participant forward advance updates exactly 1 row (allow control)','1 rows',v_n::text||' rows',v_n=1);
  insert into _r values (2,'R02 forward advance stores the advanced value',
    'MATCH(fwd)', case when v_stored=v_fwd then 'MATCH(fwd)' else 'stored='||v_stored::text end, v_stored=v_fwd);

  -- R03 — equal write is untouched (row updates, value stays at fwd)
  perform pg_temp.imp(v_u1);
  update public.dm_reads set last_read_at=v_fwd where conversation_id=d_conv and user_id=v_u1;
  get diagnostics v_n=row_count;
  select last_read_at into v_stored from public.dm_reads where conversation_id=d_conv and user_id=v_u1;
  execute 'reset role';
  insert into _r values (3,'R03 equal write keeps the stored value at fwd',
    'MATCH(fwd)', case when v_n=1 and v_stored=v_fwd then 'MATCH(fwd)' else v_n::text||' rows stored='||v_stored::text end,
    v_n=1 and v_stored=v_fwd);

  -- R04 — backward write is CLAMPED, not rejected: 1 row affected, no exception
  perform pg_temp.imp(v_u1);
  begin
    update public.dm_reads set last_read_at=v_back where conversation_id=d_conv and user_id=v_u1;
    get diagnostics v_n=row_count;
    v_actual := v_n::text||' rows';
  exception when others then v_actual := 'ERR:'||sqlstate; end;
  select last_read_at into v_stored from public.dm_reads where conversation_id=d_conv and user_id=v_u1;
  execute 'reset role';
  insert into _r values (4,'R04 backward write is CLAMPED not rejected (1 row, no error)','1 rows',v_actual,v_actual='1 rows');

  -- R05 — CORE: the backward write did NOT regress the stored cursor (still fwd, not back)
  insert into _r values (5,'R05 CORE: backward write does NOT regress stored cursor',
    'MATCH(fwd)', case when v_stored=v_fwd then 'MATCH(fwd)'
                       when v_stored=v_back then 'REGRESSED(back)'
                       else 'stored='||v_stored::text end, v_stored=v_fwd);

  -- R06 — the clamp does not freeze the row: a later forward write still advances
  perform pg_temp.imp(v_u1);
  update public.dm_reads set last_read_at=v_fwd2 where conversation_id=d_conv and user_id=v_u1;
  get diagnostics v_n=row_count;
  select last_read_at into v_stored from public.dm_reads where conversation_id=d_conv and user_id=v_u1;
  execute 'reset role';
  insert into _r values (6,'R06 forward write after a clamp still advances',
    'MATCH(fwd2)', case when v_n=1 and v_stored=v_fwd2 then 'MATCH(fwd2)' else v_n::text||' rows stored='||v_stored::text end,
    v_n=1 and v_stored=v_fwd2);

  -- R07 — ALLOW control for the gate: the OTHER participant may INSERT their own cursor
  perform pg_temp.imp(v_u2);
  begin
    insert into public.dm_reads (conversation_id,user_id,last_read_at) values (d_conv,v_u2,now());
    v_actual := 'ALLOWED';
  exception when others then v_actual := 'ERR:'||sqlstate; end;
  execute 'reset role';
  insert into _r values (7,'R07 participant B inserts own cursor (allow control)','ALLOWED',v_actual,v_actual='ALLOWED');

  -- R08 — participant-gated: a NON-participant cannot INSERT a cursor into the conversation
  perform pg_temp.imp(v_u3);
  begin
    insert into public.dm_reads (conversation_id,user_id,last_read_at) values (d_conv,v_u3,now());
    v_actual := 'ALLOWED';
  exception when others then v_actual := sqlstate; end;
  execute 'reset role';
  insert into _r values (8,'R08 non-participant INSERT cursor into conversation is denied','42501',v_actual,v_actual='42501');

  -- R09 — participant-gated: a NON-participant cannot UPDATE another conversation's cursor row
  perform pg_temp.imp(v_u3);
  update public.dm_reads set last_read_at=v_fwd2 where conversation_id=d_conv and user_id=v_u1;
  get diagnostics v_n=row_count;
  execute 'reset role';
  insert into _r values (9,'R09 non-participant UPDATE of another''s cursor matches 0 rows','0 rows',v_n::text||' rows',v_n=0);

  -- CORE regression cross-check: after the non-participant's failed write, the cursor is still fwd2
  perform pg_temp.imp(v_u1);
  select last_read_at into v_stored from public.dm_reads where conversation_id=d_conv and user_id=v_u1;
  execute 'reset role';
  if v_stored <> v_fwd2 then raise exception 'POSTCONDITION: cursor unexpectedly changed to %', v_stored; end if;

  -- completeness guard
  select count(*) into v_n from _r;
  if v_n <> 9 then raise exception 'INCOMPLETE: % assertion rows, expected 9', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$mono$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;