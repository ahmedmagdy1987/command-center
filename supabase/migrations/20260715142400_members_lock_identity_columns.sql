-- BUG A — live impersonation via self-service identity rewrite.
--
-- members_update_self is column-agnostic: USING/WITH CHECK are both just "id = (select auth.uid())",
-- which pins WHICH row you may update but not WHICH COLUMNS. authenticated also held a table-wide
-- UPDATE grant. Net effect (reproduced live, rolled back): any signed-in user could rewrite their own
-- public.members.email to impersonate another person, because email is the identity display fallback
-- throughout the UI. RLS cannot express this rule -- a WITH CHECK sees only the NEW row and therefore
-- cannot compare new.email to old.email -- so the control must be a trigger (+ a least-privilege grant).
--
-- Two independent layers, proven independent (25/25 rolled-back, incl. a phase that re-grants the wide
-- UPDATE and shows the trigger still holds):
--   1. trigger  -- authoritative; survives a future grant mistake.
--   2. grants   -- least privilege; authenticated can only ever name display_name in a SET.
--
-- Supersedes members_lock_role (role-only). Mirrors the house exemplar enforce_task_author_immutable
-- (2026-07-12): SECURITY DEFINER, search_path='', "is distinct from" + errcode 42501, unconditional.
--
-- Zero-regression: the app has NO write path to public.members at all (src/lib/api.js only SELECTs, at
-- :51 and :58). Signup is unaffected -- handle_new_user INSERTs the row; this locks UPDATE only.
-- Escape hatch for a future backend email-sync: session_replication_role='replica' bypasses the trigger
-- (the same technique private._sweep_orphan_task_attachments already uses).

create or replace function public.members_lock_identity()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'members.id is immutable' using errcode = '42501';
  end if;
  if new.email is distinct from old.email then
    raise exception 'members.email is immutable (identity is owned by auth.users)' using errcode = '42501';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'members.created_at is immutable' using errcode = '42501';
  end if;
  if new.role is distinct from old.role then
    raise exception 'members.role cannot be changed here (workspace authority lives in workspace_members.role; use public.set_member_role)' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.members_lock_identity() from public, anon, authenticated;

drop trigger if exists members_lock_role on public.members;
drop trigger if exists members_lock_identity on public.members;
create trigger members_lock_identity
  before update on public.members
  for each row execute function public.members_lock_identity();

-- superseded by members_lock_identity; drop the orphan rather than leave it behind
drop function if exists public.members_lock_role();

-- Least privilege: display_name is the ONLY column a user may ever SET on their own profile row.
-- A future profile UI that adds columns (e.g. avatar_url) must extend this grant deliberately.
revoke update on public.members from authenticated;
grant update (display_name) on public.members to authenticated;
