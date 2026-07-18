-- ============================================================================
-- INVITATION EMAIL-CONFIRM GUARD — ROLLED-BACK PROOF (17 assertions)
-- Proves migration 20260718195854_accept_invitation_email_confirm_guard.
-- VERIFIED GREEN live against nqlzjuxqgajeoypyzlnv on 2026-07-18: 17/17, 0 residue.
-- Run in ONE execute_sql call: begin; … rollback;
-- ============================================================================
-- Supersedes the draft in supabase/proposed/. Notable harness facts learned live:
--   * invitations carries a UNIQUE (workspace_id, lower(email)) WHERE status='pending'
--     constraint (`invitations_one_pending`) — so the expired-invite fixture must live
--     in a SECOND throwaway workspace or setup dies with 23505.
--   * `grant insert on _r to authenticated` — scratch results table only; no assertion
--     depends on it.
--   * `postgres` here has rolbypassrls=true, so the harness guard (current_user +
--     rolbypassrls) is what makes every assertion meaningful.
-- Fixtures are planted as the service role to CONSTRUCT the scenario; every ASSERTION
-- runs as `authenticated` through the PUBLIC accept_invitation wrapper, so the real
-- invoker→definer path is under test.
-- ============================================================================

begin;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;
grant insert on _r to authenticated;

do $setup$ begin perform set_config('proof.sfx', replace(gen_random_uuid()::text,'-',''), true); end $setup$;

-- ===== (0) SETUP: throwaway workspaces + inviter + invitees =====
do $s$
declare
  sfx text := current_setting('proof.sfx');
  ws uuid := gen_random_uuid(); ws2 uuid := gen_random_uuid();
  inviter uuid := (select id from auth.users order by created_at limit 1);
begin
  insert into public.workspaces (id,name,owner_id,slug) values
    (ws,'ECG Proof WS',inviter,'ecg-proof-'||left(sfx,8)),
    (ws2,'ECG Proof WS2',inviter,'ecg-proof2-'||left(sfx,8));
  insert into public.workspace_members (workspace_id,user_id,role) values (ws,inviter,'owner'),(ws2,inviter,'owner');
  perform set_config('proof.ws', ws::text, true);

  insert into auth.users (id,email,aud,role,email_confirmed_at) values
    (('11111111-0000-0000-0000-'||left(sfx,12))::uuid,'unconf-a-'||sfx||'@example.invalid','authenticated','authenticated',null),
    (('22222222-0000-0000-0000-'||left(sfx,12))::uuid,'unconf-b-'||sfx||'@example.invalid','authenticated','authenticated',null),
    (('33333333-0000-0000-0000-'||left(sfx,12))::uuid,'conf-'||sfx||'@example.invalid','authenticated','authenticated',now());

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

-- ===== (1) RED — anti-vacuity: TODAY an unconfirmed account can accept =====
-- NOTE: 1-2 pass only BEFORE the fix. Re-running against a DB that already has the
-- guard will fail them by design — that is the anti-vacuity guard working.
do $red$
declare sfx text := current_setting('proof.sfx'); u uuid := ('11111111-0000-0000-0000-'||left(sfx,12))::uuid;
  v_actual text; v_n int;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u,'role','authenticated')::text, true);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: bypassrls'; end if;
  begin perform public.accept_invitation(('aaaaaaaa-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (1,'RED: unconfirmed email CAN accept today (the gap)','ACCEPTED',v_actual,v_actual='ACCEPTED');
  execute 'reset role';
  select count(*) into v_n from public.workspace_members where workspace_id=current_setting('proof.ws')::uuid and user_id=u;
  insert into _r values (2,'RED: and it created the membership row','1',v_n::text,v_n=1);
end $red$;

-- ===== (2) APPLY THE FIX — verbatim from 20260718195854 =====
create or replace function private._accept_invitation(p_token uuid)
returns public.workspaces language plpgsql security definer set search_path = '' as $$
declare inv public.invitations; v_email text; v_confirmed timestamptz; ws public.workspaces;
begin
  select email, email_confirmed_at into v_email, v_confirmed
    from auth.users where id = (select auth.uid());
  if v_email is null then raise exception 'not authenticated' using errcode = '42501'; end if;

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

-- ===== (3) GREEN =====
do $green$
declare
  sfx text := current_setting('proof.sfx'); ws uuid := current_setting('proof.ws')::uuid;
  u_unconf uuid := ('22222222-0000-0000-0000-'||left(sfx,12))::uuid;
  u_conf   uuid := ('33333333-0000-0000-0000-'||left(sfx,12))::uuid;
  v_actual text; v_n int; v_role text; v_status text; v_by uuid;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u_unconf,'role','authenticated')::text, true);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN'; end if;
  begin perform public.accept_invitation(('bbbbbbbb-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (3,'unconfirmed email REJECTED 42501','42501:confirm your email address before accepting an invitation',v_actual,
    v_actual='42501:confirm your email address before accepting an invitation');

  -- guard runs BEFORE the token lookup, so a garbage token yields no P0002 oracle
  begin perform public.accept_invitation(gen_random_uuid()); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (4,'guard precedes token lookup (no P0002 oracle)','42501:confirm your email address before accepting an invitation',v_actual,
    v_actual='42501:confirm your email address before accepting an invitation');
  execute 'reset role';

  select count(*) into v_n from public.workspace_members where workspace_id=ws and user_id=u_unconf;
  insert into _r values (5,'unconfirmed created NO membership row','0',v_n::text,v_n=0);
  select status into v_status from public.invitations where token=('bbbbbbbb-0000-0000-0000-'||left(sfx,12))::uuid;
  insert into _r values (6,'unconfirmed left invitation pending','pending',v_status,v_status='pending');

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub',u_conf,'role','authenticated')::text, true);
  begin perform public.accept_invitation(('cccccccc-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (7,'confirmed email ACCEPTS (no regression)','ACCEPTED',v_actual,v_actual='ACCEPTED');

  begin perform public.accept_invitation(('cccccccc-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (8,'idempotent re-accept still returns workspace','ACCEPTED',v_actual,v_actual='ACCEPTED');

  begin perform public.accept_invitation(('eeeeeeee-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlerrm; end;
  insert into _r values (9,'expired invite still rejected','this invitation has expired',v_actual,v_actual='this invitation has expired');

  begin perform public.accept_invitation(('ffffffff-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlerrm; end;
  insert into _r values (10,'revoked invite still rejected','this invitation was revoked',v_actual,v_actual='this invitation was revoked');

  begin perform public.accept_invitation(('dddddddd-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlerrm; end;
  insert into _r values (11,'email-binding still enforced (wrong-email invite)','this invitation is for a different email',v_actual,
    v_actual='this invitation is for a different email');
  execute 'reset role';

  select role into v_role from public.workspace_members where workspace_id=ws and user_id=u_conf;
  insert into _r values (12,'invite-as-role preserved: joined as guest','guest',coalesce(v_role,'NULL'),v_role='guest');
  select status, accepted_by into v_status, v_by from public.invitations where token=('cccccccc-0000-0000-0000-'||left(sfx,12))::uuid;
  insert into _r values (13,'invitation accepted + accepted_by = caller','accepted|caller',
    v_status||'|'||(case when v_by=u_conf then 'caller' else coalesce(v_by::text,'NULL') end), v_status='accepted' and v_by=u_conf);

  -- the guard must not shadow the pre-existing not-authenticated path
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims','{}', true);
  begin perform public.accept_invitation(('bbbbbbbb-0000-0000-0000-'||left(sfx,12))::uuid); v_actual:='ACCEPTED';
  exception when others then v_actual:=sqlstate||':'||sqlerrm; end;
  insert into _r values (14,'unauthenticated still 42501 not authenticated','42501:not authenticated',v_actual,v_actual='42501:not authenticated');
  execute 'reset role';

  select count(*) into v_n from auth.users where email_confirmed_at is null and id not in
    (('11111111-0000-0000-0000-'||left(sfx,12))::uuid, ('22222222-0000-0000-0000-'||left(sfx,12))::uuid);
  insert into _r values (15,'no real user locked out (0 pre-existing unconfirmed)','0',v_n::text,v_n=0);

  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='private' and p.proname='_accept_invitation' and p.prosecdef
     and array_to_string(p.proconfig,',') like '%search_path=%';
  insert into _r values (16,'DEFINER + search_path survives CREATE OR REPLACE','1',v_n::text,v_n=1);

  insert into _r values (17,'EXECUTE authenticated-only','t|f',
    has_function_privilege('authenticated','private._accept_invitation(uuid)','execute')::text||'|'||
    has_function_privilege('anon','private._accept_invitation(uuid)','execute')::text,
    has_function_privilege('authenticated','private._accept_invitation(uuid)','execute')
    and not has_function_privilege('anon','private._accept_invitation(uuid)','execute'));

  -- completeness guard
  select count(*) into v_n from _r;
  if v_n <> 17 then raise exception 'INCOMPLETE: % assertion rows, expected 17', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end $green$;

select id, name, expected, actual, pass from _r order by id;
select count(*) filter (where pass) || '/' || count(*) as score, bool_and(pass) as all_green from _r;

rollback;
