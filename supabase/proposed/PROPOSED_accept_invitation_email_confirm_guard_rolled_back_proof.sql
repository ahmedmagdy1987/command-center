-- ============================================================================
-- PROPOSED PROOF — invitation email-confirm guard — ROLLED-BACK (12 assertions)
-- Run in ONE execute_sql call (MCP session): begin; ... rollback; — returns the
-- result set AND rolls back. NOT YET RUN against the live DB (drafted 2026-07-18
-- in a session without the Supabase MCP). Companion of
-- PROPOSED_accept_invitation_email_confirm_guard.sql.
--
-- Shape (house style): harness guard first (postgres has rolbypassrls — a proof
-- that forgets `set local role authenticated` proves nothing), then a RED
-- demonstration against the LIVE function (anti-vacuity: the unconfirmed accept
-- SUCCEEDS today), rollback to savepoint, apply the guard, then the matrix.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- (1) HARNESS
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

do $proof$
declare
  v_sfx text := replace(gen_random_uuid()::text,'-','');
  u_owner uuid := gen_random_uuid();   -- workspace owner (confirmed)
  u_unconf uuid := gen_random_uuid();  -- invitee, email NOT confirmed
  u_conf uuid := gen_random_uuid();    -- invitee, email confirmed
  v_ws uuid := gen_random_uuid();
  t_unconf uuid := gen_random_uuid();  -- invitation tokens
  t_conf uuid := gen_random_uuid();
  t_other uuid := gen_random_uuid();   -- invite bound to a DIFFERENT email
  v_res text; v_n int;
begin
  -- Harness users: inserted directly into auth.users, so email_confirmed_at is
  -- NULL unless we stamp it — exactly the two states under test.
  insert into auth.users (id,email,aud,role) values
    (u_owner,'inv-own-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (u_unconf,'inv-unc-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (u_conf,'inv-cnf-'||v_sfx||'@example.invalid','authenticated','authenticated');
  update auth.users set email_confirmed_at = now() where id in (u_owner, u_conf);

  insert into public.workspaces (id,name,owner_id,slug) values (v_ws,'INV WS',u_owner,'inv-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values (v_ws,u_owner,'owner');

  -- Invitations seeded directly as postgres (creation RPC is out of scope here).
  insert into public.invitations (workspace_id,email,role,token,invited_by) values
    (v_ws,'inv-unc-'||v_sfx||'@example.invalid','member',t_unconf,u_owner),
    (v_ws,'inv-cnf-'||v_sfx||'@example.invalid','member',t_conf,u_owner),
    (v_ws,'inv-oth-'||v_sfx||'@example.invalid','member',t_other,u_owner);

  -- ===== HARNESS GUARD =====
  perform pg_temp.imp(u_unconf);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: bypassrls'; end if;
  if auth.uid() is distinct from u_unconf then execute 'reset role'; raise exception 'HARNESS BROKEN: uid'; end if;
  -- known-denied write returns 0 rows (RLS live, not bypassed)
  begin
    update public.workspaces set name='x' where id=v_ws; get diagnostics v_n = row_count;
  exception when others then v_n := 0; end;
  execute 'reset role';
  insert into _r values (1,'harness: denied write rows=0','0',v_n::text,v_n=0);

  -- ===== (2) RED — anti-vacuity: TODAY the unconfirmed accept SUCCEEDS =====
  begin
    savepoint red;
    perform pg_temp.imp(u_unconf);
    perform public.accept_invitation(t_unconf);
    execute 'reset role';
    select count(*)::text into v_res from public.workspace_members where workspace_id=v_ws and user_id=u_unconf;
    insert into _r values (2,'RED: live fn admits UNCONFIRMED (gap exists)','1',v_res,v_res='1');
    rollback to savepoint red;
  exception when others then
    rollback to savepoint red;
    -- If this fires, the live fn already rejects unconfirmed users — the guard
    -- may already be applied (or drift). STOP and re-recon before applying.
    insert into _r values (2,'RED: live fn admits UNCONFIRMED (gap exists)','1','rejected: '||sqlerrm,false);
  end;

  -- ===== (3) APPLY THE GUARD (the proposed DDL, verbatim) =====
  -- <<< paste the CREATE OR REPLACE from PROPOSED_accept_invitation_email_confirm_guard.sql here
  --     when running live; kept out of this draft so there is exactly ONE copy of the DDL >>>
  raise exception 'DRAFT MARKER: paste the guard DDL above this line before running';

  -- ===== (4) GREEN matrix =====
  -- 4a. unconfirmed -> rejected with the guard's message, errcode 42501
  begin
    perform pg_temp.imp(u_unconf);
    perform public.accept_invitation(t_unconf);
    execute 'reset role';
    insert into _r values (3,'unconfirmed accept rejected','42501','ACCEPTED (BAD)',false);
  exception when sqlstate '42501' then
    execute 'reset role';
    insert into _r values (3,'unconfirmed accept rejected','42501','42501: '||sqlerrm, sqlerrm like '%confirm your email%');
  when others then
    execute 'reset role';
    insert into _r values (3,'unconfirmed accept rejected','42501',sqlstate||': '||sqlerrm,false);
  end;

  -- 4b. no membership row was created; invitation still pending
  select count(*)::text into v_res from public.workspace_members where workspace_id=v_ws and user_id=u_unconf;
  insert into _r values (4,'unconfirmed: no membership row','0',v_res,v_res='0');
  select status into v_res from public.invitations where token=t_unconf;
  insert into _r values (5,'unconfirmed: invitation stays pending','pending',v_res,v_res='pending');

  -- 4c. guard fires BEFORE token inspection: unconfirmed + someone else's token
  --     still gets the confirm error (no token-validity oracle for unconfirmed accounts)
  begin
    perform pg_temp.imp(u_unconf);
    perform public.accept_invitation(t_other);
    execute 'reset role';
    insert into _r values (6,'unconfirmed + foreign token -> confirm error first','confirm error','ACCEPTED (BAD)',false);
  exception when others then
    execute 'reset role';
    insert into _r values (6,'unconfirmed + foreign token -> confirm error first','confirm error',sqlerrm, sqlerrm like '%confirm your email%');
  end;

  -- 4d. confirmed invitee still accepts; membership carries the invited role
  perform pg_temp.imp(u_conf);
  perform public.accept_invitation(t_conf);
  execute 'reset role';
  select count(*)::text into v_res from public.workspace_members where workspace_id=v_ws and user_id=u_conf and role='member';
  insert into _r values (7,'confirmed accept -> membership (role=member)','1',v_res,v_res='1');
  select status into v_res from public.invitations where token=t_conf;
  insert into _r values (8,'confirmed accept -> invitation accepted','accepted',v_res,v_res='accepted');

  -- 4e. idempotent re-accept by the confirmed user still returns the workspace
  begin
    perform pg_temp.imp(u_conf);
    perform public.accept_invitation(t_conf);
    execute 'reset role';
    insert into _r values (9,'re-accept idempotent','ok','ok',true);
  exception when others then
    execute 'reset role';
    insert into _r values (9,'re-accept idempotent','ok',sqlerrm,false);
  end;

  -- 4f. regression: the email-binding guard is intact for a CONFIRMED user
  begin
    perform pg_temp.imp(u_conf);
    perform public.accept_invitation(t_other);
    execute 'reset role';
    insert into _r values (10,'confirmed + wrong-email token rejected','different email','ACCEPTED (BAD)',false);
  exception when others then
    execute 'reset role';
    insert into _r values (10,'confirmed + wrong-email token rejected','different email',sqlerrm, sqlerrm like '%different email%');
  end;

  -- 4g. late confirmation unblocks: stamp the unconfirmed user, accept succeeds
  update auth.users set email_confirmed_at = now() where id = u_unconf;
  perform pg_temp.imp(u_unconf);
  perform public.accept_invitation(t_unconf);
  execute 'reset role';
  select count(*)::text into v_res from public.workspace_members where workspace_id=v_ws and user_id=u_unconf;
  insert into _r values (11,'confirm-then-accept succeeds','1',v_res,v_res='1');

  -- 4h. completeness: grants unchanged (EXECUTE authenticated-only survives the replace)
  select count(*)::text into v_res from information_schema.routine_privileges
   where routine_schema='private' and routine_name='_accept_invitation' and grantee='authenticated' and privilege_type='EXECUTE';
  insert into _r values (12,'EXECUTE grant to authenticated intact','1',v_res,v_res='1');
end $proof$;

select id, name, expected, actual, pass from _r order by id;
select count(*) filter (where pass) || '/' || count(*) as score from _r;

rollback;
