-- ============================================================================================
-- PROPOSED — dm_reads: identity lock + future cap (closes live cursor repudiation)
-- STATUS: NOT APPLIED. Awaits owner approval + a live rolled-back proof run via the Supabase MCP.
--         See PROPOSED_dm_reads_identity_lock_and_future_cap_rolled_back_proof.sql.
-- When approved: apply via apply_migration, then move this file to
--         supabase/migrations/<version-from-list_migrations>_dm_reads_identity_lock_and_future_cap.sql
--         and the proof to supabase/tests/.
--
-- THIS IS A LIVE BUG, NOT A HARDENING NICETY. `20260715235959_dm_reads_monotonic_cursor.sql:20-24`
-- argues that BEFORE UPDATE alone is sufficient, on three premises:
--     * PostgREST .upsert() emits ON CONFLICT DO UPDATE, so BEFORE UPDATE fires   -- TRUE
--     * a genesis INSERT has no OLD to regress from                               -- TRUE
--     * "the row can never be destroyed and re-genesised: authenticated has NO
--        DELETE grant and NO DELETE policy on dm_reads"                           -- FALSE
--
-- The third premise only rules out DELETE. It does not rule out UPDATE moving the row OFF its
-- primary key. `dm_reads_update_own` (20260604125857:170-173) pins `user_id` in both USING and
-- WITH CHECK but says nothing about `conversation_id`, and the grant at :178 is table-wide
-- UPDATE. So, for any user with two conversations (i.e. anyone with two DM threads):
--
--     update dm_reads set conversation_id = <other> where conversation_id = <A> and user_id = me;
--       -- USING passes (I am a participant of A); WITH CHECK passes (I am a participant of the
--       -- target too); the clamp compares OLD/NEW of the SAME row, so it never fires. A's PK slot
--       -- is now VACANT.
--     insert into dm_reads values (<A>, me, 'epoch');
--       -- a genesis insert, nothing to clamp against.
--
-- The cursor for A has moved BACKWARD to an arbitrary past time. Because
-- `dm_reads_select_participant` is peer-inclusive by design (it is how "Seen" works), the peer's UI
-- observes the retraction: **"Seen" un-says itself.** That is exactly the repudiation the monotonic
-- trigger exists to prevent.
--
-- A SECOND, OPPOSITE HOLE: there is no upper bound. A client can genesis (or advance) its cursor to
-- now() + 100 years, after which monotonicity makes the row permanently unmovable and the user
-- appears to have read every future message in the peer's UI, forever.
--
-- FIX = two triggers, because RLS structurally cannot do either job: a WITH CHECK only ever sees the
-- NEW row, so it can express neither "identity unchanged" nor "not earlier than before". This is the
-- members_lock_identity situation exactly (20260715142400) — and per that precedent the trigger is
-- the authoritative control.
--
-- WHY A TRIGGER AND NOT A COLUMN GRANT. `grant update (last_read_at)` looks tighter and would also
-- block the vacate — but it breaks the app. PostgREST builds `ON CONFLICT DO UPDATE SET ...` from
-- the PAYLOAD KEYS, and api.js markRead (:926-939) sends all three columns, so the emitted SET list
-- includes `conversation_id = EXCLUDED.conversation_id, user_id = EXCLUDED.user_id`. Postgres checks
-- UPDATE privilege on every column in the SET list at executor startup, whether or not a conflict
-- occurs, so a column grant that excluded the PK would 42501 EVERY markRead, including the genesis
-- insert. The identity-lock trigger is compatible with that statement precisely because those two
-- assignments are no-ops for a legitimate client (EXCLUDED holds the conflict-matched values), so
-- `is distinct from` is false and the trigger passes.
--
-- THAT GUARANTEE HAS ONE PRECONDITION, so pin it: it holds because the upsert's ARBITER is the
-- PRIMARY KEY. A conflict fires iff the proposed row's (conversation_id, user_id) equals an existing
-- row's, and EXCLUDED *is* the proposed row — so on any conflict those two columns necessarily match
-- OLD, and a different conversation_id simply produces a plain INSERT with no OLD at all. If a
-- future caller ever passes a different `onConflict` (some other unique index), EXCLUDED's PK could
-- legitimately differ from OLD's and markRead would begin failing 42501. Keep the arbiter on the PK.
--
-- ONE MORE INTERACTION, in the fix's favour: widening the clamp to BEFORE INSERT also changes what
-- EXCLUDED holds — per the PostgreSQL INSERT docs, "the effects of all per-row BEFORE INSERT
-- triggers are reflected in excluded values". So on a future-dated markRead the value is capped to
-- now() BEFORE it becomes EXCLUDED.last_read_at, and the DO UPDATE then assigns an already-capped
-- value which the BEFORE UPDATE clamp re-checks. Idempotent — but it means the INSERT-side cap is
-- load-bearing on the UPDATE path too, not only on genesis.
--
-- SCOPE: dm_reads only. Behaviour-preserving for every legitimate client path — the app's single
-- writer is markRead, which never changes a cursor's identity and never sends a future timestamp.
-- ============================================================================================

-- ------------------------------------------------------------------ 1. identity lock
-- Raises rather than clamps: unlike an out-of-order timestamp, a client trying to move its cursor
-- row to another conversation is never a benign race.
create or replace function public.dm_reads_lock_identity()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  if new.conversation_id is distinct from old.conversation_id
     or new.user_id is distinct from old.user_id then
    raise exception 'dm_reads identity is immutable (conversation_id, user_id)' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
revoke all on function public.dm_reads_lock_identity() from public, anon, authenticated;

drop trigger if exists dm_reads_lock_identity on public.dm_reads;
create trigger dm_reads_lock_identity
  before update on public.dm_reads
  for each row execute function public.dm_reads_lock_identity();

-- ------------------------------------------------------------------ 2. clamp: monotonic + future cap
-- CREATE OR REPLACE of the LIVE 20260715235959 body. The backward clamp is byte-identical in intent;
-- what is added is (a) the future cap and (b) a tg_op guard, because the trigger below now also fires
-- on INSERT and OLD is NULL there.
--
-- The future cap must cover INSERT: a genesis insert is the one moment an unbounded value can enter,
-- and after it lands monotonicity would make it permanent. The backward clamp stays UPDATE-only —
-- there is no OLD row to compare against on INSERT, which is why 20260715235959 correctly called a
-- BEFORE INSERT clamp dead code for that purpose.
--
-- Renaming note: the function keeps its name so nothing else has to be re-pointed, and the trigger
-- keeps the name `dm_reads_monotonic` for the same reason. Only its event list widens.
create or replace function public.dm_reads_monotonic_cursor()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
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
revoke all on function public.dm_reads_monotonic_cursor() from public, anon, authenticated;

drop trigger if exists dm_reads_monotonic on public.dm_reads;
create trigger dm_reads_monotonic
  before insert or update on public.dm_reads
  for each row execute function public.dm_reads_monotonic_cursor();

-- ------------------------------------------------------------------ 3. trigger ordering note
-- Postgres fires BEFORE row triggers in NAME order: `dm_reads_lock_identity` sorts before
-- `dm_reads_monotonic`, so an identity violation aborts the statement before the clamp runs. That
-- ordering is incidental, not load-bearing — either order produces the same outcome, because the
-- lock raises and the clamp only mutates NEW.
--
-- NOT CHANGED, deliberately:
--   * the table-wide UPDATE grant stays (see the header — PostgREST needs it),
--   * no DELETE grant or policy is added (there is still no reason to retract a cursor),
--   * the peer-inclusive SELECT policy is untouched (it is the read-receipt mechanism),
--   * dm_reads stays out of supabase_realtime (the DM UI polls its peer cursor).
