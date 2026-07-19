-- ============================================================================================
-- PROPOSED — "Delete for me" for TEAM CHAT (`public.message_hides`)
-- STATUS: NOT APPLIED. Awaits owner approval + a live rolled-back proof run via the Supabase MCP.
--         See PROPOSED_message_hides_team_chat_rolled_back_proof.sql.
-- When approved: apply via apply_migration, then move this file to
--         supabase/migrations/<version-from-list_migrations>_message_hides_team_chat.sql
--         and the proof to supabase/tests/.
--
-- WHY: `dm_message_hides` (20260716000040) gave DMs a two-tier delete — "delete for everyone"
-- (soft-delete, 10-minute window) and "delete for me" (personal hide, no time limit, works on
-- someone else's message and on a tombstone). Team chat has only tier 1. This is the team-chat
-- twin, so the two surfaces behave IDENTICALLY: same menu, same two tiers, tombstone hideable
-- with no time limit.
--
-- STRUCTURAL MIRROR of 20260716000040, decision for decision. Every non-obvious choice there was
-- load-bearing and is reproduced here with the substitution:
--     dm_messages          -> messages
--     conversation_id      -> workspace_id
--     is_dm_participant()  -> is_workspace_member() AND workspace_role() <> 'guest'
--
-- The gate substitution is the team-chat visibility predicate from `messages_select_member`
-- (20260626103433:73-78). GUESTS ARE THEREFORE EXCLUDED BY CONSTRUCTION: a guest cannot see team
-- chat at all, so the INSERT/DELETE gate fails for them and they can never create a hide. Nothing
-- guest-specific is restated — the hide surface delegates to the message surface, so the two can
-- never drift.
--
-- ORDERING DEPENDENCY (mirrors 20260716000040:5-8): hiding the NEWEST message shrinks the client's
-- list, which walks its read cursor backward. In DMs that would have flipped the peer's "Seen" —
-- a peer-observable hide oracle — which is why the monotonic cursor had to land first. Team chat's
-- cursor is currently localStorage (`cc_chat_last_seen`), per-device and not peer-visible, so there
-- is no oracle today. But the PROPOSED `chat_reads` read-receipt table makes team-chat cursors
-- peer-visible too. **If chat_reads is applied, it must carry its monotonic clamp (it does) and
-- should be applied BEFORE or WITH this migration.**
--
-- NEVER REVEALS THAT A HIDE HAPPENED — the requirement, and how each layer serves it:
--   * SELECT is pinned to `user_id = auth.uid()` and nothing else, so nobody can enumerate what
--     anyone else hid. (NOT the peer-inclusive shape of dm_reads_select_participant.)
--   * The workspace clause is deliberately ABSENT from SELECT. Adding it would FAIL OPEN: if
--     membership ever went false the hide row would vanish and the hidden message would REAPPEAR.
--     For a privacy filter that is the wrong failure direction.
--   * Not added to supabase_realtime — broadcasting hide rows is the very leak this prevents.
--   * The filtering RPCs are SECURITY INVOKER, so they cannot leak rows past `messages` RLS, and
--     each filters on the CALLER's own hides only.
--   * No sender-visible side effect: a hide writes nothing to `messages`, so no realtime UPDATE
--     fires and `enforce_message_edit_window` is never entered.
--
-- ⚠ DB ONLY — UI NOT WIRED BY THIS FILE. Applying this migration alone leaves the feature 100%
--   unreachable: nothing in the app can insert a `message_hides` row, and two of the three read
--   surfaces still query the table directly. That is exactly how dm_message_hides shipped — proven,
--   applied, and never called by a single line of application code. The client work is a REQUIRED
--   companion, in the same piece of work:
--     * NEW  `messages.hide(messageId)` — the writer. MUST use `ignoreDuplicates: true`
--            (ON CONFLICT DO NOTHING); a merge-duplicates upsert needs an UPDATE privilege this
--            table deliberately withholds and would 42501 on every call, including the first.
--     * REWIRE `messages.list` / `messages.listBefore` -> `chat_thread_messages` via the existing
--            `hideAwareRead` helper. The RPC returns DESC, so both callers keep their `.reverse()`.
--            Make them THROW on a falsy workspaceId rather than silently return [] — today they omit
--            the workspace filter entirely in that case, whereas the RPC would match zero rows.
--     * REWIRE `messages.unreadCount` -> `chat_unread_count`.
--     * `messages.search` already routes through `search_messages`, so it needs no client change.
--     * ChatView's failure reconcilers (VisualTaskCommandCenter.jsx ~:5661, ~:5668) re-read via
--            `messages.list`; once that is hide-aware they stop resurrecting hidden messages.
--     * A hide fires no realtime event, so the hiding client must refresh its own unread badge.
--
-- ⚠ TWO DELIBERATE BEHAVIOUR CHANGES in `chat_unread_count` vs the client's current head-count.
--   Both mirror `_dm_unread_counts` and both are corrections, but they will move the badge on
--   cutover, so they are stated rather than discovered:
--     1. `messages.sender_id` is NULLABLE (`on delete set null`). The client's `.neq('sender_id', me)`
--        DROPS null-sender rows, so a departed member's messages never counted. `is distinct from`
--        COUNTS them. A former colleague's unread messages start appearing in the badge.
--     2. The client counts tombstones; this excludes `deleted_at is not null`. Deleted messages stop
--        inflating the badge.
--
-- ⚠ ACCEPTED LOCKOUT: the DELETE (unhide) policy carries the same guest gate as INSERT, so a member
--   who hides and is then DEMOTED to guest cannot unhide. Harmless — a guest cannot see team chat at
--   all, so the message is invisible to them either way — and re-promotion restores it. Dropping the
--   gate from DELETE would be the wrong failure direction, for the same reason the workspace clause
--   is kept off SELECT. Asserted in the proof so it is a decision on record, not an accident.
-- ============================================================================================

-- ------------------------------------------------------------------ 1. table
create table if not exists public.message_hides (
  message_id   uuid not null references public.messages(id)   on delete cascade,
  user_id      uuid not null references auth.users(id)        on delete cascade,
  -- Denormalised from the parent message and stamped by the BEFORE INSERT trigger below; the client
  -- cannot spoof it. Present so the INSERT/DELETE gate is one STABLE call on a local column rather
  -- than a nested RLS-filtered lookup into messages per candidate row.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- PK (message_id,user_id) is exactly the probe the NOT EXISTS filter needs. These two keep the
-- unindexed_foreign_keys advisor clean (precedent: 20260604130054, 20260716000040:22-23).
create index if not exists message_hides_ws_idx   on public.message_hides (workspace_id);
create index if not exists message_hides_user_idx on public.message_hides (user_id);

-- ------------------------------------------------------------------ 2. stamping trigger
--    Mirrors public.dm_hide_set_conversation_id() / set_attachment_workspace_id exactly.
create or replace function public.message_hide_set_workspace_id()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  select m.workspace_id into new.workspace_id
    from public.messages m where m.id = new.message_id;
  -- Raise 42501 explicitly when the message does not exist, rather than leaving workspace_id NULL
  -- and letting the outcome depend on whether the executor evaluates the NOT NULL constraint (23502)
  -- or the RLS WITH CHECK (42501) first. That ordering is a PostgreSQL implementation detail, and if
  -- 23502 won it would be DISTINGUISHABLE from the 42501 a real-but-foreign message returns — a
  -- cross-tenant message-EXISTENCE oracle for any UUID an attacker holds. Same code, same message,
  -- either way. (dm_message_hides has the un-pinned shape; this is strictly tighter.)
  if new.workspace_id is null then
    raise exception 'permission denied for message_hides' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.message_hide_set_workspace_id() from public, anon, authenticated;

drop trigger if exists message_hides_set_workspace_id on public.message_hides;
create trigger message_hides_set_workspace_id
  before insert on public.message_hides
  for each row execute function public.message_hide_set_workspace_id();

-- ------------------------------------------------------------------ 3. RLS
alter table public.message_hides enable row level security;

-- SELECT pinned to the caller's own rows and NOTHING ELSE — see "NEVER REVEALS" in the header.
drop policy if exists message_hides_select_own on public.message_hides;
create policy message_hides_select_own on public.message_hides
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists message_hides_insert_own on public.message_hides;
create policy message_hides_insert_own on public.message_hides
  for insert to authenticated
  with check ((user_id = (select auth.uid()))
              and private.is_workspace_member(workspace_id)
              and private.workspace_role(workspace_id) <> 'guest');

-- DELETE = unhide.
drop policy if exists message_hides_delete_own on public.message_hides;
create policy message_hides_delete_own on public.message_hides
  for delete to authenticated
  using ((user_id = (select auth.uid()))
         and private.is_workspace_member(workspace_id)
         and private.workspace_role(workspace_id) <> 'guest');

-- Least-privilege, explicit. NO UPDATE (a hide is an immutable fact: create it or destroy it),
-- mirroring dm_message_hides and task_attachments. Because UPDATE has neither grant nor policy the
-- update path does not exist, so no BEFORE UPDATE lock trigger is needed. The GRANT is load-bearing:
-- with UPDATE granted, RLS alone fails SILENTLY with rows=0 instead of 42501 — and the client must
-- therefore use ignoreDuplicates (ON CONFLICT DO NOTHING), never a merge-duplicates upsert.
revoke all on public.message_hides from public, anon, authenticated;
grant select, insert, delete on public.message_hides to authenticated;

-- ------------------------------------------------------------------ 4. hide-filtering read RPCs
-- SECURITY INVOKER (matching public.search_messages and the dm_* hide RPCs) so `messages` RLS still
-- gates every row. The house "public INVOKER -> private DEFINER" shape exists to ESCALATE; these
-- need LESS privilege, not more — made DEFINER, an outsider could read the whole channel.
-- The NOT EXISTS sits INSIDE the query, before the LIMIT, so keyset pagination stays exact;
-- client-side filtering would return short pages.

-- Replaces BOTH messages.list and messages.listBefore (p_before null => newest page).
create or replace function public.chat_thread_messages(
  p_ws uuid,
  p_before timestamptz default null,
  p_limit integer default 200)
returns setof public.messages
language sql
stable
set search_path to ''
as $fn$
  select m.* from public.messages m
   where m.workspace_id = p_ws
     and (p_before is null or m.created_at < p_before)
     and not exists (select 1 from public.message_hides h
                      where h.message_id = m.id and h.user_id = (select auth.uid()))
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 200), 1), 500);   -- greatest(): a negative p_limit raises 2201W
$fn$;
revoke all     on function public.chat_thread_messages(uuid, timestamptz, integer) from public, anon;
grant  execute on function public.chat_thread_messages(uuid, timestamptz, integer) to authenticated;

-- Replaces the client's head-count unreadCount(). Team chat has no server-side counterpart today
-- (unlike dm_unread_counts), so this is new rather than a re-declaration. INVOKER, so `messages` RLS
-- does the tenant/guest gating and NO hand-written auth.uid() pin is required — contrast
-- private._dm_unread_counts, which is DEFINER and therefore needs the pin written by hand
-- (20260716000040:135-142). Keeping this INVOKER is what removes that whole class of mistake here.
create or replace function public.chat_unread_count(p_ws uuid, p_since timestamptz default null)
returns bigint
language sql
stable
set search_path to ''
as $fn$
  select count(*)::bigint from public.messages m
   where m.workspace_id = p_ws
     and m.sender_id is distinct from (select auth.uid())
     and m.deleted_at is null
     and (p_since is null or m.created_at > p_since)
     and not exists (select 1 from public.message_hides h
                      where h.message_id = m.id and h.user_id = (select auth.uid()));
$fn$;
revoke all     on function public.chat_unread_count(uuid, timestamptz) from public, anon;
grant  execute on function public.chat_unread_count(uuid, timestamptz) to authenticated;

-- ------------------------------------------------------------------ 5. search must respect hides
-- CREATE OR REPLACE of the LIVE 20260713205334 body with one added NOT EXISTS. Without this the
-- command palette (VisualTaskCommandCenter.jsx:2391) returns hidden messages' bodies verbatim and
-- deep-links to them — the most direct possible defeat of the feature. Everything else about the
-- body is reproduced unchanged, including the `least(coalesce(...))` limit form.
create or replace function public.search_messages(p_ws uuid, p_q text, p_limit int default 50)
returns setof public.messages
language sql
stable
security invoker
set search_path to ''
as $fn$
  select m.* from public.messages m
   where m.workspace_id = p_ws and m.deleted_at is null
     and m.body_tsv @@ websearch_to_tsquery('english', p_q)
     and not exists (select 1 from public.message_hides h
                      where h.message_id = m.id and h.user_id = (select auth.uid()))
   order by m.created_at desc limit least(coalesce(p_limit,50),100);
$fn$;
revoke all     on function public.search_messages(uuid, text, int) from public, anon;
grant  execute on function public.search_messages(uuid, text, int) to authenticated;

-- ------------------------------------------------------------------ 6. realtime
-- NOT added to supabase_realtime (deliberate): a hide is personal state; the hider's own client
-- applies it optimistically, and broadcasting hide rows would be the very leak this design exists
-- to prevent. Consequence the CLIENT must handle (same as DMs): a hide fires no realtime event, so
-- nothing else self-heals — the hiding client refreshes its own derived state explicitly.
