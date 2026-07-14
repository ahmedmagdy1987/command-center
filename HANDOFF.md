# HANDOFF — scale/perf pass (as of 2026-07-14)

> Written right before a Deep Freeze wipe. Everything below is pushed to GitHub (safe). The Supabase DB is
> in the cloud (safe). **Local code / `.env` / tools are wiped — follow [`RESTORE.md`](RESTORE.md) first.**
> Read this + [`SCALE_AUDIT.md`](SCALE_AUDIT.md) to resume instantly.

## Branch topology (nothing is merged to `main`)

| Branch | Tip | What's on it | Status |
|--------|-----|--------------|--------|
| **`main`** | `6a6e608` | production (Vercel auto-deploys from it). **Untouched — no scale work merged.** | live |
| **`perf/scale-robustness-pass`** | `c28d047` | The **6 frontend fixes** (`356bd95`: context memo, ProjectsView O(n), reconnect reconcile, DM debounce, write-failure toasts, ProjectModal minimal-patch) + the applied DB migration **files** (composite indexes, 5a CHECKs, 5b notif-unread RPC) + `SCALE_AUDIT.md`. | **verify → merge FIRST** |
| **`perf/scale-part2`** | `805cffd` | Branched from robustness-pass. Adds **A11** (notif clear-on-switch), **A17** (comment double-submit guard), **5c** (chat/DM load-older pagination), the **5b `workspace_task_stats` + 5d `search_messages` (tsvector+GIN)** migration files, and the **UI wiring** (palette search, unread badge, dashboard progress). | verify → merge AFTER part1 |

`perf/scale-part2` is the working tip and contains everything. Resume there.

## DB state (LIVE on Supabase `nqlzjuxqgajeoypyzlnv` — survives the wipe)

All applied + proven this pass (rolled-back proofs; DB restored byte-for-byte after every fixture):
- `20260713175541_scale_hot_path_composite_indexes` — before/after EXPLAIN at volume; advisors clean.
- `20260713180216_server_side_text_length_checks` — 5a; 9 CHECK constraints.
- `20260713180526_notifications_unread_count_rpc` — 5b unread; proven 3/3.
- `20260713205334_message_search_tsvector_rpc` — 5d; re-proven on the SHIPPING body_tsv+GIN shape (member exact hits, guest 0, outsider 0, soft-deleted excluded).
- `20260713205355_workspace_task_stats_rpc` — 5b stats; proven (member 11==11, guest 4==4, outsider 0).

These are **backward-compatible**: indexes are invisible; CHECKs match the client caps; the three RPCs are
**dormant until `perf/scale-part2` merges** (that's the code that calls them). Regression after applying: **42/42**
isolation+role; storage/RLS surface intact. Confirm the ledger with the Supabase MCP `list_migrations`.

## ⛔ BLOCKING: Item 4 — frontend runtime verification (pending the owner)

Neither branch is merged. `perf/scale-robustness-pass` merges to `main` (= production deploy) **only after** the
owner runs this checklist on the live app and confirms it passes (`npm run dev` → sign in):

| # | Fix | Do | Expect |
|---|-----|-----|--------|
| 1 | Context memo | DevTools "Highlight updates" → type in QuickAdd / toggle a filter | only affected bits flash, not the whole board |
| 2 | ProjectsView O(n) | Projects view; move a task between projects | counts/% correct + instant |
| 3 | Reconnect reconcile | Board → Network Offline; edit a task elsewhere; go Online + tab away/back | board refetches the missed change; pill→"live" |
| 4 | DM debounce | Send 5–6 DMs fast from another account | list re-summarize fires once ~400ms after the burst |
| 5 | Write-failure toasts | Offline → edit/delete task, delete project, toggle subtask | toast + revert (no silent failure) |
| 6 | ProjectModal minimal-patch | Edit a project; change ONLY color | only color written; name/icon untouched |

`perf/scale-part2` adds more frontend (A11/A17/5c + the RPC wiring) — verify those too before merging part2.

## Remaining open items (designed/flagged, not built)

1. **Filter-aware `workspace_task_stats`** — the current RPC is workspace-wide; the Dashboard's open/user-scoped
   counts + Matrix's filter-scoped quadrants are NOT wired (would change numbers). Add assignee/privacy/project
   filter params to wire them faithfully. (approval)
2. **DM search RPC** (`search_dm_messages`, participant-gated) — to complete CommandPalette search (team chat is
   done via `search_messages`; DM is still a client grep).
3. **Team-chat unread cursor** — `chatUnread` is a session-local counter; a real server cursor needs a new
   `chat_reads` table + a `chat_unread_count` RPC (mirror `dm_unread_counts`).
4. **Render-perf memoization** — A4 DashboardView (~20 unmemoized passes), A14 ScheduleView (O(11·n)), A15
   MyTasksView. Safe, pure refactors (same pattern already applied to Kanban/Matrix/Projects).

## Exact next steps after the wipe

1. **[`RESTORE.md`](RESTORE.md)**: toolchain → clone → git identity/TLS → `npm install` → launch `claude` from
   inside the repo (loads `.mcp.json`) → recreate `.env` → auth the Supabase MCP.
   - `.env` anon key: recover from the live bundle per RESTORE.md §5 (`sb_publishable_…` in `/assets/index-*.js`
     at <https://tasks.opscommandcenter.com>). URL = `https://nqlzjuxqgajeoypyzlnv.supabase.co`.
2. `git branch -a` → the work is on `perf/scale-part2` (tip) and `perf/scale-robustness-pass`. `git checkout perf/scale-part2`.
3. Sanity: `npm run build` (clean), `npm run lint` (**12 errors / 2 warnings** baseline).
4. **Item 4**: owner runs the checklist above → on pass, merge `perf/scale-robustness-pass` → `main` (deploys),
   then verify + merge `perf/scale-part2`.
5. Optionally pick up the remaining open items (filter-aware stats RPC + DM search need approval).

## Gates held all pass: build clean · lint 12/2 · advisors clean (only the accepted leaked-password WARN) · regression 42/42 · DB restored byte-for-byte.
