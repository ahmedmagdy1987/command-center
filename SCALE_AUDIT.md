# Scale & performance audit — Command Center

> **Authored 2026-07-13** on branch `perf/scale-robustness-pass`, from static analysis of
> `src/VisualTaskCommandCenter.jsx` (5,624 lines), `src/lib/api.js` (964 lines), `src/lib/sanitize.js`,
> and `supabase/migrations/`. Volume model used throughout: a single workspace with **~500 tasks, 30
> projects, 5,000 team messages, 1,000 DM messages across threads, 50 attachments, 20 members across all
> 4 roles, 500 notifications**.
>
> **The live load test (seed → EXPLAIN/timings → delete → byte-for-byte proof) and every DB-side fix below
> require the Supabase MCP, which was NOT connected when this was written** — those items are pre-designed
> with exact SQL/EXPLAIN and flagged `needs-live-DB`. Nothing here fabricates measured numbers.

## Applied since authoring (2026-07-13, live DB via MCP)

The Phase-1 **load test ran for real** on a rolled-back throwaway workspace (500 tasks / 30 projects /
5,000 messages / 1,000 DM messages / 50 attachments / 20 members across all 4 roles / 500 notifications);
every surface was measured with `EXPLAIN (ANALYZE, BUFFERS)`, then all throwaway data was deleted and the
**17 per-table row counts restored byte-for-byte** to the pre-test baseline (no real workspace touched).

- **A3 — composite hot-path indexes: APPLIED + PROVEN** (`20260713175541`). Before→after at volume: tasks &
  dm_messages drop their `Sort` node (Index Scan on the new composite); messages moves off the global
  cross-tenant `messages_created_at_idx` onto tenant-scoped `messages_ws_created_idx`. Advisors clean;
  isolation/role regression 11/11.
- **A5 — 5a server-side length CHECKs: APPLIED** (`20260713180216`) + `sanitizeTask` clamps for the import path.
- **A9 — 5b `notifications_unread_count` RPC: APPLIED + PROVEN 3/3** (`20260713180526`); frontend wiring pending.

**Still open / needs decision:** 5b dashboard-stats RPC (A10), 5c load-older pagination (A7/A8), 5d tsvector
search (A6), team-chat unread server cursor (needs a new `chat_reads` table), and the frontend render fixes
(A4/A14/A15/A16) — plus the frontend wiring for the 5b RPC. See *Run order* at the bottom.

## Thesis — the whole-workspace-array-in-memory model is the ceiling

`AppProvider` loads the workspace's **entire** task/message/DM/notification/member set into React state and
hands it to every view through **one** memoized context value. This is clean and fast at today's ~26-task
reality and holds fine at the 500-task target — but it has no ceiling. Three structural consequences:

1. **Unbounded fetches.** `tasks.list` / `projects.list` / message + DM loads are `select *` with no
   server `.limit`/`.range`. The full row set transfers on mount, on every workspace switch, and (for tasks)
   is **re-pulled in full after every single mutation**. PostgREST's default ~1000-row cap will one day
   **silently truncate** the task fetch, leaving views to render + rank a partial dataset that *looks*
   authoritative.
2. **Render amplification.** Because tasks/messages/dms/members are all deps of the single context value,
   any one mutation (own edit *or* realtime from 20 members) invalidates every `useApp()` consumer.
   Memoizing `value` (done on this branch) stops *parent* re-renders from churning the tree, but does not
   break the array-is-a-dep coupling — a task change still re-renders every task consumer.
3. **Client-side aggregation.** Unread badges, dashboard tiles/rankings, schedule day-grids, and message
   search are all computed by scanning the in-memory arrays. They are correct only while the whole array is
   resident, so they can't survive pagination without **server-side aggregation/search RPCs**.

The branch's perf pass (`356bd95`) already knocked down the worst *render* offenders (Kanban, Matrix,
ProjectsView memoized; context value memoized; DM refresh debounced; reconnect reconcile added). The audit
below is what remains, ranked, plus the four server-side workstreams (5a–5d) that lift the ceiling itself.

---

## Ranked findings (open items)

Severity = impact at the volume model. `fix?` marks whether a fix is already on this branch (see
*Verified-hardened* section). `liveDB` = needs the Supabase MCP / a migration.

### High

| # | Finding | Surface | Evidence | Behavior at volume | Recommended fix | liveDB |
|---|---------|---------|----------|--------------------|-----------------|:---:|
| A1 | **`tasks.list` is unbounded `select *`** and is re-pulled in full after every single mutation | data layer → all task views | `api.js:252` (no `.limit`/`.range`); refetched at `VTCC.jsx:377,475,563,579,655` | 500 rows (incl. subtasks JSON) held in memory, re-mapped + re-rendered on every edit; **PostgREST ~1000-row cap silently truncates** a larger workspace | Cap/paginate (active/non-done first, lazy-load `done`); on the mutation success path **apply the returned row to state** instead of a full `tasksApi.list()` reconcile | — |
| A2 | **Single whole-array context** → every `useApp()` consumer re-renders on any task/dm/notif mutation | AppProvider + all consumers | `VTCC.jsx:851-883` value+deps include `tasks,projects,members,dmConversations,...` | One task INSERT/UPDATE/DELETE re-renders the entire subtree; compounds with A4 | Split context (stable handlers vs volatile slices) or move arrays behind per-view selectors / `useSyncExternalStore`; `React.memo` leaf cards/chips | — |
| A3 | **Hot-path composite indexes authored but UNAPPLIED** | messages/tasks/dm_messages ordering | `20260713120000_...` header "NOT YET APPLIED"; today only single-col `(workspace_id)` indexes | `messages.list` (ORDER created_at DESC LIMIT 200) & `tasks.list` (ORDER task_order DESC) scan the whole workspace then **Sort**; LIMIT can't stop early | Land the migration under full discipline (**Appendix A**) — single highest-leverage server fix | ✅ |
| A4 | **DashboardView: ~20 full-array filter/sort passes, none memoized** | Dashboard (default landing) | `VTCC.jsx:3345-3367` — `open/ranked/myUpcoming/othersUpcoming/unassignedPriority/overdue/stuck/recent` + a 9-field `counts` + `progress`, all bare consts | ~20 O(n) scans + 3 sorts per render × re-renders on every context change → visible input/scroll jank | `useMemo` the buckets/counts/progress keyed on `[tasks, meId]` (mirror Kanban/Matrix) | — |
| A5 | **No server-side length CHECK behind any text cap (5a)** | tasks.title/description/blocked_reason, comments/messages/dm_messages.body, projects/members | client caps are DOM-only (`VTCC.jsx:1655,1718,1728,1429,...`); CHECK exists only for workspace name (`_create_workspace`, `_slugify`) | `maxLength` is bypassed by any direct supabase-js call (browser holds the anon key). A member can persist a multi-MB description/message; it then poisons every co-member's whole-array fetch + render | DB `CHECK` constraints mirroring the caps (**Appendix B**); client `maxLength` stays UX-only | ✅ |
| A6 | **Message search = client `.includes()` grep over only newest 200 team + 500 DM rows (5d)** | command palette search | `VTCC.jsx:2202-2203,2251`; `api.js:538,733` | At 5,000 msgs **~96% of history is unsearchable**, silently (no "results truncated"); + refetches 700 rows every palette open | tsvector + GIN + RLS-respecting search RPC (**Appendix E**) | ✅ |
| A7 | **Team chat: no pagination / load-older — history truncated to newest 200 (5c)** | team chat | `api.js:538` `list(limit=200)`; no cursor/range/load-older anywhere | 4,800 of 5,000 messages permanently unreachable in-app | Keyset (`before` created_at cursor) + "Load older" prepend; the A3 composite serves the scan (**Appendix D**) | partial |
| A8 | **DM thread: no pagination / load-older (5c)** | DM thread view | `api.js:722` `listMessages(conversationId, limit=200)`; no older-page path | A thread >200 messages opens to newest 200 only; older unreachable | Same keyset pagination for `dm_messages` (**Appendix D**) | partial |

### Medium

| # | Finding | Surface | Evidence | Behavior at volume | Recommended fix | liveDB |
|---|---------|---------|----------|--------------------|-----------------|:---:|
| A9 | **Notification unread badge counts the in-memory array (capped at 50)** | NotificationBell | `VTCC.jsx:2584` reduce over `items`; `items` from `notifications.list(50)` (`api.js:356`) | With 500 notifs / 120 unread, header "{n} new" tops out at 50 and undercounts; older unread invisible | Server unread-count RPC (**Appendix C**, mirrors `dm_unread_counts`); keep the 50-row list for the panel + add load-more | ✅ |
| A10 | **Dashboard/Matrix/Schedule rankings need the whole task array (5b)** | Dashboard/Matrix/Schedule | `VTCC.jsx:3346,3355-3367` (ranked, counts, progress) | These aggregates can't be correct under any pagination without server support — the concrete "whole-array ceiling" | `workspace_task_stats(ws)` aggregate RPC (**Appendix C**) — pairs with pagination; **needs your decision** | ✅ |
| A11 | **Workspace switch does NOT clear notifications → previous workspace's notifs leak into the new bell** | workspace switch | `VTCC.jsx:2587-2606` never `setItems([])`; merge keeps `extras=prev.filter(...)` (old ws rows survive) | After a switch the bell shows old+new merged; stale rows inflate `unreadCount` until remount. (tasks/projects/members/DMs all clear on switch; notifications don't) | `setItems([])` at the top of the load effect (or scope the merge's prev-preserve to "arrived during THIS fetch") — **real correctness bug** | — |
| A12 | **`refreshDms` pulls 500 DM rows on every debounced event + every reconnect** just to derive previews | DM summarize | `VTCC.jsx:285-292`; `api.js:733` `listRecentMessages(ws,500)` | Up to 500 rows shipped + Map-reduced per re-summarize; fires on load/startDm/debounced event/reconcile | Per-conversation last-message via `DISTINCT ON`/lateral RPC (like unread already is) instead of a 500-row window | ✅ |
| A13 | **DM previews go blank at volume** (newest-500 global window may exclude quiet threads' last msg) | DM conversation list | `VTCC.jsx:287-292,299` `lastMsg` from the 500-window; falls back to `conv.createdAt` | A quiet thread whose last message is older than the 500th-newest shows blank preview + wrong sort order | Same per-conversation last-message RPC as A12 | ✅ |
| A14 | **ScheduleView is O(11·n) + `filtered`/`undated` unmemoized** | Schedule | `VTCC.jsx:4072-4095` — 11 day-columns each `filtered.filter(...Date...).sort()` | ~11×500 ≈ 5,500 `Date` parses per recompute; `filtered` identity churns every render | Memoize `filtered`/`undated` on `[tasks,filters,meId]`; build one day-string→tasks Map in a single pass | — |
| A15 | **MyTasksView: ~7 unmemoized full-array passes** | My-Tasks | `VTCC.jsx:3768-3797` `myTasks` + `byStatus.*` + `overdue`, all bare consts | Full 500-task array re-scanned ~6-7× per render, on any context change | Single `useMemo` on `[tasks,meId]` (the branch memoized Kanban/Matrix/Projects but missed this + Dashboard + Schedule) | — |
| A16 | **No list virtualization in any task view** | Kanban/Schedule/My-Tasks/Projects/Dashboard | plain `.map`→TaskCard everywhere; 0 hits for react-window/virtual | 500 tasks in one column/day mount hundreds of card subtrees at once → mount/layout/memory cost | Windowed list (react-window) for any list that can exceed ~100 items | — |
| A17 | **Comment composer has no double-submit guard** (chat + QuickAdd do) | in-task comments | `VTCC.jsx:1352` `TaskComments.send` has no `sendingRef`; contrast Composer `:4567`, QuickAdd `:2121` | Fast double-Enter posts two identical comments + **doubles the `comment_added` notification** to participants | Add a `sendingRef` guard matching Composer/QuickAdd | — |
| A18 | **`reconcile` refetches tasks/projects/dms but not team-chat messages or notifications** | reconnect reconcile | `VTCC.jsx:468-485` (no `messagesApi.list`/`notificationsApi.list`) | Messages/notifs that arrived while the socket was down stay missing from memory until a full switch/reload — chat + bell silently drift stale | Have `reconcile` also nudge the chat/notification loaders (bump a reconcile counter they depend on) | — |
| A25 | **PostgREST ~1000-row cap silently truncates a large `tasks.list`** (data-integrity, sub-case of A1) | data layer | `api.js:252` unbounded select; default max-rows ~1000 | A >1000-task workspace renders a partial board while counts/rankings look complete — **wrong numbers, no error** | Confirm/raise `db.max_rows`, or paginate + move aggregates server-side (ties to A1/A10) | ✅ |
| A26 | **`tasks.list` re-fetched in full after every single mutation** (sub-case of A1, distinct fix) | data layer | `VTCC.jsx:563,579,655` full refetch after create/update/delete/subtask | Every edit ships 500 rows back; a busy 20-member workspace multiplies this | Apply the mutation's returned row to state; reserve full refetch for the failure-reconcile path | — |

### Low

| # | Finding | Surface | Evidence | Fix | liveDB |
|---|---------|---------|----------|-----|:---:|
| A19 | Command palette re-fetches ~700 message rows on every open; index incomplete (overlaps A6) | command palette | `VTCC.jsx:2200-2214` | Cache the index across opens (invalidate on switch) or fold into the A6 server search | — |
| A20 | No `AbortController` timeout on attachment upload / long fetches (self-flagged in code) | attachments + fetches | `VTCC.jsx:1506` comment; 0 `AbortController` hits in `api.js` | A hung upload on a half-open socket shows "Uploading…" forever; wrap with `AbortController` + timeout + retry | — |
| A21 | `tasks` realtime has no server-side filter → every task change across all the user's workspaces is pushed + JS-filtered | tasks realtime | `api.js:332-345` (`event:'*'`, no filter; REPLICA IDENTITY DEFAULT) | Accepted tradeoff for DELETE correctness; consider REPLICA IDENTITY FULL to enable a server `workspace_id` filter | ✅ |
| A22 | Workspace switch fans out ~8 uncoordinated round-trips | workspace switch | `VTCC.jsx:377,395,406,430,285-288,2591` | Acceptable at target volume; a single "workspace bootstrap" RPC would cut latency | ✅ |
| A23 | `members.list` is global (self + all shared-workspace co-members), not workspace-scoped | members profile fetch | `api.js:51` no `.eq`/`.limit` | Prefer `workspaceMembers.listForWorkspace` (RPC, `api.js:112`) for per-workspace roster | — |
| A24 | Unbounded workspace/task-scoped lists: `projects.list`, `comments.list`, `invitations.listForWorkspace`, `dm_conversations.listConversations` | data layer | `api.js:199,472,148,714` (no `.limit`) | Small at target volume; add `.limit` + cursor only if counts grow (dm_conversations worst-case O(members²)≈190) | — |

---

## Verified already-hardened on `perf/scale-robustness-pass` (do not re-fix)

Confirmed present and correct by static review of `356bd95` + the merge-base commits:

- **Context value memoized** (`VTCC.jsx:851-883`) — the callbacks it references (`exportJSON`/`importJSON`/`closeEditing`) were also converted to `useCallback` so the memo isn't defeated. *(Caveat: stops parent-churn, not the array-is-a-dep coupling — see A2.)*
- **KanbanView** filter + per-status bucket/sort memoized (`:3596-3616`).
- **MatrixView** filter + quadrant split memoized (`:3885-3898`); **ProjectsView** `filtered` + `tasksByProject` Map (O(n), not O(projects·tasks)) (`:3964-3976,4003`).
- **Reconnect reconcile** — throttled 8s, workspace-switch-race-guarded via ref, refetch-in-place on `online` + `visibilitychange` (`:467-502`).
- **DM refresh debounce** — 400ms trailing, burst-collapsing, cleanup-safe (`:450-458`).
- **DM per-conversation unread** via the `dm_unread_counts` server RPC — accurate at any volume (`api.js:743`; commit 6a6e608).
- **Write-failure toasts** on task/project/subtask update+delete (previously silent reverts).
- **Toast stack** capped to newest 3, de-duped, self-dismissing, reduced-motion-aware (`:2632,2543`).
- **Optimistic reconcile** — comments/attachments de-dupe realtime echo + reload-on-failure; QuickAdd + Composer double-submit guards (`:1359,1538,2101,4567`).
- **Attachment upload** `try/finally` guarantees the spinner clears; **ProjectModal** sends a minimal patch (concurrency-safe).
- **Input caps** (client): title 500, description 20000, blocked-reason 1000, subtask 500, message/comment/DM 10000 + break-words.
- **`messages.unreadCount`** uses `count:'exact', head:true` (no row fetch); **@-mention picker** bounded (`slice(0,8)`); **MembersView** fine at 20.

---

## Server-side workstreams (item 5) — designs

Mapping of the audit's server-gaps to your four workstreams, with exact SQL. Full SQL in the appendices.

| Workstream | Closes | Risk | Approval |
|-----------|--------|------|----------|
| **5a** length CHECK constraints | A5 | Low (additive; must confirm no existing row violates first) | Safe under standard discipline |
| **5b** aggregation RPCs — *unread counts* | A9 (+ notifications) | Low (mirrors `dm_unread_counts`) | Safe under standard discipline |
| **5b** aggregation RPCs — *dashboard/matrix/schedule stats* | A10 | Medium (architectural shift; only pays off paired with pagination) | **Needs your decision** — recommend design-now / apply-after-5c |
| **5c** load-older pagination | A7, A8 | Low (mostly frontend; rides the A3 index) | Safe under standard discipline |
| **5d** tsvector + GIN message search | A6 (guest isolation A6/5.2) | Medium (stored column + GIN + behavior change; guest-leak proof is the gate) | **Needs your approval** |

---

## Appendix A — Item 3: index migration EXPLAIN plan (run when MCP is back)

Migration `20260713120000_scale_hot_path_composite_indexes.sql` adds 3 composites, drops 4 single-col
indexes. Prove each composite earns its place with `EXPLAIN (ANALYZE, BUFFERS)` before/after at volume.

```sql
-- 1) messages (team chat) — before: Sort over N ws rows then Limit; after: Index Scan Backward
--    using messages_ws_created_idx, NO Sort, LIMIT stops early.
explain (analyze, buffers)
select * from public.messages where workspace_id = :ws order by created_at desc limit 200;

-- 2) tasks (board) — before: scan tasks_workspace_id_idx + Sort; after: Index Scan tasks_ws_order_idx, no Sort.
--    (Confirmed api.js:252 orders by task_order desc.)
explain (analyze, buffers)
select * from public.tasks where workspace_id = :ws order by task_order desc;

-- 3) dm_messages (DM preview scan) — before: Sort; after: Index Scan Backward dm_messages_ws_created_idx.
explain (analyze, buffers)
select * from public.dm_messages where workspace_id = :ws order by created_at desc limit 500;
```

**Drop justification (prove, don't assume):** `messages_created_at_idx (created_at)` is DEAD — prove
`pg_stat_user_indexes.idx_scan = 0` + perf advisor flags it unused (every messages query filters
`workspace_id`). For the single-col `(workspace_id)` indexes on messages/tasks/dm_messages, prove the
planner uses the composite for the equality-only path too (leading-col prefix) and the advisor flags them
duplicate. **After apply:** `get_advisors(performance|security)` — expect no new warns, dropped indexes gone
from unused/duplicate lists, only the accepted `auth_leaked_password_protection` WARN. **Regression:**
index-only changes touch no RLS/grant/policy and are all non-unique → behavior-preserving by construction;
run the isolation / roles / storage suites anyway per discipline (they must hold trivially).

## Appendix B — 5a: server-side length CHECK constraints

Add `NOT VALID` first (fast, no scan lock); confirm existing data complies (`select max(char_length(col))`);
then `VALIDATE`. `body` is NULLable on messages/dm_messages (voice notes) → use `col is null or ...`.
**Column names verified** against `sanitize.js`: comments/messages/dm_messages use `body`; tasks use
`title`/`description`/`blocked_reason`; projects/workspaces use `name`.

```sql
alter table public.tasks       add constraint tasks_title_len_chk          check (char_length(title) <= 500) not valid;
alter table public.tasks       add constraint tasks_description_len_chk    check (description is null or char_length(description) <= 20000) not valid;
alter table public.tasks       add constraint tasks_blocked_reason_len_chk check (blocked_reason is null or char_length(blocked_reason) <= 1000) not valid;
alter table public.comments    add constraint comments_body_len_chk       check (body is null or char_length(body) <= 10000) not valid;
alter table public.messages    add constraint messages_body_len_chk       check (body is null or char_length(body) <= 10000) not valid;
alter table public.dm_messages add constraint dm_messages_body_len_chk    check (body is null or char_length(body) <= 10000) not valid;
alter table public.projects    add constraint projects_name_len_chk       check (char_length(name) <= 80) not valid;
alter table public.workspaces  add constraint workspaces_name_len_chk     check (char_length(name) <= 80) not valid;
alter table public.members     add constraint members_display_name_len_chk check (display_name is null or char_length(display_name) <= 120) not valid;
-- then, per constraint, after confirming compliance: alter table public.tasks validate constraint tasks_title_len_chk; (etc.)
```

**Companion frontend fix:** `sanitizeTask` does NOT clamp title/description length, so the bulk-import path
(`importJSON`) bypasses `maxLength` — an oversized imported title would hit a raw DB error post-CHECK. Add
length clamps in `sanitizeTask` so import degrades gracefully. Subtask items (cap 500) live inside the
`subtasks` jsonb — not a scalar CHECK; leave client-only (low value, not a DoS vector). Confirm the
`members.display_name` client cap before locking 120.

## Appendix C — 5b: server-side aggregation RPCs

**(1) Unread counts — cheap, high value, apply now.** Mirror `dm_unread_counts` (advisor-clean private
DEFINER + public INVOKER). **First verify the team-chat read-cursor mechanism** (is there a `chat_reads`
table, or is `chatUnread` client-only? the chat RPC design depends on it).

```sql
create or replace function private._notifications_unread_count(p_ws uuid) returns bigint
language sql stable security definer set search_path='' as $$
  select count(*)::bigint from public.notifications
   where recipient_id = auth.uid() and workspace_id = p_ws and read = false;
$$;
create or replace function public.notifications_unread_count(p_ws uuid) returns bigint
language sql security invoker set search_path='' as $$ select private._notifications_unread_count(p_ws); $$;
revoke all on function private._notifications_unread_count(uuid) from public, anon;
revoke all on function public.notifications_unread_count(uuid)  from public, anon;
grant execute on function private._notifications_unread_count(uuid) to authenticated;
grant execute on function public.notifications_unread_count(uuid)  to authenticated;
```

**(2) Dashboard/matrix/schedule stats — needs your decision.** A `workspace_task_stats(p_ws)` RPC (counts
by status/priority/assignee/quadrant + overdue/due-soon + progress in one query) removes the need to hold
the full task array *just for the headline numbers* — but the views still render task cards, so this only
pays off **paired with view-level pagination (5c)**. Recommendation: ship (1) now; design (2) now, apply
after pagination lands. Not urgent at 500 tasks.

## Appendix D — 5c: load-older pagination for chat / DMs (mostly frontend)

Keyset pagination on `created_at` — the A3 composite `(workspace_id, created_at desc)` serves it perfectly
(another reason that index earns its place):

```js
// api.js — messages.listBefore(ws, beforeCreatedAt, limit=50)
supabase.from('messages').select('*').eq('workspace_id', ws)
  .lt('created_at', beforeCreatedAt)
  .order('created_at', { ascending:false }).limit(limit)
```

Frontend: a "Load older" control at the top of the chat/DM scrollback that fetches the next page and
prepends, preserving scroll position. Pure client + existing table + the A3 index; no new DB object.

## Appendix E — 5d: message search via tsvector + GIN (respects RLS exactly)

Replace the client grep with a stored generated tsvector + GIN + a **SECURITY INVOKER** RPC so RLS applies
automatically and guest exclusion is free + provable:

```sql
alter table public.messages add column if not exists body_tsv tsvector
  generated always as (to_tsvector('english', coalesce(body,''))) stored;
create index if not exists messages_body_tsv_idx on public.messages using gin (body_tsv);

create or replace function public.search_messages(p_ws uuid, p_q text, p_limit int default 50)
returns setof public.messages language sql stable security invoker set search_path='' as $$
  select m.* from public.messages m
   where m.workspace_id = p_ws and m.deleted_at is null
     and m.body_tsv @@ websearch_to_tsquery('english', p_q)
   order by m.created_at desc
   limit least(coalesce(p_limit,50), 100);
$$;
revoke all on function public.search_messages(uuid,text,int) from public, anon;
grant execute on function public.search_messages(uuid,text,int) to authenticated;
```

Because it's SECURITY INVOKER, `messages_select_member` RLS (`is_workspace_member AND workspace_role <>
'guest'`) applies inside the function → a **guest caller gets 0 team-chat rows automatically**, an outsider
gets 0, a member gets only visible rows. **Proof (rolled back):** guest→0, outsider→0, member→matching.
Optional belt-and-suspenders: `and private.can_see_team_chat(auth.uid(), p_ws)` (redundant under
INVOKER+RLS; keeps a future DEFINER refactor safe). DM search = parallel `search_dm_messages` gated by
`is_dm_participant` (phase 2). Frontend: wire the debounced search box to the RPC.

---

## Run order when the Supabase MCP is back

1. **Item 2 — load test:** seed a throwaway workspace at the volume model via the service role; capture
   `EXPLAIN (ANALYZE, BUFFERS)` + timings + rows-fetched-vs-rendered for every surface; **delete completely
   and prove per-table before/after row counts are identical** (byte-for-byte restore). Never touch a real
   workspace.
2. **Item 3 — indexes:** Appendix A (before/after EXPLAIN proof → apply → advisors → regression → commit).
3. **Item 4 — merge:** after item 3 lands (so the migration file on `main` is applied+proven) and after
   runtime verification of the frontend fixes, merge `perf/scale-robustness-pass` → `main` (deploys).
4. **Item 5:** 5a (Appendix B) → 5b-unread (Appendix C-1) → 5c (Appendix D) → 5b-stats + 5d (Appendix C-2,
   E) with your approval on the flagged items.
