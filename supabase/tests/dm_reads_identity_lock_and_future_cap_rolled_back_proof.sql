-- ============================================================================================
-- ROLLED-BACK PROOF — dm_reads identity lock + future cap
-- STATUS: RUN GREEN 19/19 on 2026-07-19 against nqlzjuxqgajeoypyzlnv, before applying. The RED phase
--         reproduced BOTH holes against the then-live rules: the cursor really did regress to a past
--         timestamp, and a cursor dated 2126 was accepted. Shipped as migration
--         20260719134702_dm_reads_identity_lock_and_future_cap.sql.
--
-- Run the WHOLE file as ONE execute_sql call. It opens a transaction, asserts, and ROLLS BACK.
-- Read the `failed` column of the result — a RED run still returns success from execute_sql.
--
-- FIXTURES ARE SYNTHETIC. No live member, workspace, conversation or cursor is read or mutated.
--
-- The RED phase runs the repudiation attack against the CURRENT LIVE RULES and shows it SUCCEEDS.
-- That is the point of this file: the claim at 20260715235959:20-24 that the row "can never be
-- destroyed and re-genesised" is false, and assertions 2-3 demonstrate it rather than asserting it.
--
-- Denial assertions require SQLSTATE 42501 AND the trigger's message text, because an RLS WITH
-- CHECK failure is also 42501 — a SQLSTATE-only assertion would pass with the lock trigger removed.
--
-- LANDMINE (house rule, 20260718195827): this file RE-CREATES the DDL under test. If the shipped
-- migration's trigger bodies change, CHANGE THEM HERE TOO.
-- ============================================================================================
begin;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;
create temp table _f(k text primary key, v uuid) on commit drop;

create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role','authenticated','email', coalesce(v_email,''))::text, true);
end $fn$;

-- ============================================================ fixtures
do $fixtures$
declare
  v_sfx text := replace(gen_random_uuid()::text,'-','');
  u1 uuid := gen_random_uuid();   -- the attacker/actor: participant of BOTH conversations
  u2 uuid := gen_random_uuid();   -- peer in conversation A
  u3 uuid := gen_random_uuid();   -- peer in conversation B (so u1 has two conversations)
  u4 uuid := gen_random_uuid();   -- outsider, different tenant
  ws  uuid := gen_random_uuid();
  wsx uuid := gen_random_uuid();
  cA uuid; cB uuid;
begin
  insert into auth.users (id,email,aud,role) values
    (u1,'dmr-u1-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (u2,'dmr-u2-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (u3,'dmr-u3-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (u4,'dmr-u4-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.workspaces (id,name,owner_id,slug) values
    (ws ,'DMR Throwaway',u1,'dmr-'||v_sfx),
    (wsx,'DMR Outsider' ,u4,'dmr-x-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (ws,u1,'owner'), (ws,u2,'member'), (ws,u3,'member'), (wsx,u4,'owner');

  insert into public.dm_conversations (workspace_id,user_lo,user_hi)
    values (ws, least(u1,u2), greatest(u1,u2)) returning id into cA;
  insert into public.dm_conversations (workspace_id,user_lo,user_hi)
    values (ws, least(u1,u3), greatest(u1,u3)) returning id into cB;

  insert into _f values ('u1',u1),('u2',u2),('u3',u3),('u4',u4),('ws',ws),('cA',cA),('cB',cB);
end $fixtures$;

-- ============================================================ HARNESS (aborts on failure)
do $harness$
declare u1 uuid; u4 uuid; cA uuid; v_state text; v_bypass boolean;
begin
  select v into u1 from _f where k='u1';
  select v into u4 from _f where k='u4';
  select v into cA from _f where k='cA';

  perform pg_temp.imp(u1);
  if current_user <> 'authenticated' then
    execute 'reset role'; raise exception 'HARNESS BROKEN: role is %', current_user;
  end if;
  select rolbypassrls into v_bypass from pg_roles where rolname = current_user;
  if coalesce(v_bypass,true) then
    execute 'reset role'; raise exception 'HARNESS BROKEN: current role bypasses RLS';
  end if;
  if auth.uid() is distinct from u1 then
    execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid()=% expected %', auth.uid(), u1;
  end if;

  -- Control: a write we KNOW is denied. The outsider is not a participant of cA, and no row exists
  -- for them, so a unique violation cannot masquerade as a denial.
  perform pg_temp.imp(u4);
  begin
    insert into public.dm_reads (conversation_id,user_id,last_read_at) values (cA,u4,now());
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  if v_state <> '42501' then
    raise exception 'HARNESS BROKEN: control write returned %, expected 42501', v_state;
  end if;
end $harness$;

-- ============================================================ REWIND — recreate the PRE-MIGRATION state
-- Same two-lifecycle problem as the chat_reads proof, and here it is sharper: BOTH red assertions
-- attack holes that 20260719134702 has now CLOSED. Assertion 1's vacate is rejected 42501 by the live
-- dm_reads_lock_identity trigger, which aborts the whole transaction — on the first post-apply re-run
-- this file produced no assertions at all. Assertion 2's future-dated cursor is silently capped by the
-- live clamp, so it would fail rather than demonstrate anything.
--
-- REWIND restores a faithful copy of the pre-migration rules, transaction-locally, so RED still
-- demonstrates the disease. THE DDL UNDER TEST below then re-applies the fix and GREEN re-proves the
-- cure — which is the arrangement that makes this file a real regression suite rather than a one-shot.
-- All of it is undone by the final rollback.
--
-- NB the clamp must be rewound too, not just the lock: reverting it to the pre-migration body (backward
-- clamp only, BEFORE UPDATE only, no future cap and no tg_op guard) is what lets assertion 2 land.
-- This body is 20260715235959's, reproduced exactly.
do $rewind$
begin
  execute 'drop trigger if exists dm_reads_lock_identity on public.dm_reads';
end $rewind$;

create or replace function public.dm_reads_monotonic_cursor()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.last_read_at < old.last_read_at then
    new.last_read_at := old.last_read_at;
  end if;
  return new;
end;
$fn$;
revoke all on function public.dm_reads_monotonic_cursor() from public, anon, authenticated;

drop trigger if exists dm_reads_monotonic on public.dm_reads;
create trigger dm_reads_monotonic
  before update on public.dm_reads
  for each row execute function public.dm_reads_monotonic_cursor();

-- ============================================================ RED — the live bug, demonstrated
-- (Against the REWOUND rules above. If the rewind ever silently fails, these two assertions go red
-- rather than passing vacuously — they are their own anti-vacuity control.)
do $red$
declare
  u1 uuid; cA uuid; cB uuid; v_ts timestamptz;
  t_now  timestamptz := now();
  t_past timestamptz := now() - interval '10 years';
begin
  select v into u1 from _f where k='u1';
  select v into cA from _f where k='cA'; select v into cB from _f where k='cB';

  -- 1. Cursor repudiation via PK vacate + re-genesis, against the CURRENT live rules.
  perform pg_temp.imp(u1);
  insert into public.dm_reads (conversation_id,user_id,last_read_at) values (cA,u1,t_now);
  update public.dm_reads set conversation_id = cB where conversation_id = cA and user_id = u1;
  insert into public.dm_reads (conversation_id,user_id,last_read_at) values (cA,u1,t_past);
  select last_read_at into v_ts from public.dm_reads where conversation_id = cA and user_id = u1;
  execute 'reset role';
  insert into _r values (1,'RED: cursor CAN be walked backward today (peer "Seen" retracts)',
    'stored=t_past (regressed)',
    case when v_ts = t_past then 'REGRESSED(t_past)' else 'stored='||coalesce(v_ts::text,'<null>') end,
    v_ts = t_past);

  -- SCOPED to the throwaway conversations. An unqualified `delete from public.dm_reads` here would
  -- run as the session role (postgres, rolbypassrls) and wipe EVERY live read cursor in production —
  -- the rollback would be the only thing preventing it, and it would hold ROW EXCLUSIVE locks on
  -- every live row for the rest of the transaction, stalling real markRead writes. This is the
  -- match-all bulk-delete the repo banned after it wiped live task data (CLAUDE.md, landmines).
  delete from public.dm_reads where conversation_id in (select v from _f where k in ('cA','cB'));

  -- 2. No upper bound today.
  perform pg_temp.imp(u1);
  insert into public.dm_reads (conversation_id,user_id,last_read_at)
    values (cA,u1,now() + interval '100 years');
  select last_read_at into v_ts from public.dm_reads where conversation_id = cA and user_id = u1;
  execute 'reset role';
  insert into _r values (2,'RED: a FUTURE cursor is accepted today',
    'stored > now()','stored='||coalesce(v_ts::text,'<null>'), v_ts > now());

  delete from public.dm_reads where conversation_id in (select v from _f where k in ('cA','cB'));
end $red$;

-- ============================================================ THE DDL UNDER TEST (top level)
create or replace function public.dm_reads_lock_identity()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.conversation_id is distinct from old.conversation_id
     or new.user_id is distinct from old.user_id then
    raise exception 'dm_reads identity is immutable (conversation_id, user_id)' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.dm_reads_lock_identity() from public, anon, authenticated;

drop trigger if exists dm_reads_lock_identity on public.dm_reads;
create trigger dm_reads_lock_identity
  before update on public.dm_reads
  for each row execute function public.dm_reads_lock_identity();

create or replace function public.dm_reads_monotonic_cursor()
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
revoke all on function public.dm_reads_monotonic_cursor() from public, anon, authenticated;

drop trigger if exists dm_reads_monotonic on public.dm_reads;
create trigger dm_reads_monotonic
  before insert or update on public.dm_reads
  for each row execute function public.dm_reads_monotonic_cursor();

-- ============================================================ GREEN
do $green$
declare
  u1 uuid; u2 uuid; u3 uuid; u4 uuid; cA uuid; cB uuid;
  t_old timestamptz := now() - interval '3 hours';
  t_mid timestamptz := now() - interval '2 hours';
  t_new timestamptz := now() - interval '1 hour';
  v_ts timestamptz; v_state text; v_msg text; v_n int;
begin
  select v into u1 from _f where k='u1'; select v into u2 from _f where k='u2';
  select v into u3 from _f where k='u3'; select v into u4 from _f where k='u4';
  select v into cA from _f where k='cA'; select v into cB from _f where k='cB';

  ---------------------------------------------------------------- 3. genesis
  perform pg_temp.imp(u1);
  insert into public.dm_reads (conversation_id,user_id,last_read_at) values (cA,u1,t_old);
  select last_read_at into v_ts from public.dm_reads where conversation_id = cA and user_id = u1;
  execute 'reset role';
  insert into _r values (3,'genesis cursor still works','stored=t_old',
    case when v_ts = t_old then 'MATCH' else 'stored='||coalesce(v_ts::text,'<null>') end, v_ts = t_old);

  ---------------------------------------------------------------- 4/5. identity lock
  perform pg_temp.imp(u1);
  begin
    update public.dm_reads set conversation_id = cB where conversation_id = cA and user_id = u1;
    v_state := 'NO ERROR'; v_msg := '';
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  execute 'reset role';
  insert into _r values (4,'cannot move a cursor to another conversation','42501 + identity message',
    v_state||' / '||v_msg, v_state = '42501' and v_msg like '%identity is immutable%');

  perform pg_temp.imp(u1);
  begin
    update public.dm_reads set user_id = u2 where conversation_id = cA and user_id = u1;
    v_state := 'NO ERROR'; v_msg := '';
  exception when others then get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  execute 'reset role';
  insert into _r values (5,'cannot reassign a cursor to another user','42501 + identity message',
    v_state||' / '||v_msg, v_state = '42501' and v_msg like '%identity is immutable%');

  ---------------------------------------------------------------- 6. the attack is now dead
  -- Same two steps as RED assertion 1. The vacate must fail, so the slot is never free and the
  -- re-genesis cannot regress anything: the stored value must still be t_old.
  -- Capture BOTH sqlstates rather than swallowing, so this cannot pass for the wrong reason: the
  -- vacate must be denied 42501 and the re-genesis must hit 23505 (the slot was never freed).
  perform pg_temp.imp(u1);
  declare v_s1 text; v_s2 text;
  begin
    begin
      update public.dm_reads set conversation_id = cB where conversation_id = cA and user_id = u1;
      v_s1 := 'NO ERROR';
    exception when others then get stacked diagnostics v_s1 = returned_sqlstate;
    end;
    begin
      insert into public.dm_reads (conversation_id,user_id,last_read_at)
        values (cA,u1,now() - interval '10 years');
      v_s2 := 'NO ERROR';
    exception when others then get stacked diagnostics v_s2 = returned_sqlstate;
    end;
    select last_read_at into v_ts from public.dm_reads where conversation_id = cA and user_id = u1;
    execute 'reset role';
    insert into _r values (6,'the RED repudiation attack is now BLOCKED end-to-end',
      'vacate=42501, re-genesis=23505, stored still t_old',
      'vacate='||v_s1||' regenesis='||v_s2||' stored='||coalesce(v_ts::text,'<null>'),
      v_s1 = '42501' and v_s2 = '23505' and v_ts = t_old);
  end;

  ---------------------------------------------------------------- 7. THE APP PATH: PostgREST upsert
  -- api.js markRead sends all three columns, so PostgREST emits DO UPDATE SET over all three,
  -- including both PK columns. Reproduced EXACTLY: a narrower hand-written SET list would pass even
  -- under a column grant that breaks the real client.
  perform pg_temp.imp(u1);
  begin
    insert into public.dm_reads (conversation_id,user_id,last_read_at) values (cA,u1,t_new)
      on conflict (conversation_id,user_id) do update
        set conversation_id = excluded.conversation_id,
            user_id         = excluded.user_id,
            last_read_at    = excluded.last_read_at;
    v_state := 'OK';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  select last_read_at into v_ts from public.dm_reads where conversation_id = cA and user_id = u1;
  execute 'reset role';
  insert into _r values (7,'PostgREST-shaped upsert (markRead) still works','OK & stored=t_new',
    'state='||v_state||' stored='||coalesce(v_ts::text,'<null>'),
    v_state = 'OK' and v_ts = t_new);

  ---------------------------------------------------------------- 8. upsert cannot regress
  perform pg_temp.imp(u1);
  insert into public.dm_reads (conversation_id,user_id,last_read_at) values (cA,u1,t_mid)
    on conflict (conversation_id,user_id) do update
      set conversation_id = excluded.conversation_id,
          user_id         = excluded.user_id,
          last_read_at    = excluded.last_read_at;
  select last_read_at into v_ts from public.dm_reads where conversation_id = cA and user_id = u1;
  execute 'reset role';
  insert into _r values (8,'upsert backwards is clamped, not stored','stored=t_new',
    case when v_ts = t_new then 'MATCH(t_new)' else 'stored='||coalesce(v_ts::text,'<null>') end, v_ts = t_new);

  ---------------------------------------------------------------- 9/10. future cap
  perform pg_temp.imp(u1);
  update public.dm_reads set last_read_at = now() + interval '100 years'
    where conversation_id = cA and user_id = u1;
  select last_read_at into v_ts from public.dm_reads where conversation_id = cA and user_id = u1;
  execute 'reset role';
  insert into _r values (9,'UPDATE into the future is capped at now()','stored=now()',
    case when v_ts = now() then 'MATCH(now())' else 'stored='||coalesce(v_ts::text,'<null>') end, v_ts = now());

  perform pg_temp.imp(u1);
  insert into public.dm_reads (conversation_id,user_id,last_read_at)
    values (cB,u1,now() + interval '100 years');
  select last_read_at into v_ts from public.dm_reads where conversation_id = cB and user_id = u1;
  execute 'reset role';
  insert into _r values (10,'genesis INSERT into the future is capped at now()','stored=now()',
    case when v_ts = now() then 'MATCH(now())' else 'stored='||coalesce(v_ts::text,'<null>') end, v_ts = now());

  ---------------------------------------------------------------- 11. forward still works
  perform pg_temp.imp(u3);
  insert into public.dm_reads (conversation_id,user_id,last_read_at) values (cB,u3,t_old);
  update public.dm_reads set last_read_at = t_new where conversation_id = cB and user_id = u3;
  select last_read_at into v_ts from public.dm_reads where conversation_id = cB and user_id = u3;
  execute 'reset role';
  insert into _r values (11,'cursor still moves FORWARD normally','stored=t_new',
    case when v_ts = t_new then 'MATCH' else 'stored='||coalesce(v_ts::text,'<null>') end, v_ts = t_new);

  ---------------------------------------------------------------- 12. read receipts unbroken
  perform pg_temp.imp(u2);
  select count(*) into v_n from public.dm_reads where conversation_id = cA and user_id = u1;
  execute 'reset role';
  insert into _r values (12,'peer can STILL read my cursor (read receipts unbroken)','rows=1','rows='||v_n, v_n = 1);

  ---------------------------------------------------------------- 13. isolation
  perform pg_temp.imp(u4);
  select count(*) into v_n from public.dm_reads;
  execute 'reset role';
  insert into _r values (13,'outsider sees ZERO cursors','rows=0','rows='||v_n, v_n = 0);

  ---------------------------------------------------------------- 14. still no DELETE
  perform pg_temp.imp(u1);
  begin
    delete from public.dm_reads where conversation_id = cA and user_id = u1;
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (14,'DELETE still denied (42501)','42501',v_state, v_state = '42501');

  ---------------------------------------------------------------- 15. anon
  execute 'set local role anon';
  begin
    select count(*) into v_n from public.dm_reads;
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (15,'anon denied outright','42501',v_state, v_state = '42501');
end $green$;

-- ============================================================ catalog hardening
insert into _r
select 16,'both trigger fns DEFINER, pinned, not client-executable','all true',
  string_agg(p.proname||':sd='||p.prosecdef||',auth='||has_function_privilege('authenticated',p.oid,'execute'), ' '),
  bool_and(p.prosecdef)
  and bool_and(exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search\_path=%'))
  and bool_and(not has_function_privilege('authenticated',p.oid,'execute'))
  and bool_and(not has_function_privilege('anon',p.oid,'execute'))
  and count(*) = 2
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and p.proname in ('dm_reads_monotonic_cursor','dm_reads_lock_identity');

-- tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16. The clamp must be BEFORE ROW on
-- INSERT+UPDATE (=23); the lock must be BEFORE ROW on UPDATE (=19). tgenabled='O' guards against a
-- trigger left disabled — a session_replication_role='replica' window would otherwise let every
-- assertion above pass while the controls were inert.
insert into _r values (17,'clamp fires BEFORE ROW on INSERT+UPDATE and is enabled','tgtype=23 enabled=O',
  (select coalesce('tgtype='||tgtype::int||' enabled='||tgenabled::text,'<missing>') from pg_trigger
    where tgrelid='public.dm_reads'::regclass and tgname='dm_reads_monotonic'),
  (select tgtype::int = 23 and tgenabled = 'O' from pg_trigger
    where tgrelid='public.dm_reads'::regclass and tgname='dm_reads_monotonic'));

insert into _r values (18,'identity lock fires BEFORE ROW on UPDATE and is enabled','tgtype=19 enabled=O',
  (select coalesce('tgtype='||tgtype::int||' enabled='||tgenabled::text,'<missing>') from pg_trigger
    where tgrelid='public.dm_reads'::regclass and tgname='dm_reads_lock_identity'),
  (select tgtype::int = 19 and tgenabled = 'O' from pg_trigger
    where tgrelid='public.dm_reads'::regclass and tgname='dm_reads_lock_identity'));

insert into _r values (19,'grants unchanged: select/insert/update, still no DELETE',
  'sel/ins/upd=t del=f anon=f',
  'sel='||has_table_privilege('authenticated','public.dm_reads','select')||
  ' ins='||has_table_privilege('authenticated','public.dm_reads','insert')||
  ' upd='||has_table_privilege('authenticated','public.dm_reads','update')||
  ' del='||has_table_privilege('authenticated','public.dm_reads','delete')||
  ' anon='||has_table_privilege('anon','public.dm_reads','select'),
      has_table_privilege('authenticated','public.dm_reads','select')
  and has_table_privilege('authenticated','public.dm_reads','insert')
  and has_table_privilege('authenticated','public.dm_reads','update')
  and not has_table_privilege('authenticated','public.dm_reads','delete')
  and not has_table_privilege('anon','public.dm_reads','select'));

-- ============================================================ VERDICT
do $verdict$
declare v_total int; v_null int; v_fail int;
begin
  select count(*), count(*) filter (where pass is null), count(*) filter (where pass is false)
    into v_total, v_null, v_fail from _r;
  if v_null > 0   then raise exception 'INCOMPLETE: % assertion(s) returned NULL pass', v_null; end if;
  if v_total <> 19 then raise exception 'INCOMPLETE: % assertion rows, expected 19', v_total; end if;
  if v_fail > 0   then raise notice 'RED: % assertion(s) FAILED — read the table below', v_fail; end if;
end $verdict$;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from _r;

select id, name, expected, actual, pass from _r order by id;

rollback;
