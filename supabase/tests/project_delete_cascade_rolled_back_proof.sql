-- ============================================================================
-- PROJECT-DELETE (cascade owner-only / unassign admin+) — ROLLED-BACK PROOF
-- 29 assertions. Rolled back. Proves the proposed public.delete_project RPC.
-- ============================================================================
-- Model:
--   cascade  (delete the project's tasks + the project row)  -> OWNER only  (rank 3)
--   unassign (re-file the project's tasks to a target, delete row) -> OWNER+ADMIN (rank >=2)
--   BOTH paths (a) require the project row to actually exist in p_workspace_id, then touch
--   ONLY tasks the caller can already see (private.can_see_task) and ONLY within p_workspace_id.
--   tasks.project is FREE-TEXT with NO FK, and 'personal'/'other' are SHARED seed slugs across
--   tenants, so the `workspace_id = p_workspace_id` predicate is the ONLY thing preventing a
--   cascade of one tenant's project from nuking another tenant's same-slug tasks (assertions
--   C05 / M02); M03 proves it is load-bearing by re-running the cascade DELETE with `workspace_id`
--   STRIPPED (the "M8" mutation) and showing the cross-tenant victim IS destroyed -> C05/M02 RED
--   under M8.  The project-existence guard blocks the shared-slug footgun (D11-D13).
--
-- Every DENIED assertion pins its exact gate by asserting the RAISE MESSAGE (not just SQLSTATE),
-- so a 42501/22023 from an incidental cause cannot masquerade as the intended gate.
--
-- Method (mirrors cross_tenant_isolation_rolled_back_proof.sql): migration DDL created inside the
-- txn and rolled back with everything else; fixtures planted as `postgres` (bypassrls); every
-- ASSERTION runs as `authenticated` + request.jwt.claims; successful mutations run inside a nested
-- block that captures effects into vars then `raise 'PD_UNDO'` so the next assertion sees pristine
-- fixtures.  HARNESS guard (real impersonation), ANTI-VACUITY guard (the danger is real), and a
-- completeness guard (exactly 29 non-null rows) make "green" mean something.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- (1) THE MIGRATION DDL UNDER TEST  (identical to what will be applied)
-- ---------------------------------------------------------------------------
create or replace function private._delete_project(
  p_project_id text, p_workspace_id uuid, p_mode text, p_reassign_to text
) returns jsonb
language plpgsql security definer set search_path to '' as $fn$
declare
  v_rank int;
  v_affected int := 0;
  v_proj int := 0;
  v_mode text := lower(coalesce(p_mode, ''));
begin
  -- authorize FIRST (never reveal project existence to an unauthorized caller)
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_rank := private.workspace_role_rank(p_workspace_id);

  if v_mode = 'cascade' then
    if v_rank < 3 then
      raise exception 'only an owner can delete a project and its tasks' using errcode = '42501';
    end if;
    if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
      raise exception 'project not found' using errcode = 'P0002';         -- blocks the free-text-slug footgun
    end if;
    delete from public.tasks
      where project = p_project_id
        and workspace_id = p_workspace_id                    -- tenant scope (load-bearing; see M03)
        and private.can_see_task(auth.uid(), id);            -- GATE A: only caller-visible tasks
    get diagnostics v_affected = row_count;

  elsif v_mode = 'unassign' then
    if v_rank < 2 then
      raise exception 'only an owner or admin can delete a project' using errcode = '42501';
    end if;
    if p_reassign_to is null or length(btrim(p_reassign_to)) = 0 then
      raise exception 'reassign target required' using errcode = '22023';
    end if;
    if p_reassign_to = p_project_id then
      raise exception 'reassign target must differ from the deleted project' using errcode = '22023';
    end if;
    if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    update public.tasks
      set project = p_reassign_to
      where project = p_project_id
        and workspace_id = p_workspace_id                    -- tenant scope
        and private.can_see_task(auth.uid(), id);            -- GATE A
    get diagnostics v_affected = row_count;

  else
    raise exception 'invalid mode: %', p_mode using errcode = '22023';
  end if;

  delete from public.projects
    where id = p_project_id and workspace_id = p_workspace_id; -- guaranteed 1 row (existence checked above)
  get diagnostics v_proj = row_count;

  return jsonb_build_object('mode', v_mode, 'tasks_affected', v_affected, 'project_deleted', v_proj > 0);
end;
$fn$;
revoke all on function private._delete_project(text, uuid, text, text) from public, anon;
grant execute on function private._delete_project(text, uuid, text, text) to authenticated;

create or replace function public.delete_project(
  p_project_id text, p_workspace_id uuid, p_mode text default 'unassign', p_reassign_to text default 'other'
) returns jsonb
language sql set search_path to '' as $fn$
  select private._delete_project(p_project_id, p_workspace_id, p_mode, p_reassign_to);
$fn$;
revoke all on function public.delete_project(text, uuid, text, text) from public, anon;
grant execute on function public.delete_project(text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- (2) HARNESS: impersonation + the M8 mutation mirror
-- ---------------------------------------------------------------------------
create function pg_temp.imp(p_uid uuid) returns void language plpgsql as $fn$
declare v_email text;
begin
  execute 'reset role';
  select u.email into v_email from auth.users u where u.id = p_uid;
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'email', coalesce(v_email, ''))::text, true);
end $fn$;

-- Byte-identical to the deployed cascade DELETE, EXCEPT p_scope toggles the workspace_id predicate.
-- SECURITY DEFINER + owned by postgres => bypasses RLS, exactly like the real DEFINER RPC, so the
-- workspace predicate is the ONLY tenant guard (as in production).
create function pg_temp.cascade_mut(p_project text, p_ws uuid, p_scope boolean) returns int
language plpgsql security definer set search_path to '' as $fn$
declare n int;
begin
  if p_scope then
    delete from public.tasks
     where project = p_project and workspace_id = p_ws and private.can_see_task(auth.uid(), id);
  else
    delete from public.tasks                                  -- M8 MUTATION: workspace_id stripped
     where project = p_project and private.can_see_task(auth.uid(), id);
  end if;
  get diagnostics n = row_count;
  return n;
end $fn$;

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;

-- ---------------------------------------------------------------------------
-- (3) THE PROOF
-- ---------------------------------------------------------------------------
do $pd$
declare
  v_sfx text := replace(gen_random_uuid()::text, '-', '');
  v_owner uuid := gen_random_uuid(); v_admin uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid(); v_guest uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_ws_t uuid := gen_random_uuid(); v_ws_b uuid := gen_random_uuid();
  v_slug text; v_other text; v_ghost text;
  v_t_ws text; v_t_ws2 text; v_t_hidden text; v_b_ws text; v_t_ghost text;
  v_ret jsonb; v_actual text; v_msg text; v_n int;
  v_i1 int; v_i2 int; v_i3 int; v_i4 int; v_i5 int; v_i6 int; v_b1 boolean; v_s1 text;
  v_can boolean;
  -- expected messages (pin each denial to its exact gate)
  c_cascade_rank constant text := 'only an owner can delete a project and its tasks';
  c_unassign_rank constant text := 'only an owner or admin can delete a project';
  c_member constant text := 'not authorized';
  c_notfound constant text := 'project not found';
begin
  v_slug := 'pd-slug-'||v_sfx; v_other := 'pd-other-'||v_sfx; v_ghost := 'pd-ghost-'||v_sfx;
  v_t_ws := 'pd-tws-'||v_sfx; v_t_ws2 := 'pd-tws2-'||v_sfx; v_t_hidden := 'pd-thid-'||v_sfx;
  v_b_ws := 'pd-bws-'||v_sfx; v_t_ghost := 'pd-tghost-'||v_sfx;

  insert into auth.users (id, email, aud, role) values
    (v_owner, 'pd-owner-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_admin, 'pd-admin-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_member,'pd-member-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_guest, 'pd-guest-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_outsider,'pd-out-'||v_sfx||'@example.invalid','authenticated','authenticated');
  -- NB: handle_new_user AFTER INSERT on auth.users already creates the public.members rows.

  insert into public.workspaces (id,name,owner_id,slug) values (v_ws_t,'PD Test WS',v_owner,'pd-t-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_ws_t,v_owner,'owner'),(v_ws_t,v_admin,'admin'),(v_ws_t,v_member,'member'),(v_ws_t,v_guest,'guest');

  insert into public.workspaces (id,name,owner_id,slug) values (v_ws_b,'PD Collision WS',v_outsider,'pd-b-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_ws_b,v_outsider,'owner'),(v_ws_b,v_owner,'member');

  insert into public.projects (id,name,color,icon,workspace_id,created_by) values
    (v_slug,'Deleted Project','#64748b','#',v_ws_t,v_owner),
    (v_other,'Other','#64748b','#',v_ws_t,v_owner);
  -- NB: v_ghost is deliberately NOT inserted as a projects row.

  insert into public.tasks (id,title,privacy,project,status,workspace_id,created_by,assignee_id) values
    (v_t_ws,   'visible shared 1','workspace',v_slug, 'inbox',v_ws_t,v_owner, v_owner),   -- owner-visible
    (v_t_ws2,  'visible shared 2','workspace',v_slug, 'inbox',v_ws_t,v_member,v_member),  -- owner-visible (workspace)
    (v_t_hidden,'HIDDEN private', 'private',  v_slug, 'inbox',v_ws_t,v_member,v_member),  -- NOT owner/admin-visible
    (v_t_ghost,'ghost-slug task', 'workspace',v_ghost,'inbox',v_ws_t,v_owner, v_owner);   -- slug w/ NO project row
  insert into public.comments (task_id,author_id,body,workspace_id) values
    (v_t_ws,v_owner,'pd comment on cascaded task',v_ws_t);                                -- exercises FK cascade

  insert into public.tasks (id,title,privacy,project,status,workspace_id,created_by,assignee_id) values
    (v_b_ws,'WS_B same-slug task','workspace',v_slug,'inbox',v_ws_b,v_outsider,v_outsider); -- cross-tenant victim

  -- ===== HARNESS GUARD =====
  perform pg_temp.imp(v_owner);
  if current_user <> 'authenticated' then execute 'reset role'; raise exception 'HARNESS BROKEN: role not switched'; end if;
  if (select rolbypassrls from pg_roles where rolname=current_user) then execute 'reset role'; raise exception 'HARNESS BROKEN: assertion role bypasses RLS'; end if;
  if auth.uid() is distinct from v_owner then execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid() mismatch'; end if;
  execute 'reset role';

  -- ===== ANTI-VACUITY GUARD =====
  perform pg_temp.imp(v_owner);
  select count(*) into v_n from public.tasks where project=v_slug and workspace_id=v_ws_t;
  if v_n <> 2 then execute 'reset role'; raise exception 'VACUOUS: owner should see exactly 2 WS_T slug tasks, saw %', v_n; end if;
  execute 'reset role';
  select private.can_see_task(v_owner, v_t_hidden) into v_can;
  if v_can then raise exception 'VACUOUS: owner should NOT see the hidden private task'; end if;
  select private.can_see_task(v_owner, v_b_ws) into v_can;
  if not v_can then raise exception 'VACUOUS: owner should see the WS_B victim (else M8 danger is fake)'; end if;
  if exists (select 1 from public.projects where id=v_ghost) then raise exception 'VACUOUS: ghost slug must have NO project row'; end if;
  select count(*) into v_n from public.tasks where id=v_t_ghost; if v_n<>1 then raise exception 'VACUOUS: ghost task missing'; end if;
  select count(*) into v_n from public.tasks where id=v_b_ws; if v_n<>1 then raise exception 'VACUOUS: WS_B victim missing'; end if;
  select count(*) into v_n from public.tasks where id=v_t_hidden; if v_n<>1 then raise exception 'VACUOUS: hidden task missing'; end if;
  select count(*) into v_n from public.projects where id=v_slug and workspace_id=v_ws_t; if v_n<>1 then raise exception 'VACUOUS: project row missing'; end if;

  -- ========================= DENIED (role / IDOR / validation), MESSAGE-PINNED =========================
  perform pg_temp.imp(v_guest);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'cascade',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (1,'D01 guest cascade denied (owner-only gate)','42501|'||c_cascade_rank,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_cascade_rank);

  perform pg_temp.imp(v_guest);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (2,'D02 guest unassign denied (rank gate)','42501|'||c_unassign_rank,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_unassign_rank);

  perform pg_temp.imp(v_member);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'cascade',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (3,'D03 member cascade denied (owner-only gate)','42501|'||c_cascade_rank,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_cascade_rank);

  perform pg_temp.imp(v_member);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (4,'D04 member unassign denied (rank gate)','42501|'||c_unassign_rank,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_unassign_rank);

  perform pg_temp.imp(v_admin);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'cascade',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (5,'D05 ADMIN cascade denied (owner-only gate)','42501|'||c_cascade_rank,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_cascade_rank);

  perform pg_temp.imp(v_outsider);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'cascade',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (6,'D06 outsider cascade denied (membership gate)','42501|'||c_member,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_member);

  perform pg_temp.imp(v_outsider);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (7,'D07 outsider unassign denied (membership gate)','42501|'||c_member,v_actual||'|'||v_msg,v_actual='42501' and v_msg=c_member);

  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'bogus',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (8,'D08 owner invalid mode rejected','22023|invalid mode: bogus',v_actual||'|'||v_msg,v_actual='22023' and v_msg='invalid mode: bogus');

  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_slug); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (9,'D09 owner unassign reassign-into-self rejected','22023|reassign target must differ from the deleted project',v_actual||'|'||v_msg,v_actual='22023' and v_msg='reassign target must differ from the deleted project');

  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign','   '); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (10,'D10 owner unassign empty reassign target rejected','22023|reassign target required',v_actual||'|'||v_msg,v_actual='22023' and v_msg='reassign target required');

  -- ---- project-existence guard (blocks the free-text-slug footgun) ----
  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_ghost,v_ws_t,'cascade',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (11,'D11 owner cascade on nonexistent project rejected','P0002|'||c_notfound,v_actual||'|'||v_msg,v_actual='P0002' and v_msg=c_notfound);

  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_ghost,v_ws_t,'unassign',v_other); v_actual:='ALLOWED'; v_msg:=''; exception when others then v_actual:=sqlstate; v_msg:=sqlerrm; end;
  execute 'reset role'; insert into _r values (12,'D12 owner unassign on nonexistent project rejected','P0002|'||c_notfound,v_actual||'|'||v_msg,v_actual='P0002' and v_msg=c_notfound);

  select count(*) into v_n from public.tasks where id=v_t_ghost;                          -- ground truth (postgres)
  insert into _r values (13,'D13 footgun blocked: ghost-slug task SURVIVES the rejected cascade','1',v_n::text,v_n=1);

  -- ========================= OWNER CASCADE (real RPC, sandboxed) =========================
  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug,v_ws_t,'cascade',v_other);
    execute 'reset role';
    v_i1 := (v_ret->>'tasks_affected')::int;
    v_b1 := (v_ret->>'project_deleted')::boolean;
    select count(*) into v_i2 from public.tasks where id in (v_t_ws,v_t_ws2);
    select count(*) into v_i3 from public.tasks where id=v_t_hidden;
    select project into v_s1 from public.tasks where id=v_t_hidden;
    select count(*) into v_i4 from public.tasks where id=v_b_ws;
    select count(*) into v_i5 from public.projects where id=v_slug and workspace_id=v_ws_t;
    select count(*) into v_i6 from public.comments where task_id=v_t_ws;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (14,'C01 owner cascade tasks_affected=2','2',v_i1::text,v_i1=2);
  insert into _r values (15,'C02 owner cascade project_deleted=true','true',coalesce(v_b1::text,'NULL'),v_b1 is true);
  insert into _r values (16,'C03 owner cascade deletes the 2 visible slug tasks','0',v_i2::text,v_i2=0);
  insert into _r values (17,'C04 GATE A: hidden private task survives + slug unchanged',v_slug,coalesce(v_s1,'GONE:'||v_i3::text),v_i3=1 and v_s1=v_slug);
  insert into _r values (18,'C05 WORKSPACE SCOPE: WS_B same-slug victim survives','1',v_i4::text,v_i4=1);
  insert into _r values (19,'C06 owner cascade deletes the project row','0',v_i5::text,v_i5=0);
  insert into _r values (20,'C07 FK-cascade: comment on cascaded task gone (no RESTRICT block)','0',v_i6::text,v_i6=0);

  -- ========================= ADMIN UNASSIGN (real RPC, sandboxed) =========================
  begin
    perform pg_temp.imp(v_admin);
    v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other);
    execute 'reset role';
    v_i1 := (v_ret->>'tasks_affected')::int;
    select count(*) into v_i2 from public.tasks where id in (v_t_ws,v_t_ws2) and project=v_other;
    select project into v_s1 from public.tasks where id=v_t_hidden;
    select project into v_actual from public.tasks where id=v_b_ws;
    select count(*) into v_i5 from public.projects where id=v_slug and workspace_id=v_ws_t;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (21,'U01 admin unassign tasks_affected=2','2',v_i1::text,v_i1=2);
  insert into _r values (22,'U02 admin unassign re-files the 2 visible tasks to Other','2',v_i2::text,v_i2=2);
  insert into _r values (23,'U03 GATE A: hidden private task NOT re-filed (still slug)',v_slug,coalesce(v_s1,'NULL'),v_s1=v_slug);
  insert into _r values (24,'U04 WORKSPACE SCOPE: WS_B victim untouched (still slug)',v_slug,coalesce(v_actual,'NULL'),v_actual=v_slug);
  insert into _r values (25,'U05 admin unassign deletes the project row','0',v_i5::text,v_i5=0);

  -- ========================= OWNER UNASSIGN (real RPC, sandboxed) =========================
  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other);
    execute 'reset role';
    v_i1 := (v_ret->>'tasks_affected')::int;
    select count(*) into v_i2 from public.tasks where id in (v_t_ws,v_t_ws2) and project=v_other;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (26,'U06 owner unassign re-files 2 (owner may unassign too)','2|2',v_i1::text||'|'||v_i2::text,v_i1=2 and v_i2=2);

  -- ========================= M8 MUTATION DEMONSTRATION (mirror) =========================
  begin
    perform pg_temp.imp(v_owner);
    v_i1 := pg_temp.cascade_mut(v_slug,v_ws_t,true);
    execute 'reset role';
    select count(*) into v_i4 from public.tasks where id=v_b_ws;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (27,'M01 scoped mirror deletes exactly the 2 WS_T visible tasks','2',v_i1::text,v_i1=2);
  insert into _r values (28,'M02 scoped mirror: WS_B victim SURVIVES (matches real RPC C05)','1',v_i4::text,v_i4=1);

  begin
    perform pg_temp.imp(v_owner);
    v_i1 := pg_temp.cascade_mut(v_slug,v_ws_t,false);
    execute 'reset role';
    select count(*) into v_i4 from public.tasks where id=v_b_ws;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (29,'M03 UNSCOPED mirror (M8) DESTROYS WS_B victim (predicate is load-bearing)','0',v_i4::text,v_i4=0);

  -- ===== completeness =====
  select count(*) into v_n from _r; if v_n <> 29 then raise exception 'INCOMPLETE: % rows, expected 29', v_n; end if;
  if exists (select 1 from _r where pass is null) then raise exception 'NULL pass value'; end if;
end
$pd$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;
