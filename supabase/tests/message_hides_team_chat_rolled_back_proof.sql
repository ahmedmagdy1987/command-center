-- ============================================================================================
-- ROLLED-BACK PROOF — team-chat "Delete for me" (public.message_hides)
-- STATUS: RUN GREEN 30/30 on 2026-07-19 against nqlzjuxqgajeoypyzlnv, before applying.
--         Shipped as migration 20260719134752_message_hides_team_chat.sql.
--
-- Run the WHOLE file as ONE execute_sql call. It opens a transaction, asserts, and ROLLS BACK.
-- Read the `failed` column — a RED run still returns success from execute_sql.
--
-- FIXTURES ARE SYNTHETIC. No live workspace, member or message is read or mutated.
--
-- Three assertion classes, matching the three things the feature must guarantee:
--   FUNCTION  — a hide removes the message from MY reads, everywhere (thread, unread, search).
--   PRIVACY   — nobody else can observe that a hide happened, and their view is unaffected.
--   BOUNDARY  — only I can write my hides; guests and outsiders cannot write any.
--
-- LANDMINE (house rule, 20260718195827): this file RE-CREATES the DDL under test. If the shipped
-- migration's policies, grants or RPC bodies change, CHANGE THEM HERE TOO.
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
  u1 uuid := gen_random_uuid();   -- owner  — the hider
  u2 uuid := gen_random_uuid();   -- member — the observer (must never see a hide)
  u3 uuid := gen_random_uuid();   -- guest  — excluded from team chat entirely
  u4 uuid := gen_random_uuid();   -- outsider, different tenant
  ws  uuid := gen_random_uuid();
  wsx uuid := gen_random_uuid();
  mMine uuid; mPeer uuid; mTomb uuid;
begin
  insert into auth.users (id,email,aud,role) values
    (u1,'mh-u1-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (u2,'mh-u2-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (u3,'mh-u3-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (u4,'mh-u4-'||v_sfx||'@example.invalid','authenticated','authenticated');
  insert into public.workspaces (id,name,owner_id,slug) values
    (ws ,'MH Throwaway',u1,'mh-'||v_sfx),
    (wsx,'MH Outsider' ,u4,'mh-x-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (ws,u1,'owner'), (ws,u2,'member'), (ws,u3,'guest'), (wsx,u4,'owner');

  -- Three messages: one of mine, one of the peer's, and one already tombstoned. Bodies carry a
  -- unique token so the search assertion cannot match anything else in the database.
  insert into public.messages (workspace_id,sender_id,body,created_at)
    values (ws,u1,'mhtoken'||v_sfx||' alpha', now() - interval '3 hours') returning id into mMine;
  insert into public.messages (workspace_id,sender_id,body,created_at)
    values (ws,u2,'mhtoken'||v_sfx||' beta',  now() - interval '2 hours') returning id into mPeer;
  -- INSERT it already tombstoned. Do NOT create it and then UPDATE deleted_at: triggers fire for
  -- postgres too (superuser is not an exemption), and messages_enforce_edit_window (20260626065335:69)
  -- raises 'delete window expired' for a row older than 10 minutes — which would abort this whole
  -- transaction before assertion 1. The relaxed messages_text_or_audio_check (20260626065335:17-20)
  -- permits body/audio both null when deleted_at is set, so a tombstone can be inserted directly.
  insert into public.messages (workspace_id,sender_id,body,audio_path,deleted_at,created_at)
    values (ws,u2,null,null, now(), now() - interval '1 hour') returning id into mTomb;

  insert into _f values ('u1',u1),('u2',u2),('u3',u3),('u4',u4),('ws',ws),('wsx',wsx),
                        ('mMine',mMine),('mPeer',mPeer),('mTomb',mTomb);
  create temp table _tok(t text) on commit drop;
  insert into _tok values ('mhtoken'||v_sfx);
end $fixtures$;

-- ============================================================ HARNESS (aborts on failure)
do $harness$
declare u1 uuid; u4 uuid; ws uuid; v_state text; v_bypass boolean;
begin
  select v into u1 from _f where k='u1';
  select v into u4 from _f where k='u4';
  select v into ws from _f where k='ws';

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

  -- Control: the outsider cannot insert a message into our workspace.
  perform pg_temp.imp(u4);
  begin
    insert into public.messages (workspace_id,sender_id,body) values (ws,u4,'harness control');
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  if v_state <> '42501' then
    raise exception 'HARNESS BROKEN: control write returned %, expected 42501', v_state;
  end if;
end $harness$;

-- ============================================================ RED
insert into _r values (1,'RED: no team-chat hide table exists today','absent',
  coalesce(to_regclass('public.message_hides')::text,'absent'),
  to_regclass('public.message_hides') is null);

-- ============================================================ THE DDL UNDER TEST (top level)
create table if not exists public.message_hides (
  message_id   uuid not null references public.messages(id)   on delete cascade,
  user_id      uuid not null references auth.users(id)        on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists message_hides_ws_idx   on public.message_hides (workspace_id);
create index if not exists message_hides_user_idx on public.message_hides (user_id);

create or replace function public.message_hide_set_workspace_id()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  select m.workspace_id into new.workspace_id
    from public.messages m where m.id = new.message_id;
  if new.workspace_id is null then
    raise exception 'permission denied for message_hides' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.message_hide_set_workspace_id() from public, anon, authenticated;

drop trigger if exists message_hides_set_workspace_id on public.message_hides;
create trigger message_hides_set_workspace_id
  before insert on public.message_hides
  for each row execute function public.message_hide_set_workspace_id();

alter table public.message_hides enable row level security;

drop policy if exists message_hides_select_own on public.message_hides;
create policy message_hides_select_own on public.message_hides
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists message_hides_insert_own on public.message_hides;
create policy message_hides_insert_own on public.message_hides
  for insert to authenticated
  with check ((user_id = (select auth.uid()))
              and private.is_workspace_member(workspace_id)
              and private.workspace_role(workspace_id) <> 'guest');

drop policy if exists message_hides_delete_own on public.message_hides;
create policy message_hides_delete_own on public.message_hides
  for delete to authenticated
  using ((user_id = (select auth.uid()))
         and private.is_workspace_member(workspace_id)
         and private.workspace_role(workspace_id) <> 'guest');

revoke all on public.message_hides from public, anon, authenticated;
grant select, insert, delete on public.message_hides to authenticated;

create or replace function public.chat_thread_messages(
  p_ws uuid, p_before timestamptz default null, p_limit integer default 200)
returns setof public.messages language sql stable set search_path to '' as $fn$
  select m.* from public.messages m
   where m.workspace_id = p_ws
     and (p_before is null or m.created_at < p_before)
     and not exists (select 1 from public.message_hides h
                      where h.message_id = m.id and h.user_id = (select auth.uid()))
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);
$fn$;
revoke all     on function public.chat_thread_messages(uuid, timestamptz, integer) from public, anon;
grant  execute on function public.chat_thread_messages(uuid, timestamptz, integer) to authenticated;

create or replace function public.chat_unread_count(p_ws uuid, p_since timestamptz default null)
returns bigint language sql stable set search_path to '' as $fn$
  select count(*)::bigint from public.messages m
   where m.workspace_id = p_ws
     and m.sender_id is distinct from (select auth.uid())
     and m.deleted_at is null
     and (p_since is null or m.created_at > p_since)
     and not exists (select 1 from public.message_hides h
                      where h.message_id = m.id and h.user_id = (select auth.uid()));
$fn$;
revoke all     on function public.chat_unread_count(uuid, timestamptz) from public, anon;
grant  execute on function public.chat_unread_count(uuid, timestamptz) to authenticated;

create or replace function public.search_messages(p_ws uuid, p_q text, p_limit int default 50)
returns setof public.messages language sql stable security invoker set search_path to '' as $fn$
  select m.* from public.messages m
   where m.workspace_id = p_ws and m.deleted_at is null
     and m.body_tsv @@ websearch_to_tsquery('english', p_q)
     and not exists (select 1 from public.message_hides h
                      where h.message_id = m.id and h.user_id = (select auth.uid()))
   order by m.created_at desc limit least(coalesce(p_limit,50),100);
$fn$;
revoke all     on function public.search_messages(uuid, text, int) from public, anon;
grant  execute on function public.search_messages(uuid, text, int) to authenticated;

-- ============================================================ GREEN
do $green$
declare
  u1 uuid; u2 uuid; u3 uuid; u4 uuid; ws uuid; wsx uuid;
  mMine uuid; mPeer uuid; mTomb uuid; tok text;
  v_n int; v_state text; v_ws uuid; v_before bigint; v_after bigint;
begin
  select v into u1 from _f where k='u1'; select v into u2 from _f where k='u2';
  select v into u3 from _f where k='u3'; select v into u4 from _f where k='u4';
  select v into ws from _f where k='ws'; select v into wsx from _f where k='wsx';
  select v into mMine from _f where k='mMine'; select v into mPeer from _f where k='mPeer';
  select v into mTomb from _f where k='mTomb'; select t into tok from _tok;

  ---------------------------------------------------------------- ANTI-VACUITY
  perform pg_temp.imp(u1);
  select count(*) into v_n from public.chat_thread_messages(ws, null, 200);
  execute 'reset role';
  insert into _r values (2,'ANTI-VACUITY: hider sees all 3 messages before hiding','rows=3','rows='||v_n, v_n = 3);

  ---------------------------------------------------------------- FUNCTION
  -- 3: hide my OWN message. 4: hide SOMEONE ELSE'S. 5: hide a TOMBSTONE (no time limit).
  perform pg_temp.imp(u1);
  begin
    insert into public.message_hides (message_id,user_id) values (mMine,u1);
    v_state := 'OK';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (3,'member can hide their OWN message','OK',v_state, v_state = 'OK');

  perform pg_temp.imp(u1);
  begin
    insert into public.message_hides (message_id,user_id) values (mPeer,u1);
    v_state := 'OK';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (4,'member can hide SOMEONE ELSE''s message','OK',v_state, v_state = 'OK');

  perform pg_temp.imp(u1);
  begin
    insert into public.message_hides (message_id,user_id) values (mTomb,u1);
    v_state := 'OK';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (5,'member can hide a TOMBSTONE (no time limit)','OK',v_state, v_state = 'OK');

  -- 6: all three vanish from the hider's thread read.
  perform pg_temp.imp(u1);
  select count(*) into v_n from public.chat_thread_messages(ws, null, 200);
  execute 'reset role';
  insert into _r values (6,'hidden messages vanish from the hider''s thread','rows=0','rows='||v_n, v_n = 0);

  -- 7: workspace_id was STAMPED by the trigger, not taken from the client.
  perform pg_temp.imp(u1);
  select h.workspace_id into v_ws from public.message_hides h where h.message_id = mMine and h.user_id = u1;
  execute 'reset role';
  insert into _r values (7,'workspace_id is trigger-stamped from the parent message','=ws',
    coalesce(v_ws::text,'<null>'), v_ws = ws);

  -- 8: search no longer returns a hidden body (the command-palette leak).
  perform pg_temp.imp(u1);
  select count(*) into v_n from public.search_messages(ws, tok, 50);
  execute 'reset role';
  insert into _r values (8,'search_messages excludes hidden messages','rows=0','rows='||v_n, v_n = 0);

  -- 9: unread count drops. Measured as a delta on the PEER's message, which is the only one that
  -- counts toward u1's unread (own messages and tombstones are excluded by the body).
  perform pg_temp.imp(u1);
  select public.chat_unread_count(ws, null) into v_after;
  execute 'reset role';
  perform pg_temp.imp(u2);
  select public.chat_unread_count(ws, null) into v_before;   -- u2 hid nothing
  execute 'reset role';
  insert into _r values (9,'chat_unread_count excludes hidden (hider 0, non-hider 1)','0 vs 1',
    'hider='||v_after||' other='||v_before, v_after = 0 and v_before = 1);

  ---------------------------------------------------------------- PRIVACY
  -- 10: the observer's own view is COMPLETELY unaffected.
  perform pg_temp.imp(u2);
  select count(*) into v_n from public.chat_thread_messages(ws, null, 200);
  execute 'reset role';
  insert into _r values (10,'PRIVACY: the observer still sees all 3 messages','rows=3','rows='||v_n, v_n = 3);

  -- 11: the observer cannot see THAT a hide happened. This is the core privacy guarantee.
  perform pg_temp.imp(u2);
  select count(*) into v_n from public.message_hides;
  execute 'reset role';
  insert into _r values (11,'PRIVACY: observer cannot see ANY of my hide rows','rows=0','rows='||v_n, v_n = 0);

  -- 12: nor by probing a specific message id.
  perform pg_temp.imp(u2);
  select count(*) into v_n from public.message_hides h where h.message_id = mPeer;
  execute 'reset role';
  insert into _r values (12,'PRIVACY: observer cannot probe a specific message for a hide','rows=0','rows='||v_n, v_n = 0);

  -- 13: the peer's own search still finds the message the hider hid.
  perform pg_temp.imp(u2);
  select count(*) into v_n from public.search_messages(ws, tok, 50);
  execute 'reset role';
  insert into _r values (13,'PRIVACY: observer''s search is unaffected','rows=2','rows='||v_n, v_n = 2);

  ---------------------------------------------------------------- BOUNDARY
  -- 14: cannot write a hide on someone else's behalf.
  perform pg_temp.imp(u1);
  begin
    insert into public.message_hides (message_id,user_id) values (mPeer,u2);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (14,'cannot create a hide for ANOTHER user','42501',v_state, v_state = '42501');

  -- 15: guests are excluded from team chat, so they can never hide.
  perform pg_temp.imp(u3);
  begin
    insert into public.message_hides (message_id,user_id) values (mPeer,u3);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (15,'GUEST cannot hide a team-chat message','42501',v_state, v_state = '42501');

  -- 16: outsider likewise.
  perform pg_temp.imp(u4);
  begin
    insert into public.message_hides (message_id,user_id) values (mPeer,u4);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (16,'outsider cannot hide a message in another tenant','42501',v_state, v_state = '42501');

  -- 17: and sees nothing through the RPC.
  perform pg_temp.imp(u4);
  select count(*) into v_n from public.chat_thread_messages(ws, null, 200);
  execute 'reset role';
  insert into _r values (17,'outsider reads ZERO rows through the thread RPC','rows=0','rows='||v_n, v_n = 0);

  ---------------------------------------------------------------- CLIENT PATH
  -- 18: the app must use ON CONFLICT DO NOTHING. A merge-duplicates upsert needs UPDATE privilege,
  -- checked at executor startup whether or not a conflict occurs, and there is no UPDATE grant.
  -- This is the exact trap that made the DM version fail 42501 on every call.
  perform pg_temp.imp(u1);
  begin
    insert into public.message_hides (message_id,user_id) values (mMine,u1)
      on conflict (message_id,user_id) do nothing;
    v_state := 'OK';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (18,'re-hide via ON CONFLICT DO NOTHING is idempotent','OK',v_state, v_state = 'OK');

  perform pg_temp.imp(u1);
  begin
    insert into public.message_hides (message_id,user_id) values (mMine,u1)
      on conflict (message_id,user_id) do update set created_at = excluded.created_at;
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (19,'merge-duplicates upsert is REJECTED (no UPDATE grant)','42501',v_state, v_state = '42501');

  -- 20: unhide restores the message.
  perform pg_temp.imp(u1);
  delete from public.message_hides where message_id = mMine and user_id = u1;
  select count(*) into v_n from public.chat_thread_messages(ws, null, 200);
  execute 'reset role';
  insert into _r values (20,'unhide (DELETE) restores the message','rows=1','rows='||v_n, v_n = 1);

  ---------------------------------------------------------------- 27. THE SHARPEST PRIVACY PROBE
  -- Assertion 14 inserts a row that does NOT exist, so it never exercises unique-vs-RLS ordering.
  -- This one DUPLICATES a hide that assertion 4 really created: u2 tries to insert (mPeer, u1).
  -- A 23505 here would confirm to u2 that u1 hid mPeer — a direct hide oracle. Must be 42501,
  -- i.e. the RLS WITH CHECK must be evaluated before the unique index is probed.
  perform pg_temp.imp(u2);
  begin
    insert into public.message_hides (message_id,user_id) values (mPeer,u1);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (27,'PRIVACY: duplicating a real hide returns 42501, never 23505 (no oracle)',
    '42501',v_state, v_state = '42501');

  ---------------------------------------------------------------- 28. existence oracle
  -- A message id that does not exist must be indistinguishable from one that exists in another
  -- tenant. Both must be 42501 — never 23502 from the NOT NULL constraint.
  perform pg_temp.imp(u1);
  begin
    insert into public.message_hides (message_id,user_id) values (gen_random_uuid(),u1);
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (28,'PRIVACY: nonexistent message_id gives 42501, not 23502 (no existence oracle)',
    '42501',v_state, v_state = '42501');

  ---------------------------------------------------------------- 29. guest DELETE lockout
  -- Documented, accepted behaviour: a member who hides and is later demoted to guest cannot unhide.
  -- Harmless — a guest cannot see team chat at all, so the message is invisible either way — but it
  -- is asserted so the behaviour is a decision on record rather than an accident.
  update public.workspace_members set role = 'guest' where workspace_id = ws and user_id = u1;
  perform pg_temp.imp(u1);
  delete from public.message_hides where message_id = mPeer and user_id = u1;
  get diagnostics v_n = row_count;
  execute 'reset role';
  update public.workspace_members set role = 'owner' where workspace_id = ws and user_id = u1;
  insert into _r values (29,'demoted-to-guest cannot unhide (accepted lockout)','rows=0','rows='||v_n, v_n = 0);

  ---------------------------------------------------------------- 21. anon
  execute 'set local role anon';
  begin
    select count(*) into v_n from public.message_hides;
    v_state := 'NO ERROR';
  exception when others then get stacked diagnostics v_state = returned_sqlstate;
  end;
  execute 'reset role';
  insert into _r values (21,'anon denied outright','42501',v_state, v_state = '42501');
end $green$;

-- ============================================================ catalog hardening
insert into _r values (22,'grants are select/insert/delete only — NO UPDATE',
  'sel=t ins=t upd=f del=t anon=f',
  'sel='||has_table_privilege('authenticated','public.message_hides','select')||
  ' ins='||has_table_privilege('authenticated','public.message_hides','insert')||
  ' upd='||has_table_privilege('authenticated','public.message_hides','update')||
  ' del='||has_table_privilege('authenticated','public.message_hides','delete')||
  ' anon='||has_table_privilege('anon','public.message_hides','select'),
      has_table_privilege('authenticated','public.message_hides','select')
  and has_table_privilege('authenticated','public.message_hides','insert')
  and has_table_privilege('authenticated','public.message_hides','delete')
  and not has_table_privilege('authenticated','public.message_hides','update')
  and not has_table_privilege('anon','public.message_hides','select'));

insert into _r
select 23,'stamping fn is DEFINER, pinned, not client-executable','all true',
  'sd='||p.prosecdef||' auth='||has_function_privilege('authenticated',p.oid,'execute'),
  p.prosecdef
  and exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search\_path=%')
  and not has_function_privilege('authenticated',p.oid,'execute')
  and not has_function_privilege('anon',p.oid,'execute')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and p.proname='message_hide_set_workspace_id';

insert into _r
select 24,'all three read RPCs are INVOKER (never DEFINER)','3 invoker',
  string_agg(p.proname||':sd='||p.prosecdef, ' '),
  bool_and(not p.prosecdef) and count(*) = 3
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and p.proname in ('chat_thread_messages','chat_unread_count','search_messages');

insert into _r values (25,'message_hides is NOT in supabase_realtime','absent',
  (select coalesce(string_agg(tablename,','),'absent') from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='message_hides'),
  not exists (select 1 from pg_publication_tables
               where pubname='supabase_realtime' and schemaname='public' and tablename='message_hides'));

insert into _r values (26,'both FK indexes present (advisor)','2 indexes',
  (select coalesce(string_agg(indexname,','order by indexname),'<none>') from pg_indexes
    where schemaname='public' and tablename='message_hides'
      and indexname in ('message_hides_ws_idx','message_hides_user_idx')),
  (select count(*) from pg_indexes
    where schemaname='public' and tablename='message_hides'
      and indexname in ('message_hides_ws_idx','message_hides_user_idx')) = 2);

-- Nothing may reach these RPCs except authenticated: they are the hide-aware read surface, and an
-- anon-executable one would read past the filter for an unauthenticated caller.
insert into _r
select 30,'all three RPCs revoked from anon/public, granted to authenticated','3 ok',
  string_agg(p.proname||':anon='||has_function_privilege('anon',p.oid,'execute')
                     ||',auth='||has_function_privilege('authenticated',p.oid,'execute'), ' '),
  bool_and(not has_function_privilege('anon', p.oid, 'execute'))
  and bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
  and count(*) = 3
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public'
  and p.proname in ('chat_thread_messages','chat_unread_count','search_messages');

-- ============================================================ VERDICT
do $verdict$
declare v_total int; v_null int; v_fail int;
begin
  select count(*), count(*) filter (where pass is null), count(*) filter (where pass is false)
    into v_total, v_null, v_fail from _r;
  if v_null > 0    then raise exception 'INCOMPLETE: % assertion(s) returned NULL pass', v_null; end if;
  if v_total <> 30 then raise exception 'INCOMPLETE: % assertion rows, expected 30', v_total; end if;
  if v_fail > 0    then raise notice 'RED: % assertion(s) FAILED — read the table below', v_fail; end if;
end $verdict$;

select count(*) filter (where pass) as passed,
       count(*) filter (where not pass) as failed,
       count(*) as total
from _r;

select id, name, expected, actual, pass from _r order by id;

rollback;
