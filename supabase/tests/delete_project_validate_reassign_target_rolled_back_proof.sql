-- ============================================================================================
-- ROLLED-BACK PROOF — _delete_project must VALIDATE the reassign target
-- STATUS: RUN GREEN 39/39 on 2026-07-19 against nqlzjuxqgajeoypyzlnv, before applying. Shipped as
--         migration 20260719172122_delete_project_validate_reassign_target.sql. RESTRUCTURED with a
--         REWIND section after that migration went live, and re-run GREEN 40/40 as a regression suite.
--
-- 40 assertions. NOTHING IS APPLIED. The whole file is one transaction ending in ROLLBACK.
--
-- Run the WHOLE file as ONE execute_sql call. Read the `failed` column of the result — a RED run
-- still returns success from execute_sql.
--
-- SHAPE (house convention):
--   (0) harness plumbing
--   (1) REWIND to the pre-fix (20260716104604) function bodies + an anti-vacuity assertion that the
--       rewind actually took effect
--   (2) fixtures + harness guard + anti-vacuity, then the RED phase against those rewound rules
--   (3) the DDL UNDER TEST at TOP LEVEL — a bare CREATE OR REPLACE FUNCTION cannot run inside a
--       plpgsql DO block, and it must land AFTER the RED phase so RED really tests the old rules
--   (4) a GREEN phase re-running the same scenarios plus the full regression surface
--   (5) a VERDICT that RAISES on any NULL pass or an unexpected assertion count
--
-- Fixture ids are carried between the two DO blocks through the temp table _fx (each block picks
-- its own random suffix otherwise). SYNTHETIC FIXTURES ONLY — every actor, workspace, project and
-- task is gen_random_uuid()-derived and created inside this transaction. No live row is read or
-- mutated, and every DELETE below is either inside the RPC (which is workspace_id-scoped) or
-- absent entirely.
--
-- Every successful mutation runs inside a nested block that captures its effects into variables
-- then `raise 'PD_UNDO'`, so the next scenario sees pristine fixtures (pattern lifted verbatim from
-- supabase/tests/project_delete_cascade_rolled_back_proof.sql, the 29/29 suite for this same RPC —
-- this proof must not, and does not, contradict it: D01-D13/C01-C07/U01-U06 are all re-asserted
-- here as the E-, C- and H-series).
--
-- Denial assertions pin SQLSTATE **and** message text. That matters more than usual here: the new
-- check deliberately reuses P0002, the SAME sqlstate as the pre-existing 'project not found' raise
-- three lines above it. Asserting the code alone would pass with the new check deleted.
--
-- LANDMINE (house rule, 20260718195827): this file RE-CREATES the DDL under test, in BOTH its
-- pre-fix and post-fix forms. If the shipped migration's body, signature defaults, grants or raise
-- messages change, CHANGE THEM HERE TOO — otherwise this suite silently proves a body that no
-- longer ships.
-- ============================================================================================

begin;

-- ---------------------------------------------------------------------------
-- (0) HARNESS PLUMBING
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

create temp table _r(id int primary key, name text, expected text, actual text, pass boolean) on commit drop;
create temp table _fx(k text primary key, v text) on commit drop;

-- LANDMINE (this is what left stripe_sandbox_billing silently un-runnable): a session running as
-- `authenticated` cannot write a temp table created by `postgres`, and the failed insert aborts the
-- whole suite. Two independent mitigations: every insert below is preceded by `reset role`, AND the
-- scratch tables are explicitly granted (nothing asserts on their contents, so this is free).
do $g$
begin
  execute format('grant usage on schema %I to authenticated',
                 (select nspname from pg_namespace where oid = pg_my_temp_schema()));
  execute 'grant insert, select on _r to authenticated';
  execute 'grant insert, select on _fx to authenticated';
end $g$;

-- ---------------------------------------------------------------------------
-- (1) REWIND — recreate the PRE-MIGRATION state
--
-- This file has TWO lifecycles, and they conflict. BEFORE 20260719172122 was applied it demonstrated
-- a missing validation against the then-live body; now that the migration is LIVE it has to serve as
-- a re-runnable REGRESSION suite. Its original opening pre-check RAISED 'RED PHASE INVALID: the live
-- function already contains the fix' — which, post-apply, aborts the whole transaction and takes the
-- entire suite with it. The file scored no assertions at all rather than failing gracefully, which is
-- exactly the failure mode the chat_reads and dm_reads proofs hit and fixed the same way.
--
-- So REWIND first: restore a faithful copy of the pre-fix rules, transaction-locally, so RED can
-- still demonstrate the disease. THE DDL UNDER TEST below then re-applies the fix and GREEN re-proves
-- the cure — the arrangement that makes this a real regression suite rather than a one-shot. All of
-- it is inside the enclosing transaction and is undone by the final rollback.
--
-- BOTH halves must be rewound, not just the impl. R06 attacks the API-layer footgun (an omitted
-- p_reassign_to defaulting to the phantom seed id 'other'), so the wrapper's signature default has to
-- go back to 'other' as well or that assertion tests nothing. Both bodies below are 20260716104604's,
-- reproduced exactly.
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
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_rank := private.workspace_role_rank(p_workspace_id);

  if v_mode = 'cascade' then
    if v_rank < 3 then
      raise exception 'only an owner can delete a project and its tasks' using errcode = '42501';
    end if;
    if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    delete from public.tasks
      where project = p_project_id and workspace_id = p_workspace_id and private.can_see_task(auth.uid(), id);
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
    -- NO TARGET VALIDATION HERE. That absence IS the disease; assertion 1 pins it.
    update public.tasks
      set project = p_reassign_to
      where project = p_project_id and workspace_id = p_workspace_id and private.can_see_task(auth.uid(), id);
    get diagnostics v_affected = row_count;
  else
    raise exception 'invalid mode: %', p_mode using errcode = '22023';
  end if;

  delete from public.projects where id = p_project_id and workspace_id = p_workspace_id;
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

-- ANTI-VACUITY for the whole RED phase, and the replacement for the old raising pre-check. If the
-- rewind silently failed, RED would be attacking the FIXED body: R01/R05 would be rejected and go red
-- (noisy, recoverable) — but R06 would go red for a reason that looks like a different bug entirely.
-- Assert the rewound state explicitly instead, and assert BOTH halves of it, because R01/R05 depend on
-- the impl's missing check and R06 depends on the wrapper's 'other' default.
insert into _r
select 1,'REWIND: pre-fix body restored — no target validation, wrapper default back to ''other''',
  'absent|p_reassign_to text DEFAULT ''other''',
  (case when position('reassign target project does not exist' in priv.def) > 0
        then 'PRESENT (rewind failed)' else 'absent' end)
    ||'|'|| pub.args,
  position('reassign target project does not exist' in priv.def) = 0
    and pub.args like '%p_reassign_to text DEFAULT ''other''%'
from (select pg_get_functiondef(p.oid) as def
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'private' and p.proname = '_delete_project') priv,
     (select pg_get_function_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'delete_project') pub;

-- ---------------------------------------------------------------------------
-- (2) FIXTURES + HARNESS GUARD + ANTI-VACUITY + THE RED PHASE (REWOUND FUNCTION)
-- ---------------------------------------------------------------------------
do $red$
declare
  v_sfx text := replace(gen_random_uuid()::text, '-', '');
  v_owner uuid := gen_random_uuid(); v_admin uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid(); v_guest uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_ws_t uuid := gen_random_uuid(); v_ws_b uuid := gen_random_uuid();
  v_slug text; v_other text; v_ghost text; v_bonly text;
  v_t_ws text; v_t_ws2 text; v_t_hidden text; v_b_ws text;
  v_ret jsonb; v_actual text; v_msg text; v_n int; v_can boolean;
  v_i1 int; v_i2 int; v_i3 int; v_b1 boolean; v_s1 text; v_s2 text;
begin
  v_slug   := 'vr-slug-'||v_sfx;   -- the project being deleted            (WS_T)
  v_other  := 'vr-other-'||v_sfx;  -- a VALID reassign target              (WS_T)
  v_ghost  := 'vr-ghost-'||v_sfx;  -- resolves to NO projects row anywhere
  v_bonly  := 'vr-bonly-'||v_sfx;  -- a real project, but in WS_B ONLY
  v_t_ws   := 'vr-tws-'||v_sfx;    v_t_ws2 := 'vr-tws2-'||v_sfx;
  v_t_hidden := 'vr-thid-'||v_sfx; v_b_ws  := 'vr-bws-'||v_sfx;

  insert into auth.users (id, email, aud, role) values
    (v_owner,   'vr-owner-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_admin,   'vr-admin-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_member,  'vr-member-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_guest,   'vr-guest-'||v_sfx||'@example.invalid','authenticated','authenticated'),
    (v_outsider,'vr-out-'||v_sfx||'@example.invalid','authenticated','authenticated');
  -- handle_new_user (AFTER INSERT on auth.users) creates the public.members rows for us.

  insert into public.workspaces (id,name,owner_id,slug) values (v_ws_t,'VR Test WS',v_owner,'vr-t-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_ws_t,v_owner,'owner'),(v_ws_t,v_admin,'admin'),(v_ws_t,v_member,'member'),(v_ws_t,v_guest,'guest');

  -- WS_B is the other tenant. v_owner is deliberately a MEMBER of it, which makes the
  -- cross-workspace-target test the STRONG version: even a caller who can legitimately see the
  -- target project must not be able to re-file WS_T's tasks onto it.
  insert into public.workspaces (id,name,owner_id,slug) values (v_ws_b,'VR Collision WS',v_outsider,'vr-b-'||v_sfx);
  insert into public.workspace_members (workspace_id,user_id,role) values
    (v_ws_b,v_outsider,'owner'),(v_ws_b,v_owner,'member');

  insert into public.projects (id,name,color,icon,workspace_id,created_by) values
    (v_slug, 'Deleted Project','#64748b','#',v_ws_t,v_owner),
    (v_other,'Other',          '#64748b','#',v_ws_t,v_owner),
    (v_bonly,'WS_B Only',      '#64748b','#',v_ws_b,v_outsider);
  -- v_ghost is deliberately NOT inserted as a projects row, in either workspace.

  insert into public.tasks (id,title,privacy,project,status,workspace_id,created_by,assignee_id) values
    (v_t_ws,    'visible shared 1','workspace',v_slug,'inbox',v_ws_t,v_owner, v_owner),
    (v_t_ws2,   'visible shared 2','workspace',v_slug,'inbox',v_ws_t,v_member,v_member),
    (v_t_hidden,'HIDDEN private',  'private',  v_slug,'inbox',v_ws_t,v_member,v_member);
  insert into public.tasks (id,title,privacy,project,status,workspace_id,created_by,assignee_id) values
    (v_b_ws,'WS_B same-slug task','workspace',v_slug,'inbox',v_ws_b,v_outsider,v_outsider);

  insert into _fx values
    ('sfx',v_sfx),('owner',v_owner::text),('admin',v_admin::text),('member',v_member::text),
    ('guest',v_guest::text),('outsider',v_outsider::text),('ws_t',v_ws_t::text),('ws_b',v_ws_b::text),
    ('slug',v_slug),('other',v_other),('ghost',v_ghost),('bonly',v_bonly),
    ('t_ws',v_t_ws),('t_ws2',v_t_ws2),('t_hidden',v_t_hidden),('b_ws',v_b_ws);

  -- ===================== HARNESS GUARD (RAISES, never records) =====================
  -- postgres has rolbypassrls=true on this project, so a proof that forgets to switch role proves
  -- NOTHING. All four of these abort the run rather than recording a pass.
  perform pg_temp.imp(v_owner);
  if current_user <> 'authenticated' then
    execute 'reset role'; raise exception 'HARNESS BROKEN: role not switched (current_user=%)', current_user; end if;
  if (select rolbypassrls from pg_roles where rolname = current_user) then
    execute 'reset role'; raise exception 'HARNESS BROKEN: assertion role has the rolbypassrls PROPERTY'; end if;
  if auth.uid() is distinct from v_owner then
    execute 'reset role'; raise exception 'HARNESS BROKEN: auth.uid()=% expected %', auth.uid(), v_owner; end if;
  execute 'reset role';

  -- Control write that MUST be denied with EXACTLY 42501: an outsider inserting a project into WS_T.
  -- If RLS were being bypassed this would succeed and every "denied" assertion below would be fake.
  perform pg_temp.imp(v_outsider);
  begin
    insert into public.projects (id,name,color,icon,workspace_id,created_by)
      values ('vr-ctl-'||v_sfx,'control','#64748b','#',v_ws_t,v_outsider);
    v_actual := 'ALLOWED';
  exception when others then v_actual := sqlstate;
  end;
  execute 'reset role';
  if v_actual <> '42501' then
    raise exception 'HARNESS BROKEN: control write returned % (expected 42501) — RLS is not gating', v_actual; end if;

  -- ===================== ANTI-VACUITY GUARD =====================
  perform pg_temp.imp(v_owner);
  select count(*) into v_n from public.tasks where project = v_slug and workspace_id = v_ws_t;
  if v_n <> 2 then execute 'reset role';
    raise exception 'VACUOUS: owner should see exactly 2 WS_T slug tasks, saw %', v_n; end if;
  execute 'reset role';
  select private.can_see_task(v_owner, v_t_hidden) into v_can;
  if v_can then raise exception 'VACUOUS: owner must NOT see the hidden private task (GATE A tests would be fake)'; end if;
  if exists (select 1 from public.projects where id = v_ghost) then
    raise exception 'VACUOUS: the ghost slug must have NO projects row'; end if;
  if not exists (select 1 from public.projects where id = v_bonly and workspace_id = v_ws_b) then
    raise exception 'VACUOUS: the WS_B-only target project is missing'; end if;
  if exists (select 1 from public.projects where id = v_bonly and workspace_id = v_ws_t) then
    raise exception 'VACUOUS: the WS_B-only target must NOT exist in WS_T'; end if;
  if exists (select 1 from public.projects where id = 'other' and workspace_id = v_ws_t) then
    raise exception 'VACUOUS: WS_T must not contain a project literally named other (R06 would be fake)'; end if;
  select count(*) into v_n from public.tasks where id = v_b_ws; if v_n <> 1 then
    raise exception 'VACUOUS: WS_B victim task missing'; end if;

  -- (The old raising pre-check that lived here — "RED PHASE INVALID: the live function already
  --  contains the fix" — is what made this file un-runnable once the migration shipped. It is now
  --  the REWIND above plus recorded assertion 1.)

  -- ============================================================================
  -- RED — the disease, against the REWOUND (pre-fix) rules
  -- ============================================================================

  -- R01-R04: unassign onto an id that resolves to no project at all.
  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug, v_ws_t, 'unassign', v_ghost);
    execute 'reset role';
    v_actual := 'ALLOWED';
    v_i1 := (v_ret->>'tasks_affected')::int;
    v_b1 := (v_ret->>'project_deleted')::boolean;
    -- how many of the moved tasks now point at a project id that does not resolve in their workspace?
    select count(*) into v_i2 from public.tasks t
      where t.id in (v_t_ws, v_t_ws2) and t.project = v_ghost
        and not exists (select 1 from public.projects p where p.id = t.project and p.workspace_id = t.workspace_id);
    select count(*) into v_i3 from public.projects where id = v_slug and workspace_id = v_ws_t;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then v_actual := sqlstate||'|'||sqlerrm; v_i1 := null; v_b1 := null; v_i2 := null; v_i3 := null; end if;
  end;
  insert into _r values (2,'R01 RED: pre-fix fn ACCEPTS a nonexistent reassign target','ALLOWED',v_actual,v_actual='ALLOWED');
  insert into _r values (3,'R02 RED: and reports success (tasks_affected=2, project_deleted=true)','2|true',
    coalesce(v_i1::text,'NULL')||'|'||coalesce(v_b1::text,'NULL'), v_i1=2 and v_b1 is true);
  insert into _r values (4,'R03 RED: SILENT STRANDING — both moved tasks now point at an unresolvable project','2',
    coalesce(v_i2::text,'NULL'), v_i2=2);
  insert into _r values (5,'R04 RED: the project row was deleted anyway (damage is committed, not partial)','0',
    coalesce(v_i3::text,'NULL'), v_i3=0);

  -- R05: a target that exists, but in ANOTHER tenant's workspace.
  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug, v_ws_t, 'unassign', v_bonly);
    execute 'reset role';
    v_actual := 'ALLOWED';
    select project into v_s1 from public.tasks where id = v_t_ws;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then v_actual := sqlstate||'|'||sqlerrm; v_s1 := null; end if;
  end;
  insert into _r values (6,'R05 RED: pre-fix fn ACCEPTS a target belonging to ANOTHER workspace','ALLOWED|'||v_bonly,
    v_actual||'|'||coalesce(v_s1,'NULL'), v_actual='ALLOWED' and v_s1=v_bonly);

  -- R06: the phantom seed default. p_reassign_to OMITTED -> the pre-fix default 'other', which
  -- (checked live 2026-07-19) exists in NONE of the three real workspaces either.
  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug, v_ws_t, 'unassign');
    execute 'reset role';
    v_actual := 'ALLOWED';
    select project into v_s1 from public.tasks where id = v_t_ws;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then v_actual := sqlstate||'|'||sqlerrm; v_s1 := null; end if;
  end;
  insert into _r values (7,'R06 RED: omitted p_reassign_to strands tasks on the phantom seed id other','ALLOWED|other',
    v_actual||'|'||coalesce(v_s1,'NULL'), v_actual='ALLOWED' and v_s1='other');

  -- R07: ANTI-VACUITY for the RED phase — a VALID target already worked, so R01/R05/R06 are about
  -- missing validation, not about a broken fixture or an unusable RPC.
  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug, v_ws_t, 'unassign', v_other);
    execute 'reset role';
    v_actual := 'ALLOWED';
    select project into v_s1 from public.tasks where id = v_t_ws;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then v_actual := sqlstate||'|'||sqlerrm; v_s1 := null; end if;
  end;
  insert into _r values (8,'R07 RED anti-vacuity: a VALID target already worked pre-fix','ALLOWED|'||v_other,
    v_actual||'|'||coalesce(v_s1,'NULL'), v_actual='ALLOWED' and v_s1=v_other);

  -- Fixtures must be pristine for the GREEN phase.
  select count(*) into v_n from public.tasks where project = v_slug and workspace_id = v_ws_t;
  if v_n <> 3 then raise exception 'RED LEAKED: expected 3 WS_T slug tasks after undo, saw %', v_n; end if;
  if not exists (select 1 from public.projects where id = v_slug and workspace_id = v_ws_t) then
    raise exception 'RED LEAKED: the project row did not come back'; end if;
end
$red$;

-- ---------------------------------------------------------------------------
-- (3) THE DDL UNDER TEST — top level (a bare CREATE OR REPLACE cannot run in a DO block).
--     Byte-identical to the shipped 20260719172122. Rolled back with everything else at the end.
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
  if not private.is_workspace_member(p_workspace_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_rank := private.workspace_role_rank(p_workspace_id);

  if v_mode = 'cascade' then
    if v_rank < 3 then
      raise exception 'only an owner can delete a project and its tasks' using errcode = '42501';
    end if;
    if not exists (select 1 from public.projects where id = p_project_id and workspace_id = p_workspace_id) then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
    delete from public.tasks
      where project = p_project_id and workspace_id = p_workspace_id and private.can_see_task(auth.uid(), id);
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
    -- THE FIX.
    if not exists (select 1 from public.projects where id = p_reassign_to and workspace_id = p_workspace_id) then
      raise exception 'reassign target project does not exist in this workspace' using errcode = 'P0002';
    end if;
    update public.tasks
      set project = p_reassign_to
      where project = p_project_id and workspace_id = p_workspace_id and private.can_see_task(auth.uid(), id);
    get diagnostics v_affected = row_count;
  else
    raise exception 'invalid mode: %', p_mode using errcode = '22023';
  end if;

  delete from public.projects where id = p_project_id and workspace_id = p_workspace_id;
  get diagnostics v_proj = row_count;

  return jsonb_build_object('mode', v_mode, 'tasks_affected', v_affected, 'project_deleted', v_proj > 0);
end;
$fn$;
revoke all on function private._delete_project(text, uuid, text, text) from public, anon;
grant execute on function private._delete_project(text, uuid, text, text) to authenticated;

create or replace function public.delete_project(
  p_project_id text, p_workspace_id uuid, p_mode text default 'unassign', p_reassign_to text default null
) returns jsonb
language sql set search_path to '' as $fn$
  select private._delete_project(p_project_id, p_workspace_id, p_mode, p_reassign_to);
$fn$;
revoke all on function public.delete_project(text, uuid, text, text) from public, anon;
grant execute on function public.delete_project(text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- (4) GREEN — the cure, plus the full regression surface
-- ---------------------------------------------------------------------------
do $green$
declare
  v_owner uuid; v_admin uuid; v_member uuid; v_guest uuid; v_outsider uuid;
  v_ws_t uuid; v_ws_b uuid;
  v_slug text; v_other text; v_ghost text; v_bonly text;
  v_t_ws text; v_t_ws2 text; v_t_hidden text; v_b_ws text;
  v_ret jsonb; v_actual text; v_msg text; v_n int;
  v_i1 int; v_i2 int; v_i3 int; v_i4 int; v_i5 int; v_b1 boolean; v_s1 text; v_s2 text; v_s3 text;
  c_nofix   constant text := 'reassign target project does not exist in this workspace';
  c_notfnd  constant text := 'project not found';
  c_required constant text := 'reassign target required';
  c_differ  constant text := 'reassign target must differ from the deleted project';
  c_casrank constant text := 'only an owner can delete a project and its tasks';
  c_unarank constant text := 'only an owner or admin can delete a project';
  c_member  constant text := 'not authorized';
begin
  select v into v_owner    from _fx where k='owner';     select v into v_admin  from _fx where k='admin';
  select v into v_member   from _fx where k='member';    select v into v_guest  from _fx where k='guest';
  select v into v_outsider from _fx where k='outsider';
  select v into v_ws_t     from _fx where k='ws_t';      select v into v_ws_b   from _fx where k='ws_b';
  select v into v_slug     from _fx where k='slug';      select v into v_other  from _fx where k='other';
  select v into v_ghost    from _fx where k='ghost';     select v into v_bonly  from _fx where k='bonly';
  select v into v_t_ws     from _fx where k='t_ws';      select v into v_t_ws2  from _fx where k='t_ws2';
  select v into v_t_hidden from _fx where k='t_hidden';  select v into v_b_ws   from _fx where k='b_ws';

  -- ============================ THE NEW CHECK ============================

  -- G01-G03: the exact RED scenario, now rejected — and rejected CLEANLY.
  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_ghost); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  select count(*) into v_i1 from public.tasks
    where id in (v_t_ws,v_t_ws2,v_t_hidden) and project = v_slug and workspace_id = v_ws_t;
  select count(*) into v_i2 from public.projects where id = v_slug and workspace_id = v_ws_t;
  insert into _r values (9,'G01 nonexistent target now rejected — EXACT sqlstate AND message','P0002|'||c_nofix,
    v_actual||'|'||v_msg, v_actual='P0002' and v_msg=c_nofix);
  insert into _r values (10,'G02 rejected call is atomic: all 3 WS_T slug tasks still on the original project','3',
    v_i1::text, v_i1=3);
  insert into _r values (11,'G03 rejected call is atomic: the project row was NOT deleted (no half-done delete)','1',
    v_i2::text, v_i2=1);

  -- G04-G05: a target that resolves, but in ANOTHER workspace. tasks.project is a free-text slug, so
  -- this is a genuine confusion; the caller here is even a legitimate member of WS_B.
  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_bonly); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  select count(*) into v_i1 from public.tasks
    where id in (v_t_ws,v_t_ws2,v_t_hidden) and project = v_slug and workspace_id = v_ws_t;
  select count(*) into v_i2 from public.projects where id = v_slug and workspace_id = v_ws_t;
  select project into v_s1 from public.tasks where id = v_b_ws;
  select count(*) into v_i3 from public.projects where id = v_bonly and workspace_id = v_ws_b;
  insert into _r values (12,'G04 cross-workspace target rejected — EXACT sqlstate AND message','P0002|'||c_nofix,
    v_actual||'|'||v_msg, v_actual='P0002' and v_msg=c_nofix);
  insert into _r values (13,'G05 cross-workspace rejection atomic: WS_T tasks+project and the WS_B tenant untouched',
    '3|1|'||v_slug||'|1', v_i1::text||'|'||v_i2::text||'|'||coalesce(v_s1,'NULL')||'|'||v_i3::text,
    v_i1=3 and v_i2=1 and v_s1=v_slug and v_i3=1);

  -- G06: the signature default. Omitting p_reassign_to must now be the TRUTHFUL error (22023
  -- "required"), not P0002 "does not exist" about a phantom seed id the caller never named.
  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign'); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (14,'G06 omitted p_reassign_to -> 22023 required (NOT P0002; default is NULL now)',
    '22023|'||c_required, v_actual||'|'||v_msg, v_actual='22023' and v_msg=c_required);

  -- ============================ HAPPY PATH UNCHANGED ============================
  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other);
    execute 'reset role';
    v_s1 := v_ret->>'mode';
    v_i1 := (v_ret->>'tasks_affected')::int;
    v_b1 := (v_ret->>'project_deleted')::boolean;
    select string_agg(k,',' order by k) into v_s2 from jsonb_object_keys(v_ret) k;
    select count(*) into v_i2 from public.tasks where id in (v_t_ws,v_t_ws2) and project = v_other;
    select project into v_s3 from public.tasks where id = v_t_hidden;
    select project into v_actual from public.tasks where id = v_b_ws;
    select count(*) into v_i5 from public.projects where id = v_slug and workspace_id = v_ws_t;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (15,'H01 valid target: mode unchanged','unassign',coalesce(v_s1,'NULL'),v_s1='unassign');
  insert into _r values (16,'H02 valid target: tasks_affected=2','2',coalesce(v_i1::text,'NULL'),v_i1=2);
  insert into _r values (17,'H03 valid target: project_deleted=true','true',coalesce(v_b1::text,'NULL'),v_b1 is true);
  insert into _r values (18,'H04 result jsonb key set UNCHANGED','mode,project_deleted,tasks_affected',
    coalesce(v_s2,'NULL'), v_s2='mode,project_deleted,tasks_affected');
  insert into _r values (19,'H05 the 2 visible tasks are re-filed onto the valid target','2',
    coalesce(v_i2::text,'NULL'), v_i2=2);
  insert into _r values (20,'H06 GATE A preserved: hidden private task NOT re-filed',v_slug,
    coalesce(v_s3,'NULL'), v_s3=v_slug);
  insert into _r values (21,'H07 WORKSPACE SCOPE preserved: WS_B same-slug victim untouched',v_slug,
    coalesce(v_actual,'NULL'), v_actual=v_slug);
  insert into _r values (22,'H08 the project row is deleted','0',coalesce(v_i5::text,'NULL'),v_i5=0);

  begin
    perform pg_temp.imp(v_admin);
    v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other);
    execute 'reset role';
    v_i1 := (v_ret->>'tasks_affected')::int;
    select count(*) into v_i2 from public.projects where id = v_slug and workspace_id = v_ws_t;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (23,'H09 ADMIN (rank 2) can still unassign with a valid target','2|0',
    coalesce(v_i1::text,'NULL')||'|'||coalesce(v_i2::text,'NULL'), v_i1=2 and v_i2=0);

  -- ============================ CASCADE COMPLETELY UNAFFECTED ============================
  -- The new check lives inside the unassign branch only. A garbage reassign target must be ignored.
  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug,v_ws_t,'cascade',v_ghost);
    execute 'reset role';
    v_i1 := (v_ret->>'tasks_affected')::int;
    v_b1 := (v_ret->>'project_deleted')::boolean;
    select count(*) into v_i2 from public.tasks where id = v_t_hidden;
    select count(*) into v_i3 from public.tasks where id = v_b_ws;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (24,'C01 cascade with a GARBAGE reassign target still succeeds (target ignored)','2|true',
    coalesce(v_i1::text,'NULL')||'|'||coalesce(v_b1::text,'NULL'), v_i1=2 and v_b1 is true);
  insert into _r values (25,'C02 cascade GATE A + tenant scope intact: hidden task and WS_B victim survive','1|1',
    coalesce(v_i2::text,'NULL')||'|'||coalesce(v_i3::text,'NULL'), v_i2=1 and v_i3=1);

  begin
    perform pg_temp.imp(v_owner);
    v_ret := public.delete_project(v_slug,v_ws_t,'cascade',null);
    execute 'reset role';
    v_i1 := (v_ret->>'tasks_affected')::int;
    v_b1 := (v_ret->>'project_deleted')::boolean;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (26,'C03 cascade with a NULL reassign target still succeeds','2|true',
    coalesce(v_i1::text,'NULL')||'|'||coalesce(v_b1::text,'NULL'), v_i1=2 and v_b1 is true);

  perform pg_temp.imp(v_admin);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'cascade',v_other); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (27,'C04 admin cascade still denied (owner-only gate untouched)','42501|'||c_casrank,
    v_actual||'|'||v_msg, v_actual='42501' and v_msg=c_casrank);

  -- ============================ EXISTING GUARDS STILL FIRE, SAME CODES ============================
  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',null); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (28,'E01 explicit NULL target -> 22023 required (not the new P0002)','22023|'||c_required,
    v_actual||'|'||v_msg, v_actual='22023' and v_msg=c_required);

  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign','   '); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (29,'E02 blank target -> 22023 required (not the new P0002)','22023|'||c_required,
    v_actual||'|'||v_msg, v_actual='22023' and v_msg=c_required);

  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_slug); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (30,'E03 target == deleted project -> 22023 differ','22023|'||c_differ,
    v_actual||'|'||v_msg, v_actual='22023' and v_msg=c_differ);

  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_ghost,v_ws_t,'unassign',v_other); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (31,'E04 deleted project missing -> P0002 project not found','P0002|'||c_notfnd,
    v_actual||'|'||v_msg, v_actual='P0002' and v_msg=c_notfnd);

  -- Both ids bogus. Same sqlstate from two different raises, so ONLY the message distinguishes them —
  -- this pins the documented ordering (you hear about the project you asked to DELETE first).
  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_ghost,v_ws_t,'unassign',v_ghost||'x'); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (32,'E05 PRECEDENCE unchanged: both ids bogus -> project not found wins','P0002|'||c_notfnd,
    v_actual||'|'||v_msg, v_actual='P0002' and v_msg=c_notfnd);

  perform pg_temp.imp(v_outsider);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (33,'E06 non-member -> 42501 not authorized','42501|'||c_member,
    v_actual||'|'||v_msg, v_actual='42501' and v_msg=c_member);

  perform pg_temp.imp(v_member);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (34,'E07 member (rank 1) -> 42501 rank gate','42501|'||c_unarank,
    v_actual||'|'||v_msg, v_actual='42501' and v_msg=c_unarank);

  perform pg_temp.imp(v_guest);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'unassign',v_other); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (35,'E08 guest (rank 0) -> 42501 rank gate','42501|'||c_unarank,
    v_actual||'|'||v_msg, v_actual='42501' and v_msg=c_unarank);

  perform pg_temp.imp(v_owner);
  begin v_ret := public.delete_project(v_slug,v_ws_t,'bogus',v_other); v_actual:='ALLOWED'; v_msg:='';
  exception when others then v_actual := sqlstate; v_msg := sqlerrm; end;
  execute 'reset role';
  insert into _r values (36,'E09 invalid mode -> 22023','22023|invalid mode: bogus',
    v_actual||'|'||v_msg, v_actual='22023' and v_msg='invalid mode: bogus');

  -- X01: ANTI-VACUITY for the denial block. The outsider is not simply broken — in their OWN
  -- workspace the very same RPC works for them.
  begin
    perform pg_temp.imp(v_outsider);
    v_ret := public.delete_project(v_bonly,v_ws_b,'cascade',null);
    execute 'reset role';
    v_b1 := (v_ret->>'project_deleted')::boolean;
    raise exception 'PD_UNDO';
  exception when others then
    execute 'reset role';
    if sqlerrm <> 'PD_UNDO' then raise; end if;
  end;
  insert into _r values (37,'X01 anti-vacuity: the denied outsider CAN delete in their OWN workspace','true',
    coalesce(v_b1::text,'NULL'), v_b1 is true);

  -- ============================ HARDENING SURVIVES CREATE OR REPLACE ============================
  select p.prosecdef::text ||'|'|| coalesce(array_to_string(p.proconfig,','),'NONE')
      ||'|'|| has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
      ||'|'|| has_function_privilege('anon', p.oid, 'EXECUTE')::text
    into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='private' and p.proname='_delete_project';
  -- NB: pg_proc.proconfig serializes `set search_path to ''` as the 5 characters search_path="" —
  -- an empty-STRING search_path, not an absent one. First run of this proof expected `search_path=`
  -- and both P-rows went red on the literal while every real property was already correct.
  insert into _r values (38,'P01 private._delete_project: DEFINER + search_path='''' + authenticated-only',
    'true|search_path=""|true|false', coalesce(v_actual,'NULL'), v_actual='true|search_path=""|true|false');

  select p.prosecdef::text ||'|'|| coalesce(array_to_string(p.proconfig,','),'NONE')
      ||'|'|| has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
      ||'|'|| has_function_privilege('anon', p.oid, 'EXECUTE')::text
    into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='delete_project';
  insert into _r values (39,'P02 public.delete_project: INVOKER + search_path='''' + authenticated-only',
    'false|search_path=""|true|false', coalesce(v_actual,'NULL'), v_actual='false|search_path=""|true|false');

  select pg_get_function_arguments(p.oid) into v_actual
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='delete_project';
  insert into _r values (40,'P03 signature default is NULL — the phantom seed id is gone from the API',
    'p_reassign_to DEFAULT NULL, no ''other''', coalesce(v_actual,'NULL'),
    v_actual like '%p_reassign_to text DEFAULT NULL%' and v_actual not like '%''other''%');
end
$green$;

-- ---------------------------------------------------------------------------
-- (5) VERDICT — raises on a NULL pass or an unexpected assertion count
-- ---------------------------------------------------------------------------
do $v$
declare v_n int; v_null int; v_fail int;
begin
  select count(*), count(*) filter (where pass is null), count(*) filter (where pass is false)
    into v_n, v_null, v_fail from _r;
  if v_null > 0 then raise exception 'INVALID: % assertion(s) with a NULL pass value', v_null; end if;
  if v_n <> 40 then raise exception 'INCOMPLETE: % assertion rows, expected 40', v_n; end if;
  if v_fail > 0 then raise notice 'RED: % assertion(s) FAILED — read the table below', v_fail; end if;
end
$v$;

select (select count(*) from _r) as total,
       (select count(*) from _r where pass) as passed,
       (select count(*) from _r where not pass) as failed;
select id, name, expected, actual, pass from _r order by id;

rollback;
