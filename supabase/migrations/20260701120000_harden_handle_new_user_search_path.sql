-- Harden public.handle_new_user: pin search_path = '' (defense-in-depth), matching every other
-- SECURITY DEFINER function in this project. Behavior is UNCHANGED — this only swaps the weaker
-- search_path='public' for the hardened empty search_path (with fully-qualified object names).
-- Mirrors the existing harden_* migrations (harden_role_rank_search_path,
-- harden_reset_due_reminder_search_path).
--
-- This is also the FIRST time handle_new_user enters version control: it previously existed only
-- in the live database (migration drift). See the security review for the remaining drift items
-- (base tables tasks/members/projects, the on_auth_user_created trigger, rls_auto_enable, and the
-- voice-notes storage bucket) which should be captured with `supabase db pull`.
--
-- TECH-DEBT (tracked separately, intentionally NOT changed in this security pass): the
-- "first signed-up user => members.role = 'owner'" rule below is LEGACY. Authorization is now
-- per-workspace via public.workspace_members.role; public.members.role is vestigial. Revisit
-- (drop members.role or neutralize this rule) as a deliberate product decision.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_count integer;
begin
  select count(*) into member_count from public.members;
  insert into public.members (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    case when member_count = 0 then 'owner' else 'member' end
  );
  return new;
end;
$$;
