-- Scale pass — composite indexes for the hot workspace-scoped list queries.
--
-- Every workspace-scoped list is `WHERE workspace_id = ? ORDER BY <col> [DESC] [LIMIT n]`, but the only
-- indexes were single-column `(workspace_id)` — serving the equality but not the ordering, so the planner
-- scanned the whole workspace's rows then Sort'd. A composite `(workspace_id, <order col> DESC)` returns the
-- rows already ordered (no Sort node; LIMIT can stop early), and its leading column fully covers the
-- equality + FK-cover role of the single-column `(workspace_id)` index it replaces (mirrors the existing
-- notifications_recipient_created_idx (recipient_id, created_at DESC)).
--
-- PROVEN before/after at volume on a rolled-back throwaway workspace (500 tasks / 5000 messages / 1000
-- dm_messages), 2026-07-13, with EXPLAIN (ANALYZE, BUFFERS):
--   * tasks:       Seq Scan + Sort (quicksort 154kB)        -> Index Scan using tasks_ws_order_idx (Sort eliminated)
--   * messages:    Index Scan Backward on messages_created_at_idx (cross-tenant global) -> Index Scan using
--                  messages_ws_created_idx (Index Cond on workspace_id; equality+range both in the index cond)
--   * dm_messages: Seq Scan + Sort (quicksort 270kB)        -> Index Scan using dm_messages_ws_created_idx (Sort eliminated)
--   Performance + security advisors clean afterward (composites used, not flagged unused/duplicate; the
--   dropped indexes gone; only the accepted auth_leaked_password_protection WARN remains). Isolation/role
--   regression 11/11 (RLS still enabled; cross-tenant + guest gating intact — index-only change is
--   behavior-preserving by construction). Throwaway data deleted; per-table row counts restored byte-for-byte.
--
-- Idempotent (IF NOT EXISTS / IF EXISTS). Plain CREATE INDEX (not CONCURRENTLY) so it runs inside the
-- migration transaction; sub-second at current volume.

create index if not exists messages_ws_created_idx    on public.messages    (workspace_id, created_at desc);
create index if not exists tasks_ws_order_idx         on public.tasks       (workspace_id, task_order desc);
create index if not exists dm_messages_ws_created_idx on public.dm_messages (workspace_id, created_at desc);

-- messages_created_at_idx is DEAD/harmful: no query orders by created_at WITHOUT workspace_id (every
-- messages query is `.eq('workspace_id',…)`), so the global single-column index only enabled a cross-tenant
-- scan. Superseded outright by messages_ws_created_idx.
drop index if exists public.messages_created_at_idx;

-- The single-column (workspace_id) indexes are the leading-column prefix of the new composites, which serve
-- every equality/FK-cover use they had. Redundant write-amplifiers once the composites exist.
drop index if exists public.messages_workspace_id_idx;
drop index if exists public.tasks_workspace_id_idx;
drop index if exists public.dm_messages_workspace_id_idx;
