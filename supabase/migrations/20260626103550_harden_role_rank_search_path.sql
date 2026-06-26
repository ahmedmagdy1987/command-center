-- Clear the function_search_path_mutable advisor on the pure role-rank helper (no table refs;
-- harmless, but kept advisor-clean like every other function here).
create or replace function private._role_rank(p_role text)
returns int language sql immutable set search_path = '' as $$
  select case p_role when 'owner' then 3 when 'admin' then 2 when 'member' then 1 when 'guest' then 0 else -1 end;
$$;
