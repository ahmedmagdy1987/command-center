-- ============================================================================================
-- ROLLED-BACK PROOF — team-chat read cursor (`chat_reads`)
-- STATUS: RUN GREEN 26/26 on 2026-07-19 against project nqlzjuxqgajeoypyzlnv, before applying.
--         Shipped as migration 20260719134628_chat_reads_team_chat_read_cursor.sql.
--
-- Run the WHOLE file as ONE execute_sql call. It opens a transaction, asserts, and ROLLS BACK.
-- Read the `failed` column of the result — a RED run still returns success from execute_sql.
--
-- FIXTURES ARE SYNTHETIC. Every actor and workspace is created here with a gen_random_uuid() suffix
-- and thrown away — this proof never reads or mutates a live member, workspace, or role.
--
-- METHODOLOGY (why the harness RAISES instead of recording): `postgres` on this project has
-- rolbypassrls = true, so an assertion that forgets `set local role authenticated` silently bypasses
-- RLS and proves nothing. The harness checks the ROLE PROPERTY, not just the role NAME, and aborts
-- the run on failure — a control observable only after the fact, in a table nobody re-reads, is not
-- a control.
--
-- Denial assertions capture the EXACT SQLSTATE, and where two different mechanisms both yield 42501
-- (an RLS WITH CHECK failure vs. the identity-lock trigger) they ALSO assert the message text.
-- Otherwise the assertion would pass even if the control it names were removed.
--
-- STRUCTURE: fixtures -> harness -> RED-1 (feature absent) -> DDL part 1 (no identity lock) ->
-- RED-2 (the vacate bypass genuinely WORKS without the lock) -> DDL part 2 (the lock) -> GREEN.
-- DDL sits at top level: a bare CREATE OR REPLACE FUNCTION cannot run inside a plpgsql DO block.
--
-- LANDMINE (house rule, learned on 20260718195827): this file RE-CREATES the DDL under test. If the
-- shipped migration's policies, grants, or trigger bodies change, CHANGE THEM HERE TOO, or this
-- suite silently proves a body that no longer ships.
-- ============================================================================================
begin;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;
create temp table _f(k text primary key, v uuid) on commit drop;

-- Impersonation helper — the house pattern (dm_reads_monotonic_cursor_rolled_back_proof.sql:42-51).
create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role','authenticated','email', coalesce(v_email,''))::text, true);
end $fn$;

-- ============================================================ fixtures (as postgres / bypassrls)
do $fixtures$
declare
  v_sfx text  := replace(gen_random_uuid()::text,'-','');
  v_u1  uuid  := gen_random_uuid();   -- owner of WS_A, and owner of WS_B (needed for the vacate attack)
  v_u2  uuid  := gen_random_uuid();   -- member of WS_A — the receipt peer
  v_u3  uuid  := gen_random_uuid();   -- GUEST of WS_A
  v_u4  uuid  := gen_random_uuid();   -- outsider — belongs to neither WS_A nor WS_B
  v_wsa uuid  := gen_random_uuid();
  v_wsb uuid  := gen_random_uuid();
  v_wsx uuid  := gen_random_uuid();   -- the outsider's own tenant
begin
  insert into auth.users (id,email,aud,role) values
    (v_u1,'cr-u1-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_u2,'cr-u2-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_u3,'cr-u3-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_u4,'cr-u4-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.workspaces (id,name,owner_id,slug) values
    (v_wsa,'CR Throwaway A',v_u1,'cr-a-'||v_sfx),
    (v_wsb,'CR Throwaway B',v_u1,'cr-b-'||v_sfx),
    (v_wsx,'CR Throwaway X',v_u4,'cr-x-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_wsa,v_u1,'owner'), (v_wsa,v_u2,'member'), (v_wsa,v_u3,'guest'),
    (v_wsb,v_u1,'owner'),
    (v_wsx,v_u4,'owner');

  insert into _f values ('u1',v_u1),('u2',v_u2),('u3',v_u3),('u4',v_u4),
                        ('wsa',v_wsa),('wsb',v_wsb),('wsx',v_wsx);
end $fixtures$;

-- ============================================================ HARNESS (aborts on failure)
do $harness$
declare v_u1 uuid; v_u4 uuid; v_wsa uuid; v_state text; v_bypass boolean;
begin
  select v into v_u1  from _f where k='u1';
  select v into v_u4  from _f where k='u4';
  select v into v_wsa from _f where k='wsa';

  perform pg_temp.imp(v_u1);

  if current_user <> 'authenticated' then
    execute 'reset role'; raise exception 'HARNESS BROKEN: role is %, expected authenticated', current_user;
  end if;

  -- The PROPERTY, not the name. This is the control the rolbypassrls lesson exists for.
  select rolbypassrls into v_bypass from pg_roles where rolname = current_user;
  if coalesce(v_bypass,true) then
    execute 'reset role'; raise exception 'HARNESS BROKEN: current role bypasses RLS';
  end if;

  if auth.uid() is distinct from v_u1 then
    execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid()=% expected %', auth.uid(), v_u1;
  end if;

  -- A write we KNOW is denied must be denied WITH 42501. Uses the OUTSIDER and a workspace they are
  -- not in, so there is no pre-existing row and a unique violation cannot masquerade as a denial.
  begin
    insert into public.workspace_members (workspace_id,user_id,role) values (v_wsa,v_u4,'owner');
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  if v_state <> '42501' then
    raise exception 'HARNESS BROKEN: control write returned %, expected 42501 (RLS not engaged)', v_state;
  end if;
end $harness$;

-- ============================================================ REWIND — recreate the PRE-MIGRATION state
-- This file has TWO lifecycles, and they conflict. BEFORE 20260719134628 was applied it demonstrated a
-- missing feature; now that the migration is LIVE it has to serve as a re-runnable REGRESSION suite.
-- The RED phase below performs the PK-vacate attack — and the now-live chat_reads_lock_identity trigger
-- rejects it with 42501, which aborts the whole transaction and takes the entire suite with it. That is
-- not hypothetical: it is exactly what happened on the first post-apply re-run, where this file scored
-- no assertions at all rather than failing gracefully.
--
-- So REWIND first: drop the control under test, transaction-locally, so RED can still demonstrate the
-- disease against a faithful copy of the pre-migration rules. DDL PART 2 puts it back and GREEN
-- re-proves the cure. Everything here is inside the enclosing transaction and is undone by the final
-- rollback; dropping a TRIGGER takes a brief lock on chat_reads and never touches a row.
--
-- The old assertion here ("no team-chat read cursor exists") was a HISTORICAL claim — true only until
-- the migration landed, and permanently false afterwards. Its evidentiary job is done and recorded in
-- the migration header and commit 33a0429. It is replaced by an anti-vacuity control that is true in
-- BOTH worlds and actually guards the RED below.
do $rewind$
begin
  if to_regclass('public.chat_reads') is not null then
    execute 'drop trigger if exists chat_reads_lock_identity on public.chat_reads';
  end if;
end $rewind$;

-- Anti-vacuity for RED-2: if the rewind silently failed, the vacate would be BLOCKED and RED-2 would
-- fail for entirely the wrong reason (or abort the run). Assert the rewound state explicitly.
-- `tgrelid = to_regclass(...)` is null-safe: on a database where the table does not exist yet the
-- comparison matches nothing, so the lock is vacuously absent and the pre-apply run still works.
insert into _r values (1,'REWIND: identity lock is absent, so RED-2 can demonstrate the bypass','absent',
  coalesce((select string_agg(t.tgname,',') from pg_trigger t
             where t.tgrelid = to_regclass('public.chat_reads')
               and not t.tgisinternal and t.tgname = 'chat_reads_lock_identity'),'absent'),
  not exists (select 1 from pg_trigger t
               where t.tgrelid = to_regclass('public.chat_reads')
                 and not t.tgisinternal and t.tgname = 'chat_reads_lock_identity'));

-- ============================================================ DDL PART 1 (everything but the lock)
create table if not exists public.chat_reads (
  workspace_id uuid        not null references public.workspaces(id) on delete cascade,
  user_id      uuid        not null references auth.users(id)        on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists chat_reads_user_id_idx on public.chat_reads(user_id);

create or replace function private.can_see_chat_receipt(p_ws uuid, p_row_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_see_team_chat((select auth.uid()), p_ws)
     and private.can_see_team_chat(p_row_user, p_ws);
$$;
revoke all     on function private.can_see_chat_receipt(uuid, uuid) from public, anon;
grant  execute on function private.can_see_chat_receipt(uuid, uuid) to authenticated;

alter table public.chat_reads enable row level security;

drop policy if exists chat_reads_select_participant on public.chat_reads;
create policy chat_reads_select_participant on public.chat_reads for select to authenticated
using ( private.can_see_chat_receipt(workspace_id, user_id) );

drop policy if exists chat_reads_insert_own on public.chat_reads;
create policy chat_reads_insert_own on public.chat_reads for insert to authenticated
with check ( user_id = (select auth.uid())
             and private.is_workspace_member(workspace_id)
             and private.workspace_role(workspace_id) <> 'guest' );

drop policy if exists chat_reads_update_own on public.chat_reads;
create policy chat_reads_update_own on public.chat_reads for update to authenticated
using      ( user_id = (select auth.uid())
             and private.is_workspace_member(workspace_id)
             and private.workspace_role(workspace_id) <> 'guest' )
with check ( user_id = (select auth.uid())
             and private.is_workspace_member(workspace_id)
             and private.workspace_role(workspace_id) <> 'guest' );

revoke all on public.chat_reads from public, anon, authenticated;
grant select, insert, update on public.chat_reads to authenticated;

create or replace function public.chat_reads_clamp_cursor()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.last_read_at > now() then
    new.last_read_at := now();
  end if;
  if tg_op = 'UPDATE' and new.last_read_at < old.last_read_at then
    new.last_read_at := old.last_read_at;
  end if;
  return new;
end;
$fn$;
revoke all on function public.chat_reads_clamp_cursor() from public, anon, authenticated;

drop trigger if exists chat_reads_clamp on public.chat_reads;
create trigger chat_reads_clamp
  before insert or update on public.chat_reads
  for each row execute function public.chat_reads_clamp_cursor();

-- ============================================================ RED-2 — the bypass is REAL
-- Anti-vacuity for the identity lock. With the clamp trigger in place but NO identity lock, run the
-- two-step vacate attack and show the peer-visible cursor genuinely REGRESSES. If this assertion
-- ever goes false, the lock trigger tested later is guarding nothing and this suite is theatre.
do $red2$
declare u1 uuid; wsa uuid; wsb uuid; v_ts timestamptz;
  t_fwd  timestamptz := now() - interval '1 hour';
  t_back timestamptz := now() - interval '3 hours';
begin
  select v into u1 from _f where k='u1';
  select v into wsa from _f where k='wsa'; select v into wsb from _f where k='wsb';

  perform pg_temp.imp(u1);
  insert into public.chat_reads (workspace_id,user_id,last_read_at) values (wsa,u1,t_fwd);
  update public.chat_reads set workspace_id = wsb where workspace_id = wsa and user_id = u1;  -- vacate
  insert into public.chat_reads (workspace_id,user_id,last_read_at) values (wsa,u1,t_back);   -- re-genesis
  select last_read_at into v_ts from public.chat_reads where workspace_id = wsa and user_id = u1;
  execute 'reset role';

  insert into _r values (2,'RED: without the identity lock the cursor CAN be regressed',
    'stored=t_back (regressed)',
    case when v_ts = t_back then 'REGRESSED(t_back)' else 'stored='||coalesce(v_ts::text,'<null>') end,
    v_ts = t_back);

  -- Reset state for GREEN. SCOPED TO THE FIXTURES, deliberately: an unqualified
  -- `delete from public.chat_reads` here runs as the bypassrls session role and would be a match-all
  -- delete of every live read cursor, saved only by the rollback and holding a whole-table lock
  -- meanwhile. Harmless the first time (the table is brand new and empty), NOT harmless once this
  -- file lives in supabase/tests/ and is re-run against a chat_reads carrying real cursors. Same
  -- defect, same fix, as the one caught in the dm_reads proof — and the shape the repo banned after
  -- a match-all delete wiped live task data.
  delete from public.chat_reads
   where workspace_id in (select v from _f where k in ('wsa','wsb','wsx'));
end $red2$;

-- ============================================================ DDL PART 2 — the identity lock
create or replace function public.chat_reads_lock_identity()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.user_id is distinct from old.user_id then
    raise exception 'chat_reads identity is immutable (workspace_id, user_id)' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.chat_reads_lock_identity() from public, anon, authenticated;

drop trigger if exists chat_reads_lock_identity on public.chat_reads;
create trigger chat_reads_lock_identity
  before update on public.chat_reads
  for each row execute function public.chat_reads_lock_identity();

-- ============================================================ GREEN
do $green$
declare
  u1 uuid; u2 uuid; u3 uuid; u4 uuid; wsa uuid; wsb uuid; wsx uuid;
  t_base timestamptz := now() - interval '3 hours';
  t_fwd  timestamptz := now() - interval '1 hour';
  t_back timestamptz := now() - interval '2 hours';   -- later than base, earlier than fwd
  v_n int; v_state text; v_msg text; v_ts timestamptz; v_ok boolean;
begin
  select v into u1 from _f where k='u1';  select v into u2 from _f where k='u2';
  select v into u3 from _f where k='u3';  select v into u4 from _f where k='u4';
  select v into wsa from _f where k='wsa'; select v into wsb from _f where k='wsb';
  select v into wsx from _f where k='wsx';

  ---------------------------------------------------------------- 3. member writes OWN cursor
  perform pg_temp.imp(u1);
  begin
    insert into public.chat_reads (workspace_id,user_id,last_read_at) values (wsa,u1,t_base);
    get diagnostics v_n = row_count; v_state := 'OK';
  exception when others then get stacked diagnostics v_state = returned_sqlstate; v_n := 0;
  end;
  execute 'reset role';
  insert into _r values (3,'member inserts OWN cursor','rows=1','rows='||v_n||' state='||v_state, v_n = 1);

  ---------------------------------------------------------------- 4. cannot write ANOTHER's cursor
  perform pg_temp.imp(u1);
  begin
    insert into public.chat_reads (workspace_id,user_id,last_read_at) values (wsa,u2,t_fwd);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (4,'member CANNOT insert another user cursor','42501',v_state, v_state = '42501');

  ---------------------------------------------------------------- 5. peer genesis + receipt visibility
  perform pg_temp.imp(u2);
  insert into public.chat_reads (workspace_id,user_id,last_read_at) values (wsa,u2,t_base);
  execute 'reset role';

  perform pg_temp.imp(u1);
  select count(*) into v_n from public.chat_reads where workspace_id = wsa and user_id = u2;
  execute 'reset role';
  insert into _r values (5,'member CAN see a co-member cursor (receipts work)','rows=1','rows='||v_n, v_n = 1);

  ---------------------------------------------------------------- 6. cannot UPDATE another's cursor
  perform pg_temp.imp(u1);
  update public.chat_reads set last_read_at = t_fwd where workspace_id = wsa and user_id = u2;
  get diagnostics v_n = row_count;            -- USING filters the row out: 0 rows, no error
  execute 'reset role';
  insert into _r values (6,'member CANNOT update another user cursor','rows=0','rows='||v_n, v_n = 0);

  ---------------------------------------------------------------- 7/8. monotonic clamp
  perform pg_temp.imp(u1);
  update public.chat_reads set last_read_at = t_fwd  where workspace_id = wsa and user_id = u1;
  update public.chat_reads set last_read_at = t_back where workspace_id = wsa and user_id = u1;  -- backwards
  select last_read_at into v_ts from public.chat_reads where workspace_id = wsa and user_id = u1;
  execute 'reset role';
  insert into _r values (7,'cursor cannot move BACKWARD (clamped, not raised)','stored=t_fwd',
    case when v_ts = t_fwd then 'MATCH(t_fwd)' else 'stored='||coalesce(v_ts::text,'<null>') end, v_ts = t_fwd);

  perform pg_temp.imp(u1);
  update public.chat_reads set last_read_at = t_fwd + interval '5 min'
    where workspace_id = wsa and user_id = u1;
  select last_read_at into v_ts from public.chat_reads where workspace_id = wsa and user_id = u1;
  execute 'reset role';
  insert into _r values (8,'cursor CAN move forward','stored=t_fwd+5m',
    case when v_ts = t_fwd + interval '5 min' then 'MATCH' else 'stored='||coalesce(v_ts::text,'<null>') end,
    v_ts = t_fwd + interval '5 min');

  ---------------------------------------------------------------- 9. the REAL client path: UPSERT
  -- PostgREST compiles .upsert() to ON CONFLICT DO UPDATE SET <EVERY payload column>, including the
  -- conflict-target columns — NOT just the one column that changed. Reproduced exactly here, because
  -- a narrower hand-written SET list would pass even under a column grant that breaks the real app.
  perform pg_temp.imp(u1);
  begin
    insert into public.chat_reads (workspace_id,user_id,last_read_at) values (wsa,u1,t_base)
      on conflict (workspace_id,user_id) do update
        set workspace_id = excluded.workspace_id,
            user_id      = excluded.user_id,
            last_read_at = excluded.last_read_at;
    v_state := 'OK';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  select last_read_at into v_ts from public.chat_reads where workspace_id = wsa and user_id = u1;
  execute 'reset role';
  insert into _r values (9,'PostgREST-shaped UPSERT succeeds and is clamped','OK & stored=t_fwd+5m',
    'state='||v_state||' stored='||coalesce(v_ts::text,'<null>'),
    v_state = 'OK' and v_ts = t_fwd + interval '5 min');

  ---------------------------------------------------------------- 10/11. identity lock
  -- Assert the MESSAGE, not just 42501: an RLS WITH CHECK failure is also 42501, so a SQLSTATE-only
  -- assertion would pass even with the lock trigger removed.
  perform pg_temp.imp(u1);
  begin
    update public.chat_reads set workspace_id = wsb where workspace_id = wsa and user_id = u1;
    v_state := 'NO ERROR'; v_msg := '';
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  execute 'reset role';
  insert into _r values (10,'cannot move a row off its PK (identity lock)','42501 + identity message',
    v_state||' / '||v_msg, v_state = '42501' and v_msg like '%identity is immutable%');

  perform pg_temp.imp(u1);
  begin
    update public.chat_reads set user_id = u2 where workspace_id = wsa and user_id = u1;
    v_state := 'NO ERROR'; v_msg := '';
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  execute 'reset role';
  insert into _r values (11,'cannot reassign a cursor to another user (identity lock)','42501 + identity message',
    v_state||' / '||v_msg, v_state = '42501' and v_msg like '%identity is immutable%');

  ---------------------------------------------------------------- 12. future cap
  -- now() is transaction-stable, so an exact comparison is safe here.
  perform pg_temp.imp(u1);
  update public.chat_reads set last_read_at = now() + interval '100 years'
    where workspace_id = wsa and user_id = u1;
  select last_read_at into v_ts from public.chat_reads where workspace_id = wsa and user_id = u1;
  execute 'reset role';
  insert into _r values (12,'cursor cannot be set into the FUTURE (capped at now())','stored=now()',
    case when v_ts = now() then 'MATCH(now())' else 'stored='||coalesce(v_ts::text,'<null>') end, v_ts = now());

  ---------------------------------------------------------------- 13. no DELETE path
  perform pg_temp.imp(u1);
  begin
    delete from public.chat_reads where workspace_id = wsa and user_id = u1;
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (13,'DELETE is denied (42501, not a silent 0 rows)','42501',v_state, v_state = '42501');

  ---------------------------------------------------------------- 14-16. outsider (with anti-vacuity)
  -- ANTI-VACUITY: prove the outsider's impersonation actually works before trusting their zeroes.
  -- A failed set_config would leave auth.uid() NULL and make every "sees 0" assertion pass for the
  -- wrong reason.
  perform pg_temp.imp(u4);
  select count(*) into v_n from public.workspace_members where workspace_id = wsx and user_id = u4;
  execute 'reset role';
  insert into _r values (14,'ANTI-VACUITY: outsider CAN read their own membership','rows=1','rows='||v_n, v_n = 1);

  perform pg_temp.imp(u4);
  select count(*) into v_n from public.chat_reads where workspace_id = wsa;
  execute 'reset role';
  insert into _r values (15,'outsider sees ZERO rows in WS_A','rows=0','rows='||v_n, v_n = 0);

  perform pg_temp.imp(u4);
  begin
    insert into public.chat_reads (workspace_id,user_id,last_read_at) values (wsa,u4,t_fwd);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (16,'outsider CANNOT write into WS_A','42501',v_state, v_state = '42501');

  ---------------------------------------------------------------- 17-19. guest (with anti-vacuity)
  perform pg_temp.imp(u3);
  select count(*) into v_n from public.workspace_members where workspace_id = wsa and user_id = u3;
  execute 'reset role';
  insert into _r values (17,'ANTI-VACUITY: guest CAN read their own membership','rows=1','rows='||v_n, v_n = 1);

  perform pg_temp.imp(u3);
  begin
    insert into public.chat_reads (workspace_id,user_id,last_read_at) values (wsa,u3,t_fwd);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (18,'guest CANNOT write a cursor','42501',v_state, v_state = '42501');

  perform pg_temp.imp(u3);
  select count(*) into v_n from public.chat_reads where workspace_id = wsa;
  execute 'reset role';
  insert into _r values (19,'guest sees ZERO receipt rows','rows=0','rows='||v_n, v_n = 0);

  ---------------------------------------------------------------- 20. THE DEMOTION CASE
  -- The reason the SELECT policy evaluates the ROW OWNER's visibility and not just the caller's.
  perform pg_temp.imp(u1);
  select count(*) into v_n from public.chat_reads where workspace_id = wsa and user_id = u2;
  execute 'reset role';
  v_ok := (v_n = 1);

  update public.workspace_members set role = 'guest' where workspace_id = wsa and user_id = u2;

  perform pg_temp.imp(u1);
  select count(*) into v_n from public.chat_reads where workspace_id = wsa and user_id = u2;
  execute 'reset role';
  insert into _r values (20,'DEMOTED member disappears from peers'' receipts','visible=t then rows=0',
    'visible_as_member='||v_ok||' rows_as_guest='||v_n, v_ok and v_n = 0);
  update public.workspace_members set role = 'member' where workspace_id = wsa and user_id = u2;

  ---------------------------------------------------------------- 21. anon
  execute 'set local role anon';
  begin
    select count(*) into v_n from public.chat_reads;
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (21,'anon is denied outright (42501, not an empty result)','42501',v_state, v_state = '42501');
end $green$;

-- ============================================================ catalog hardening
insert into _r
select 22,'helper is SECURITY DEFINER + search_path-pinned','prosecdef & search_path set',
  'prosecdef='||p.prosecdef||' proconfig='||coalesce(array_to_string(p.proconfig,','),'<null>'),
  p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c
                           where c like 'search\_path=%')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='private' and p.proname='can_see_chat_receipt';

insert into _r
select 23,'both trigger fns are DEFINER, pinned, and not client-executable','all true',
  string_agg(p.proname||':sd='||p.prosecdef||',auth='||has_function_privilege('authenticated',p.oid,'execute'), ' '),
  bool_and(p.prosecdef)
  and bool_and(exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search\_path=%'))
  and bool_and(not has_function_privilege('authenticated',p.oid,'execute'))
  and bool_and(not has_function_privilege('anon',p.oid,'execute'))
  and count(*) = 2
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and p.proname in ('chat_reads_clamp_cursor','chat_reads_lock_identity');

insert into _r values (24,'grants are least-privilege (no DELETE, nothing for anon)',
  'sel/ins/upd=t · del=f · anon all f',
  'sel='||has_table_privilege('authenticated','public.chat_reads','select')||
  ' ins='||has_table_privilege('authenticated','public.chat_reads','insert')||
  ' upd='||has_table_privilege('authenticated','public.chat_reads','update')||
  ' del='||has_table_privilege('authenticated','public.chat_reads','delete')||
  ' anon.sel='||has_table_privilege('anon','public.chat_reads','select')||
  ' anon.ins='||has_table_privilege('anon','public.chat_reads','insert'),
      has_table_privilege('authenticated','public.chat_reads','select')
  and has_table_privilege('authenticated','public.chat_reads','insert')
  and has_table_privilege('authenticated','public.chat_reads','update')
  and not has_table_privilege('authenticated','public.chat_reads','delete')
  and not has_table_privilege('anon','public.chat_reads','select')
  and not has_table_privilege('anon','public.chat_reads','insert'));

insert into _r values (25,'both integrity triggers are installed','2 triggers',
  (select coalesce(string_agg(tgname,','order by tgname),'<none>') from pg_trigger
    where tgrelid = 'public.chat_reads'::regclass and not tgisinternal),
  (select count(*) from pg_trigger
    where tgrelid = 'public.chat_reads'::regclass and not tgisinternal
      and tgname in ('chat_reads_clamp','chat_reads_lock_identity')) = 2);

insert into _r values (26,'user_id FK is indexed (advisor: unindexed_foreign_keys)','present',
  (select coalesce(string_agg(indexname,','),'<none>') from pg_indexes
    where schemaname='public' and tablename='chat_reads' and indexname='chat_reads_user_id_idx'),
  exists (select 1 from pg_indexes
           where schemaname='public' and tablename='chat_reads' and indexname='chat_reads_user_id_idx'));

-- ============================================================ VERDICT
do $verdict$
declare v_total int; v_null int; v_fail int;
begin
  select count(*), count(*) filter (where pass is null), count(*) filter (where pass is false)
    into v_total, v_null, v_fail from _r;
  -- A NULL pass is counted by NEITHER "passed" nor "failed" in a naive tally, so a broken assertion
  -- can read green. Guard it explicitly. (NB: raising here aborts before the diagnostic SELECTs
  -- below, so on INCOMPLETE you get the error string, not the table — deliberate fail-loud.)
  if v_null > 0 then raise exception 'INCOMPLETE: % assertion(s) returned NULL pass', v_null; end if;
  if v_total <> 26 then raise exception 'INCOMPLETE: % assertion rows, expected 26', v_total; end if;
  if v_fail > 0 then raise notice 'RED: % assertion(s) FAILED — read the table below', v_fail; end if;
end $verdict$;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from _r;

select id, name, expected, actual, pass from _r order by id;

rollback;
