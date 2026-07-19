-- ============================================================================================
-- team-chat read cursor (`chat_reads`) + per-member read receipts
--
-- WHY
--   DMs have read receipts ("Seen") built on `dm_reads`; team chat had NOTHING server-side — its
--   unread state was a single localStorage key per workspace (`cc_chat_last_seen:<wsId>`), which is
--   per-device, lost on a wipe, and invisible to other members. This adds the missing peer-visible
--   cursor so team chat can render each member's avatar under the last message they have read.
--
-- SHAPE — deliberately mirrors `dm_reads` (20260604125857:58-63) rather than inventing a new one:
--   (scope_id, user_id) PK -> last_read_at, a `user_id` covering index, split RLS (broad SELECT so
--   receipts are visible / self-only INSERT+UPDATE), no DELETE, and a clamp-don't-raise monotonic
--   trigger. Scope here is `workspace_id` (team chat is one channel per workspace) instead of
--   `conversation_id`. It then closes two holes dm_reads left open (fixed for DMs in the companion
--   migration dm_reads_identity_lock_and_future_cap).
--
-- GUESTS — the load-bearing difference from dm_reads. Guests are excluded from team chat entirely
--   (`messages_select_member`: is_workspace_member AND workspace_role <> 'guest'), so a guest must
--   never appear in a receipt row. Two independent layers:
--     (1) the INSERT/UPDATE policies re-state the guest exclusion, so a guest can never WRITE a row;
--     (2) the SELECT policy ALSO evaluates the ROW OWNER's current visibility, so a member who is
--         later DEMOTED to guest stops appearing even though their row still exists. Layer (2) is
--         not redundant — demotion is exactly the case layer (1) cannot reach.
--
-- INTEGRITY — a read receipt is a claim ABOUT a person that everyone else can see, so the cursor has
--   to be non-repudiable in both directions. Two triggers, because RLS structurally cannot do it:
--   a WITH CHECK only ever sees the NEW row, so it can express neither "identity unchanged" nor
--   "not earlier than before". This is the members_lock_identity situation exactly (20260715142400).
--     * BACKWARD  — `chat_reads_clamp_cursor` clamps a regressing UPDATE up to the stored value.
--     * SIDEWAYS  — `chat_reads_lock_identity` makes (workspace_id, user_id) immutable. Without it
--       the monotonic rule is BYPASSABLE with no DELETE at all: a member of two workspaces could
--       UPDATE their row A -> B (the clamp compares OLD/NEW of the same row, so nothing fires),
--       vacating A's primary-key slot, then INSERT a fresh A row at any past timestamp — a genesis
--       insert has no OLD row and so cannot be clamped. (Proof assertion 2 demonstrates this live.)
--     * FORWARD   — the same clamp caps `last_read_at` at now(). Otherwise a client could genesis at
--       now() + 100 years, after which monotonicity makes the row permanently unmovable and they
--       appear to have read every future message forever.
--
--   NB the identity lock is a TRIGGER and not a column grant, and that choice is load-bearing.
--   `grant update (last_read_at)` looks tighter and does block the vacate — but PostgREST compiles
--   `.upsert()` to `ON CONFLICT DO UPDATE SET <every payload column>`, including the conflict-target
--   columns, and Postgres checks UPDATE privilege at executor startup whether or not a conflict
--   occurs. A column grant would therefore 42501 the app's own write path on every call, including
--   the genesis insert.
--
-- NOT DOING (deliberate):
--   * No realtime publication entry. `dm_reads` is not published either; the DM UI polls its peer
--     cursor every 4s + on focus/visibilitychange, and team chat reuses that proven pattern.
--
-- PROVEN: 26/26 rolled-back assertions, including two RED phases (feature absent; the vacate bypass
--   genuinely regresses the cursor without the identity lock).
--   See supabase/tests/chat_reads_team_chat_read_cursor_rolled_back_proof.sql.
-- ============================================================================================

-- ------------------------------------------------------------------ 1. table
create table if not exists public.chat_reads (
  workspace_id uuid        not null references public.workspaces(id) on delete cascade,
  user_id      uuid        not null references auth.users(id)        on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- The PK covers (workspace_id, ...) but leaves the user_id FK unindexed, which trips the
-- `unindexed_foreign_keys` advisor. Same fix, same reason, as dm_reads_user_id_idx
-- (20260604130054:7) and the dm_message_hides indexes (20260716000040:22-23).
create index if not exists chat_reads_user_id_idx on public.chat_reads(user_id);

-- ------------------------------------------------------------------ 2. visibility helper
-- Whether the CALLER may see one receipt row. Anchored on auth.uid() in its FIRST clause, which is
-- what makes it safe to grant: a caller who cannot see the channel gets false no matter what
-- p_row_user is, so this is NOT a cross-tenant membership oracle. (This is also why the existing
-- private.can_see_team_chat(p_user, p_ws) is NOT simply granted to authenticated — with two free
-- arguments it would let anyone probe whether an arbitrary user belongs to an arbitrary workspace.)
-- Delegates to can_see_team_chat rather than restating the guest rule, so the receipt surface can
-- never drift from the message surface it describes.
create or replace function private.can_see_chat_receipt(p_ws uuid, p_row_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_see_team_chat((select auth.uid()), p_ws)   -- I can see this channel
     and private.can_see_team_chat(p_row_user, p_ws);           -- and so can the row's owner
$$;
revoke all     on function private.can_see_chat_receipt(uuid, uuid) from public, anon;
grant  execute on function private.can_see_chat_receipt(uuid, uuid) to authenticated;

-- ------------------------------------------------------------------ 3. RLS
alter table public.chat_reads enable row level security;

-- SELECT is deliberately BROAD (every participant's cursor, not just mine) — that asymmetry against
-- the self-only writes is what makes read receipts possible at all, and mirrors
-- dm_reads_select_participant.
drop policy if exists chat_reads_select_participant on public.chat_reads;
create policy chat_reads_select_participant on public.chat_reads for select to authenticated
using ( private.can_see_chat_receipt(workspace_id, user_id) );

-- INSERT/UPDATE: only ever MY OWN row, and only while I can see the channel. The predicate is the
-- inline caller-scoped form of messages_select_member (both helpers are already granted to
-- authenticated) — a guest fails the second clause and can never create or advance a cursor.
drop policy if exists chat_reads_insert_own on public.chat_reads;
create policy chat_reads_insert_own on public.chat_reads for insert to authenticated
with check ( user_id = (select auth.uid())
             and private.is_workspace_member(workspace_id)
             and private.workspace_role(workspace_id) <> 'guest' );

drop policy if exists chat_reads_update_own on public.chat_reads;
create policy chat_reads_update_own on public.chat_reads for update to authenticated
using      ( user_id = (select auth.uid())
             and private.is_workspace_member(workspace_id)
             and private.workspace_role(workspace_id) <> 'guest' )
with check ( user_id = (select auth.uid())
             and private.is_workspace_member(workspace_id)
             and private.workspace_role(workspace_id) <> 'guest' );

-- Least-privilege and explicit, per the house convention. REVOKE FROM `authenticated` TOO: Supabase
-- default-grants ALL on a new public table to anon AND authenticated, and revoking from PUBLIC does
-- not remove a privilege granted to a named role — so omitting it would silently leave DELETE in
-- place. Same three-role revoke as 20260716000040:88.
-- NO DELETE: there is no reason to retract a read cursor, and with the identity lock above it also
-- means an occupied PK slot can never be vacated and re-genesised at an earlier timestamp.
revoke all on public.chat_reads from public, anon, authenticated;
grant select, insert, update on public.chat_reads to authenticated;

-- ------------------------------------------------------------------ 4. integrity triggers
-- (a) IDENTITY LOCK — see INTEGRITY in the header. Raises rather than clamps: unlike an out-of-order
-- timestamp, a client trying to move its row to another workspace is never a benign race.
create or replace function public.chat_reads_lock_identity()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.user_id is distinct from old.user_id then
    raise exception 'chat_reads identity is immutable (workspace_id, user_id)' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.chat_reads_lock_identity() from public, anon, authenticated;

drop trigger if exists chat_reads_lock_identity on public.chat_reads;
create trigger chat_reads_lock_identity
  before update on public.chat_reads
  for each row execute function public.chat_reads_lock_identity();

-- (b) CURSOR CLAMP — monotonic, and never in the future. CLAMP rather than raise for the backward
-- case (exactly public.dm_reads_monotonic_cursor, 20260715235959:29-48): a late-arriving or
-- out-of-order client write is a benign race, not an error the UI should have to handle — silently
-- keeping the newer value is correct and keeps the caller's optimistic update valid.
-- BEFORE INSERT *OR* UPDATE: the future-cap must also cover the genesis insert (that is the only
-- moment an unbounded value could get in), while the backward clamp is UPDATE-only because a genesis
-- insert has no OLD row to compare against.
-- This also covers the real client write path: PostgREST `.upsert()` emits
-- `INSERT ... ON CONFLICT DO UPDATE`, and BEFORE UPDATE fires on that action.
create or replace function public.chat_reads_clamp_cursor()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if new.last_read_at > now() then
    new.last_read_at := now();
  end if;
  if tg_op = 'UPDATE' and new.last_read_at < old.last_read_at then
    new.last_read_at := old.last_read_at;
  end if;
  return new;
end;
$fn$;
revoke all on function public.chat_reads_clamp_cursor() from public, anon, authenticated;

drop trigger if exists chat_reads_clamp on public.chat_reads;
create trigger chat_reads_clamp
  before insert or update on public.chat_reads
  for each row execute function public.chat_reads_clamp_cursor();
