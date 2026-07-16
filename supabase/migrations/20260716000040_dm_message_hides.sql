-- "Delete for me" for direct messages. A hide is PERSONAL, per-message, per-user state that lives
-- entirely OUTSIDE dm_messages -> enforce_message_edit_window is never entered (so NO 10-minute
-- limit -- that window only ever gated delete-for-everyone), it works on a tombstone, and it never
-- touches the shared voice-note blob (a personal hide must not delete the peer's audio).
--
-- REQUIRES 20260715235959_dm_reads_monotonic_cursor to be applied FIRST: without it, hiding the
-- newest message walks the read cursor backward and the peer's "Seen" flips = a peer-observable
-- hide oracle.

-- ------------------------------------------------------------------ 1. table
create table if not exists public.dm_message_hides (
  message_id      uuid not null references public.dm_messages(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  -- Denormalised from the parent message and stamped by the BEFORE INSERT trigger below; the
  -- client cannot spoof it. Present so the INSERT/DELETE participant gate is one STABLE call on a
  -- local column rather than a nested RLS-filtered lookup into dm_messages per candidate row.
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- PK (message_id,user_id) is exactly the probe the NOT EXISTS filter needs. These two keep the
-- unindexed_foreign_keys advisor clean (precedent: 20260604130054).
create index if not exists dm_message_hides_conv_idx on public.dm_message_hides (conversation_id);
create index if not exists dm_message_hides_user_idx on public.dm_message_hides (user_id);

-- ------------------------------------------------------------------ 2. stamping trigger
--    Mirrors public.dm_set_workspace_id() / set_attachment_workspace_id exactly.
create or replace function public.dm_hide_set_conversation_id()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  select m.conversation_id into new.conversation_id
    from public.dm_messages m where m.id = new.message_id;
  return new;
end;
$fn$;
revoke all on function public.dm_hide_set_conversation_id() from public, anon, authenticated;

drop trigger if exists dm_message_hides_set_conversation_id on public.dm_message_hides;
create trigger dm_message_hides_set_conversation_id
  before insert on public.dm_message_hides
  for each row execute function public.dm_hide_set_conversation_id();

-- ------------------------------------------------------------------ 3. RLS
alter table public.dm_message_hides enable row level security;

-- SELECT is pinned to user_id = auth.uid() and NOTHING ELSE. Two deliberate decisions:
--
--   (a) This does NOT copy dm_reads_select_participant, whose qual is bare
--       private.is_dm_participant(conversation_id) with no user_id clause. That policy is
--       read-peer-inclusive BY DESIGN (it is how read receipts work: api.js reads() returns BOTH
--       rows and the UI picks the peer's out). Cloned here it would let the peer enumerate exactly
--       which of their messages you hid -- destroying the entire point of the feature.
--       The exemplar is workspace_members_select_self.
--
--   (b) The participant clause is deliberately ABSENT from SELECT (it stays on INSERT/DELETE).
--       The hide-filter subquery inside the INVOKER RPCs below is itself RLS-filtered, so an
--       `and is_dm_participant(...)` here would FAIL OPEN: were participation ever to go false the
--       hide row would vanish and THE HIDDEN MESSAGE WOULD REAPPEAR. For a privacy filter that is
--       the wrong failure direction. It also costs a STABLE call per candidate row for zero
--       benefit -- the row's user_id is already the caller's.
drop policy if exists dm_message_hides_select_own on public.dm_message_hides;
create policy dm_message_hides_select_own on public.dm_message_hides
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists dm_message_hides_insert_own on public.dm_message_hides;
create policy dm_message_hides_insert_own on public.dm_message_hides
  for insert to authenticated
  with check ((user_id = (select auth.uid())) and private.is_dm_participant(conversation_id));

-- DELETE = unhide.
drop policy if exists dm_message_hides_delete_own on public.dm_message_hides;
create policy dm_message_hides_delete_own on public.dm_message_hides
  for delete to authenticated
  using ((user_id = (select auth.uid())) and private.is_dm_participant(conversation_id));

-- ------------------------------------------------------------------ 4. grants
-- Least-privilege, explicit. NO UPDATE (a hide is an immutable fact: create it or destroy it),
-- mirroring task_attachments. Because UPDATE has neither grant nor policy the update path does not
-- exist, so no BEFORE UPDATE lock trigger is needed (unlike members_lock_identity, which exists
-- precisely because members DOES carry an UPDATE(display_name) grant). The GRANT is load-bearing:
-- with UPDATE granted, RLS alone fails SILENTLY with rows=0 instead of 42501.
revoke all on public.dm_message_hides from public, anon, authenticated;
grant select, insert, delete on public.dm_message_hides to authenticated;

-- ------------------------------------------------------------------ 5. hide-filtered reads
-- SECURITY INVOKER (the default -- no keyword, exactly like public.search_messages) so dm_messages
-- RLS still gates every row. The house "public INVOKER -> private DEFINER" shape exists to
-- ESCALATE (create_workspace writes; project_task_count reads past RLS blind spots). These need
-- LESS privilege, not more: made DEFINER, an outsider could read an entire conversation.
-- The NOT EXISTS sits INSIDE the query, before the LIMIT, so keyset pagination stays exact --
-- client-side filtering would return short pages.
create or replace function public.dm_thread_messages(
  p_conversation_id uuid,
  p_before timestamptz default null,
  p_limit integer default 200)
returns setof public.dm_messages
language sql
stable
set search_path to ''
as $fn$
  select m.* from public.dm_messages m
   where m.conversation_id = p_conversation_id
     and (p_before is null or m.created_at < p_before)
     and not exists (select 1 from public.dm_message_hides h
                      where h.message_id = m.id and h.user_id = (select auth.uid()))
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);   -- greatest(): a negative p_limit raises 2201W
$fn$;
revoke all on function public.dm_thread_messages(uuid, timestamptz, integer) from public, anon;
grant execute on function public.dm_thread_messages(uuid, timestamptz, integer) to authenticated;

create or replace function public.dm_recent_messages(p_ws uuid, p_limit integer default 500)
returns setof public.dm_messages
language sql
stable
set search_path to ''
as $fn$
  select m.* from public.dm_messages m
   where m.workspace_id = p_ws
     and not exists (select 1 from public.dm_message_hides h
                      where h.message_id = m.id and h.user_id = (select auth.uid()))
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 500), 1), 1000);
$fn$;
revoke all on function public.dm_recent_messages(uuid, integer) from public, anon;
grant execute on function public.dm_recent_messages(uuid, integer) to authenticated;

-- ------------------------------------------------------------------ 6. unread counts
-- This body is SECURITY DEFINER, so it BYPASSES RLS and the hides table's user_id = auth.uid()
-- policy DOES NOT APPLY INSIDE IT. The pin below must be written BY HAND.
-- WITHOUT the pin (hides filter added, `and h.user_id = auth.uid()` forgotten) a sender hiding
-- their OWN message would silently decrement the RECIPIENT's badge -- a real cross-user side
-- channel. THERE IS NO STRUCTURAL GUARD ON THIS -- only this comment and the proof's assertions.
-- Verbatim reproduction of the live 20260712163514 body + the one pinned NOT EXISTS.
-- (Bare auth.uid(), not (select auth.uid()) -- matching the live body; the initplan advisor targets
--  POLICIES, and this function uses the bare form throughout.)
create or replace function private._dm_unread_counts(p_ws uuid)
returns table(conversation_id uuid, unread bigint)
language sql
stable
security definer
set search_path to ''
as $fn$
  select c.id,
    (select count(*) from public.dm_messages m
       where m.conversation_id = c.id
         and m.sender_id is distinct from auth.uid()
         and m.deleted_at is null
         and not exists (select 1 from public.dm_message_hides h
                          where h.message_id = m.id and h.user_id = auth.uid())   -- PIN: DEFINER bypasses RLS
         and m.created_at > coalesce((select r.last_read_at from public.dm_reads r
                                        where r.conversation_id = c.id and r.user_id = auth.uid()), 'epoch'::timestamptz))::bigint
  from public.dm_conversations c
  where c.workspace_id = p_ws
    and auth.uid() in (c.user_lo, c.user_hi);
$fn$;
-- public.dm_unread_counts(p_workspace_id) (the INVOKER passthrough) is unchanged.

-- NOT added to supabase_realtime (deliberate): a hide is personal state; the hider's own client
-- applies it optimistically, and broadcasting hide rows would be the very leak this design exists
-- to prevent.
