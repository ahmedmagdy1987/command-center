-- Enforce: a task's CATEGORY (owner) determines its privacy / visibility.
--   owner = 'me'          -> privacy = 'private'   (visible only to its creator)
--   owner in (va, shared) -> privacy = 'workspace' (visible to all authenticated: owner + VA)
--
-- A BEFORE trigger applies this on every INSERT/UPDATE, server-side, so a client
-- cannot create or keep a "Me" task that is workspace-visible. RLS is left UNCHANGED:
-- with this invariant the existing tasks policy predicate
--   privacy='workspace' OR (privacy='private' AND created_by = auth.uid())
-- is exactly equivalent to the desired
--   owner in ('va','shared') OR (owner='me' AND created_by = auth.uid()).
--
-- Idempotent: create-or-replace / drop-if-exists / conditional update.

create or replace function public.tasks_align_privacy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.privacy := case when new.owner = 'me' then 'private' else 'workspace' end;
  return new;
end;
$$;

drop trigger if exists tasks_align_privacy on public.tasks;
create trigger tasks_align_privacy
  before insert or update on public.tasks
  for each row execute function public.tasks_align_privacy();

-- One-time, idempotent re-alignment of existing rows (flips any owner='me' tasks that
-- were workspace-visible to 'private'; va/shared stay 'workspace').
update public.tasks
set privacy = case when owner = 'me' then 'private' else 'workspace' end
where privacy is distinct from (case when owner = 'me' then 'private' else 'workspace' end);
