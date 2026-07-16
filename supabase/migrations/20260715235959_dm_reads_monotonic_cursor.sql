-- Makes public.dm_reads.last_read_at MONOTONIC.
--
-- Stands on its own merit: it fixes a PRE-EXISTING latent bug. api.js:822-835 markRead upserts
-- last_read_at unconditionally (no greatest(), no guard) with a cover time derived from
-- VisualTaskCommandCenter.jsx:5290 latestMsg = items[items.length-1]. Anything that shrinks
-- `items` walks the cursor BACKWARD -- today, a hard-delete of the newest message does exactly
-- that, and the peer's "Seen" visibly flips back to unseen (dm_reads_select_participant is
-- peer-readable BY DESIGN -- that is how read receipts work).
--
-- It is also a HARD PREREQUISITE for dm_message_hides: without it, hiding the newest message
-- regresses the cursor and the peer's receipt flips = a peer-observable HIDE ORACLE, which would
-- defeat the entire point of the feature (a hide is supposed to be invisible to the peer).
--
-- CLAMP, do not raise. markRead legitimately re-writes a possibly-older cover time; a 42501 would
-- break the live read path. Monotonicity is the invariant, immutability is not -- so this is
-- deliberately NOT a members_lock_identity / enforce_task_author_immutable style 42501 trigger.
-- It is the enforce_message_edit_window() shape (public, DEFINER, search_path='', EXECUTE revoked,
-- touches only NEW/OLD).
--
-- BEFORE UPDATE is sufficient; a BEFORE INSERT clamp would be dead code:
--   * PostgREST .upsert() emits INSERT ... ON CONFLICT DO UPDATE; BEFORE UPDATE fires on that action.
--   * a genesis INSERT has no OLD to regress from.
--   * the row can never be destroyed and re-genesised: authenticated has NO DELETE grant and NO
--     DELETE policy on dm_reads.
--
-- Behaviour-neutral in normal operation: forward and equal writes are untouched. It only ever
-- changes cases that are already bugs. Proven: 65/65 rolled-back, 15/15 live.

create or replace function public.dm_reads_monotonic_cursor()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
begin
  if new.last_read_at < old.last_read_at then
    new.last_read_at := old.last_read_at;
  end if;
  return new;
end;
$fn$;

revoke all on function public.dm_reads_monotonic_cursor() from public, anon, authenticated;

drop trigger if exists dm_reads_monotonic on public.dm_reads;
create trigger dm_reads_monotonic
  before update on public.dm_reads
  for each row execute function public.dm_reads_monotonic_cursor();
