-- Phase 3B-3: sanctioned workspace-creation RPC (advisor-clean variant).
--
-- public.create_workspace(p_name) is the ONLY sanctioned write path into
-- public.workspaces / public.workspace_members. Both tables remain SELECT-only under
-- RLS for authenticated (no INSERT/UPDATE/DELETE policy or grant); this RPC writes past
-- that via a SECURITY DEFINER impl. It is tightly constrained: it creates exactly one
-- workspace owned by the CALLER (auth.uid(), never a parameter) plus exactly one
-- workspace_members row making the caller its 'owner'. It cannot create a workspace for
-- anyone else, add any other member, or touch an existing workspace.
--
-- Advisor-clean design: the privileged DEFINER body lives in the non-API 'private'
-- schema (same pattern as private.is_workspace_*), so it does not trip the
-- authenticated_security_definer_function_executable advisor. The public API entry the
-- app calls is a thin SECURITY INVOKER passthrough (not DEFINER), so it doesn't trip it
-- either. EXECUTE on both is granted to 'authenticated' only (revoked from public/anon).
--
-- handle_new_user is intentionally NOT touched: signup still creates only the members
-- profile row, never a workspace. Workspace creation is an explicit authenticated action.

-- The wrapper executes as the caller (authenticated), so it needs USAGE on private to
-- reach the impl. Already granted (the RLS helpers live there); included idempotently so
-- this migration is self-contained on a fresh database.
grant usage on schema private to authenticated;

-- Privileged implementation: SECURITY DEFINER, search_path='', in the non-API schema.
create or replace function private._create_workspace(p_name text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_ws   public.workspaces;
begin
  -- (1) must be authenticated
  if v_uid is null then
    raise exception 'You must be signed in to create a workspace.'
      using errcode = '28000';   -- invalid_authorization_specification
  end if;

  -- (2) validate the name: non-empty after trim, <= 80 chars
  if v_name = '' then
    raise exception 'Workspace name is required.'
      using errcode = '22023';   -- invalid_parameter_value
  end if;
  if char_length(v_name) > 80 then
    raise exception 'Workspace name must be 80 characters or fewer.'
      using errcode = '22023';
  end if;

  -- (3) create the workspace, owned BY THE CALLER (never a parameter)
  insert into public.workspaces (name, owner_id)
  values (v_name, v_uid)
  returning * into v_ws;

  -- (4) make the caller its owner -- the only membership this RPC ever writes
  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws.id, v_uid, 'owner');

  -- (5) return the new workspace row
  return v_ws;
end;
$$;

revoke execute on function private._create_workspace(text) from public;
revoke execute on function private._create_workspace(text) from anon;
grant  execute on function private._create_workspace(text) to authenticated;

-- Public RPC entry the app calls: SECURITY INVOKER passthrough to the private impl.
create or replace function public.create_workspace(p_name text)
returns public.workspaces
language sql
security invoker
set search_path = ''
as $$
  select * from private._create_workspace(p_name);
$$;

revoke execute on function public.create_workspace(text) from public;
revoke execute on function public.create_workspace(text) from anon;
grant  execute on function public.create_workspace(text) to authenticated;
