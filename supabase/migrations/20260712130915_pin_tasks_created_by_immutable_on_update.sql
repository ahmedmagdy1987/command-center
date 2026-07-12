-- [V-2 follow-up] Make tasks.created_by immutable on UPDATE (2026-07-12 audit follow-up).
-- V-2 (20260712082020) pinned created_by = auth.uid() on INSERT. The UPDATE path was left as a flagged
-- residual: no app path sends created_by on update (tasks.update strips undefined fields), but authorship
-- could still be rewritten by a crafted UPDATE. The INSERT idiom (WITH CHECK created_by = auth.uid())
-- CANNOT be reused on UPDATE: WITH CHECK sees only the NEW row, so `created_by = auth.uid()` would reject
-- every legitimate NON-creator update (an admin or assignee editing a task they didn't author, where the
-- unchanged created_by is the original author, not the updater) — proven to break admin/assignee updates.
-- Instead enforce IMMUTABILITY via a BEFORE UPDATE trigger: any attempt to change created_by raises 42501.
-- Normal updates never touch created_by, so they pass unchanged for every role.
-- Proven rolled-back before apply (7/7): authorship rewrite blocked 42501 for admin AND member; normal
-- title updates succeed for owner/admin/member/guest, including assigned and own-private tasks.

create or replace function public.enforce_task_author_immutable() returns trigger
  language plpgsql security definer set search_path='' as $fn$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'task authorship (created_by) is immutable' using errcode='42501';
  end if;
  return new;
end; $fn$;
revoke execute on function public.enforce_task_author_immutable() from public, anon, authenticated;
drop trigger if exists enforce_task_author_immutable on public.tasks;
create trigger enforce_task_author_immutable before update on public.tasks
  for each row execute function public.enforce_task_author_immutable();
