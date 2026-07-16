-- ============================================================================
-- Command Center — DM "DELETE FOR ME" PEER-INVISIBILITY PROOF (27 assertions)
-- Surface: 20260716000040_dm_message_hides.sql (builds on 20260604125857).
-- ============================================================================
-- PROVES the peer-invisibility contract of "delete for me" end-to-end, through
-- the hide-aware read path the migration defines — public.dm_thread_messages()
-- (SECURITY INVOKER; the NOT EXISTS on dm_message_hides is pinned to auth.uid())
-- and the unread badge public.dm_unread_counts -> private._dm_unread_counts
-- (SECURITY DEFINER; its hides filter is HAND-pinned to auth.uid(), no RLS).
-- The hide WRITE path is a direct RLS-gated INSERT into public.dm_message_hides.
--
-- CORE PROPERTY (H04+H07): A hides one message -> A's thread EXCLUDES it while
-- B's thread STILL INCLUDES it. The hide is PER-USER, never a shared tombstone.
--
-- DISCRIMINATION (every deny is paired with a matching allow, so no "0"/"blocked"
-- can pass vacuously; each CORE row goes RED if its guard were removed):
--   * H04 (A can't see it) is paired with H07 (B still can) and H05/H09 (the
--     message + A's OTHER message are untouched) — if the hide were a shared
--     delete, H07/H08/H09 fail; if it did nothing, H04/H06 fail.
--   * H10 (peer can't enumerate A's hide) is paired with H11 (A can) — proves
--     dm_message_hides_select_own pins SELECT to auth.uid(), not the read-peer-
--     inclusive dm_reads pattern.
--   * N01/N02/N03 (non-participant / spoofed user_id cannot create a hide) are
--     paired with H02 (a participant can) — the INSERT gate + conversation_id
--     stamp are load-bearing.
--   * U03 (A hides A's OWN msg -> peer B's badge UNCHANGED = the DEFINER PIN) is
--     paired with U05 (A hides B's msg -> A's OWN badge DROPS) — proving the
--     hide filter is ACTIVE yet strictly per-user. Drop the `h.user_id=auth.uid()`
--     pin from _dm_unread_counts and U03/U06 go RED.
--
-- METHOD: a self-contained begin;…rollback; — fixtures (a throwaway workspace,
-- 4 users, a conversation, 4 messages, 2 read cursors) planted as `postgres`
-- (bypassrls) to CONSTRUCT the scenario; EVERY assertion runs as the impersonated
-- `authenticated` user via request.jwt.claims, so RLS/triggers are under test.
-- HARNESS GUARD refuses to run unless impersonation is real (else a bypassrls
-- superuser would pass everything). ANTI-VACUITY GUARD refuses unless the two
-- participants actually SEE the fixtures. Fully rolled back; unique suffix; no
-- residue.  Verified live against nqlzjuxqgajeoypyzlnv 2026-07-16: 27/27, 0 residue.
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

do $proof$
declare
  v_sfx  text := replace(gen_random_uuid()::text,'-','');
  v_ws   uuid := gen_random_uuid();
  uA uuid := gen_random_uuid();   -- participant / hider
  uB uuid := gen_random_uuid();   -- participant / peer
  uC uuid := gen_random_uuid();   -- co-member of v_ws but NOT in the conversation
  uO uuid := gen_random_uuid();   -- outsider: not a member of v_ws at all
  d_conv uuid;
  m_hide uuid;   -- sent by B; A "deletes for me"
  m_keep uuid;   -- sent by B; A keeps (targeted-control)
  m_a1   uuid;   -- sent by A (used for the DEFINER unread PIN test)
  m_a2   uuid;   -- sent by A
  v_n int; v_actual text; v_conv_stored uuid;
begin
  -- ============================ FIXTURES (as postgres / bypassrls) ============================
  insert into auth.users (id,email,aud,role) values
    (uA,'dmh-a-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (uB,'dmh-b-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (uC,'dmh-c-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (uO,'dmh-o-'||v_sfx||'@example.invalid','authenticated','authenticated');

  insert into public.workspaces (id,name,owner_id,slug)
  values (v_ws,'DMH Throwaway WS',uA,'dmh-ws-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_ws,uA,'member'), (v_ws,uB,'member'), (v_ws,uC,'member');   -- uO deliberately NOT a member

  insert into public.dm_conversations (workspace_id,user_lo,user_hi)
  values (v_ws, least(uA,uB), greatest(uA,uB)) returning id into d_conv;

  -- 4 messages; workspace_id is auto-stamped from the conversation by the DEFINER trigger.
  insert into public.dm_messages (conversation_id,sender_id,body) values (d_conv,uB,'DMH hide me')  returning id into m_hide;
  insert into public.dm_messages (conversation_id,sender_id,body) values (d_conv,uB,'DMH keep me')  returning id into m_keep;
  insert into public.dm_messages (conversation_id,sender_id,body) values (d_conv,uA,'DMH from A #1') returning id into m_a1;
  insert into public.dm_messages (conversation_id,sender_id,body) values (d_conv,uA,'DMH from A #2') returning id into m_a2;

  -- read cursors well in the past so EVERY message is unread for both participants
  insert into public.dm_reads (conversation_id,user_id,last_read_at) values
    (d_conv,uA, now()-interval '2 hours'),
    (d_conv,uB, now()-interval '2 hours');

  -- ============================ HARNESS GUARD ============================
  perform pg_temp.imp(uA);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role not switched (current_user=%)', current_user; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: assertion role bypasses RLS'; end if;
  if auth.uid() is distinct from uA then execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid() != impersonated uid'; end if;
  execute 'reset role';

  -- ============================ ANTI-VACUITY GUARD ============================
  -- Both participants must SEE all 4 messages through the hide-aware read path,
  -- else the "outsider/peer sees 0/N" assertions below would be vacuous.
  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_thread_messages(d_conv);
  if v_n <> 4 then execute 'reset role'; raise exception 'VACUOUS: participant A sees % rows, expected 4', v_n; end if;
  execute 'reset role';
  perform pg_temp.imp(uB); select count(*) into v_n from public.dm_thread_messages(d_conv);
  if v_n <> 4 then execute 'reset role'; raise exception 'VACUOUS: participant B sees % rows, expected 4', v_n; end if;
  execute 'reset role';

  -- ============================ GROUP H — core peer-invisibility ============================
  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_thread_messages(d_conv);
  execute 'reset role'; insert into _r values (1,'H01 participant A sees all 4 via hide-aware read (pre-hide)','4',v_n::text,v_n=4);

  -- H02 — A hides m_hide. conversation_id is passed BOGUS on purpose; the BEFORE-INSERT
  -- trigger must overwrite it to the message's true conversation before the WITH CHECK gate.
  perform pg_temp.imp(uA);
  begin
    insert into public.dm_message_hides (message_id,user_id,conversation_id)
    values (m_hide, uA, gen_random_uuid());
    v_actual := 'INSERTED';
  exception when others then v_actual := sqlstate; end;
  execute 'reset role'; insert into _r values (2,'H02 participant A INSERT hide(m_hide) allowed','INSERTED',v_actual,v_actual='INSERTED');

  perform pg_temp.imp(uA); select conversation_id into v_conv_stored from public.dm_message_hides where message_id=m_hide and user_id=uA;
  execute 'reset role'; insert into _r values (3,'H03 conversation_id stamped from message (bogus overwritten)', d_conv::text, coalesce(v_conv_stored::text,'NULL'), v_conv_stored is not distinct from d_conv);

  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_thread_messages(d_conv) where id=m_hide;
  execute 'reset role'; insert into _r values (4,'H04 CORE: A''s read EXCLUDES the hidden message','0',v_n::text,v_n=0);

  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_thread_messages(d_conv) where id=m_keep;
  execute 'reset role'; insert into _r values (5,'H05 CONTROL: A''s read still INCLUDES the message A did NOT hide','1',v_n::text,v_n=1);

  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_thread_messages(d_conv);
  execute 'reset role'; insert into _r values (6,'H06 A''s thread total drops to 3 (targeted, not all-or-nothing)','3',v_n::text,v_n=3);

  perform pg_temp.imp(uB); select count(*) into v_n from public.dm_thread_messages(d_conv) where id=m_hide;
  execute 'reset role'; insert into _r values (7,'H07 CORE: peer B''s read STILL INCLUDES the message A hid (per-user)','1',v_n::text,v_n=1);

  perform pg_temp.imp(uB); select count(*) into v_n from public.dm_thread_messages(d_conv);
  execute 'reset role'; insert into _r values (8,'H08 peer B''s thread total unchanged at 4','4',v_n::text,v_n=4);

  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_messages where id=m_hide;
  execute 'reset role'; insert into _r values (9,'H09 hide is a FILTER not a delete: raw dm_messages row untouched for A','1',v_n::text,v_n=1);

  perform pg_temp.imp(uB); select count(*) into v_n from public.dm_message_hides where message_id=m_hide;
  execute 'reset role'; insert into _r values (10,'H10 peer B CANNOT enumerate A''s hide (select_own pins to auth.uid)','0',v_n::text,v_n=0);

  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_message_hides where message_id=m_hide;
  execute 'reset role'; insert into _r values (11,'H11 pair: A reads own hide row (non-vacuous vs H10)','1',v_n::text,v_n=1);

  perform pg_temp.imp(uA);
  begin insert into public.dm_message_hides (message_id,user_id,conversation_id) values (m_hide,uA,d_conv); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (12,'H12 duplicate hide bounded to PK (message,user) -> 23505','23505',v_actual,v_actual='23505');

  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_message_hides where message_id=m_hide and user_id=uA;
  execute 'reset role'; insert into _r values (13,'H13 exactly one hide row for (m_hide, A)','1',v_n::text,v_n=1);

  perform pg_temp.imp(uA); delete from public.dm_message_hides where message_id=m_hide and user_id=uA; get diagnostics v_n=row_count;
  execute 'reset role'; insert into _r values (14,'H14 A unhides (DELETE own) -> 1 row','1 rows',v_n::text||' rows',v_n=1);

  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_thread_messages(d_conv);
  execute 'reset role'; insert into _r values (15,'H15 reversible: after unhide A''s thread back to 4','4',v_n::text,v_n=4);

  -- ============================ GROUP N — non-participant cannot hide or read ============================
  perform pg_temp.imp(uO);
  begin insert into public.dm_message_hides (message_id,user_id,conversation_id) values (m_hide,uO,gen_random_uuid()); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (16,'N01 outsider O cannot create a hide (participant gate) -> 42501','42501',v_actual,v_actual='42501');

  perform pg_temp.imp(uC);
  begin insert into public.dm_message_hides (message_id,user_id,conversation_id) values (m_hide,uC,gen_random_uuid()); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (17,'N02 co-member non-participant C cannot create a hide -> 42501','42501',v_actual,v_actual='42501');

  perform pg_temp.imp(uO);
  begin insert into public.dm_message_hides (message_id,user_id,conversation_id) values (m_hide,uA,d_conv); v_actual:='ALLOWED';
  exception when others then v_actual:=sqlstate; end;
  execute 'reset role'; insert into _r values (18,'N03 outsider O spoofing user_id=A blocked (user_id pin) -> 42501','42501',v_actual,v_actual='42501');

  perform pg_temp.imp(uO); select count(*) into v_n from public.dm_thread_messages(d_conv);
  execute 'reset role'; insert into _r values (19,'N04 outsider O cannot read the conversation at all','0',v_n::text,v_n=0);

  perform pg_temp.imp(uC); select count(*) into v_n from public.dm_thread_messages(d_conv);
  execute 'reset role'; insert into _r values (20,'N05 co-member non-participant C cannot read the conversation','0',v_n::text,v_n=0);

  perform pg_temp.imp(uA); select count(*) into v_n from public.dm_thread_messages(d_conv);
  execute 'reset role'; insert into _r values (21,'N06 pair/anti-vacuity: participant A does read it (=4)','4',v_n::text,v_n=4);

  -- ============================ GROUP U — DEFINER unread-badge PIN ============================
  -- No hides currently exist (H-series unhid; N-series inserts all rolled back).
  perform pg_temp.imp(uB); select coalesce((select unread from public.dm_unread_counts(v_ws) where conversation_id=d_conv),0) into v_n;
  execute 'reset role'; insert into _r values (22,'U01 baseline B unread = 2 (A''s two messages)','2',v_n::text,v_n=2);

  perform pg_temp.imp(uA); select coalesce((select unread from public.dm_unread_counts(v_ws) where conversation_id=d_conv),0) into v_n;
  execute 'reset role'; insert into _r values (23,'U02 baseline A unread = 2 (B''s two messages)','2',v_n::text,v_n=2);

  -- A hides A's OWN message m_a1. This must NOT touch B's badge (the DEFINER pin).
  perform pg_temp.imp(uA); insert into public.dm_message_hides (message_id,user_id,conversation_id) values (m_a1,uA,d_conv);
  execute 'reset role';
  perform pg_temp.imp(uB); select coalesce((select unread from public.dm_unread_counts(v_ws) where conversation_id=d_conv),0) into v_n;
  execute 'reset role'; insert into _r values (24,'U03 PIN: A hides A''s OWN msg -> peer B''s unread UNCHANGED = 2','2',v_n::text,v_n=2);

  perform pg_temp.imp(uA); select coalesce((select unread from public.dm_unread_counts(v_ws) where conversation_id=d_conv),0) into v_n;
  execute 'reset role'; insert into _r values (25,'U04 A''s own unread still 2 (A''s own msg is never in A''s count)','2',v_n::text,v_n=2);

  -- A ALSO hides m_hide (a message FROM B): the caller's own badge MUST drop -> filter is active.
  perform pg_temp.imp(uA); insert into public.dm_message_hides (message_id,user_id,conversation_id) values (m_hide,uA,d_conv);
  execute 'reset role';
  perform pg_temp.imp(uA); select coalesce((select unread from public.dm_unread_counts(v_ws) where conversation_id=d_conv),0) into v_n;
  execute 'reset role'; insert into _r values (26,'U05 filter ACTIVE: A hides B''s msg -> A''s OWN unread drops to 1','1',v_n::text,v_n=1);

  perform pg_temp.imp(uB); select coalesce((select unread from public.dm_unread_counts(v_ws) where conversation_id=d_conv),0) into v_n;
  execute 'reset role'; insert into _r values (27,'U06 B''s unread STILL 2 after both of A''s hides (per-user throughout)','2',v_n::text,v_n=2);

  -- ============================ completeness guard ============================
  select count(*) into v_n from _r;
  if v_n <> 27 then raise exception 'INCOMPLETE: % assertion rows, expected 27', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$proof$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;
select id, name, expected, actual from _r where not pass order by id;

rollback;