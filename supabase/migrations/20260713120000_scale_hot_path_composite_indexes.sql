-- ============================================================================================
-- Scale pass — composite indexes for the hot workspace-scoped list queries.
--
-- STATUS: AUTHORED FROM STATIC ANALYSIS, **NOT YET APPLIED / NOT YET PROVEN**.
-- This file was written without live-DB access (no Supabase MCP / no CLI token in the authoring
-- session). Before it lands it MUST complete the project's standard DB discipline:
--   recon (list_migrations for the real ledger version) -> rolled-back EXPLAIN (ANALYZE) proof at
--   volume (before/after Sort-node + timing) -> apply_migration -> run the perf advisors (they should
--   independently confirm the dropped indexes are duplicate/unused) -> isolation/roles/storage
--   regression -> then commit the file under the ledger-assigned version.
-- The filename version (20260713120000) is a placeholder for 2026-07-13; RENAME it to whatever
-- apply_migration assigns on the remote ledger (apply_migration does not write the file).
--
-- WHY: every workspace-scoped list is `WHERE workspace_id = ? ORDER BY <col> [DESC] [LIMIT n]`, but
-- the only indexes are single-column `(workspace_id)`. That serves the equality but not the ordering,
-- so the planner does an index/heap scan of the WHOLE workspace's rows followed by a Sort. At 5,000+
-- messages / 500+ tasks / 1,000+ DM rows per workspace that Sort is the cost. A composite
-- `(workspace_id, <order col> DESC)` returns the rows already ordered — no Sort node, and LIMIT can
-- stop early. Each new composite's leading column also fully covers the equality + FK-cover role of
-- the single-column `(workspace_id)` index it replaces, so those become prefix-redundant and are
-- dropped (mirrors the existing `notifications_recipient_created_idx (recipient_id, created_at DESC)`).
--
-- Idempotent (IF NOT EXISTS / IF EXISTS). Plain CREATE INDEX (NOT CONCURRENTLY) so it runs inside the
-- migration transaction; at current row counts the brief lock is sub-second. If a target table has
-- grown large before this is applied, apply the CREATE INDEX CONCURRENTLY variants out-of-band first.
-- ============================================================================================

-- 1) messages: team-chat load (ORDER BY created_at DESC LIMIT 200) + unread badge (created_at > since).
--    Highest-impact: hit on every chat open and every unread poll.
create index if not exists messages_ws_created_idx
  on public.messages (workspace_id, created_at desc);

-- 2) tasks: the board/list load (WHERE workspace_id = ? ORDER BY task_order DESC, no limit).
create index if not exists tasks_ws_order_idx
  on public.tasks (workspace_id, task_order desc);

-- 3) dm_messages: the workspace DM preview scan (newest 500 across the workspace's conversations).
--    (Per-thread reads already ride dm_messages_conv_idx (conversation_id, created_at).)
create index if not exists dm_messages_ws_created_idx
  on public.dm_messages (workspace_id, created_at desc);

-- ---- Drops: now prefix-redundant of / superseded by the composites above ----
-- messages_created_at_idx is genuinely DEAD: no query filters or orders by created_at WITHOUT
-- workspace_id (every messages query is `.eq('workspace_id', …)`), so the global single-column index
-- only enabled an anti-pattern cross-tenant scan. Superseded outright by messages_ws_created_idx.
drop index if exists public.messages_created_at_idx;

-- The single-column (workspace_id) indexes are the leading-column prefix of the new composites, which
-- serve every equality/FK-cover use they had. Redundant write-amplifiers once the composites exist.
drop index if exists public.messages_workspace_id_idx;
drop index if exists public.tasks_workspace_id_idx;
drop index if exists public.dm_messages_workspace_id_idx;
