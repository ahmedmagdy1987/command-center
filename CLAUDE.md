# Command Center — project guide for Claude

> Orientation file so any future session is instantly up to speed. Last verified against the
> live DB on **2026-05-31** (latest commit at that point: `880fc8a`, Phase 3B-1).

## What this is

**Command Center** is a React + Vite + Supabase task / operations app.

- **Today:** an internal tool for the owner (Tony) + his VA — tasks, in-task comments, team chat
  (text + voice notes), notifications.
- **Goal:** evolve it into a **paid, multi-tenant SaaS**. The workspaces work (Phases 1–3B-1) is
  the multi-tenancy foundation for that.
- **Live:** <https://tasks.opscommandcenter.com> — Vercel **auto-deploys from `main`** (push to
  `main` = production deploy). SPA rewrites in `vercel.json`.
- **Repo / remote:** `origin` = `https://github.com/ahmedmagdy1987/command-center.git`.

### Stack
- React 19 + react-router-dom 7, Vite 8, Tailwind 3, `lucide-react` icons.
- `@supabase/supabase-js` v2 (auth, Postgres + RLS, Realtime, Storage).
- No TypeScript; no test suite. Scripts: `npm run dev | build | lint | preview`.

## Supabase

- **Project ref:** `nqlzjuxqgajeoypyzlnv` (use the Supabase MCP to inspect/operate the live DB).
- **The DB is the product's spine.** `supabase/migrations/` is the **source of truth** for schema,
  RLS, triggers, grants. Read it first; the live DB should match it.
- **`.env` is gitignored** (`.gitignore` line `.env`). After a machine wipe, recreate it at the repo
  root with the two vars the client requires (`src/lib/supabase.js` throws if either is missing):
  ```
  VITE_SUPABASE_URL=https://nqlzjuxqgajeoypyzlnv.supabase.co
  VITE_SUPABASE_ANON_KEY=<anon/publishable key from the Supabase dashboard>
  ```

### Key files
- `src/VisualTaskCommandCenter.jsx` — the whole UI (single large file): `AppProvider` (state,
  workspace resolution, data load, realtime subs), `WorkspaceSwitcher`, all views.
- `src/App.jsx` — auth/session gate; calls `supabase.realtime.setAuth(token)` on session change so
  RLS-protected realtime is delivered; loads `currentMember`.
- `src/lib/api.js` — all DB access (`auth`, `members`, `workspaces`, `projects`, `tasks`,
  `notifications`, `comments`, `messages`), realtime subscriptions, voice-note storage.
- `src/lib/sanitize.js` — DB⇄app shape mapping (snake_case⇄camelCase) + task normalization. Mirrors
  the DB `tasks_align_privacy` trigger client-side (`owner==='me' → privacy='private'`, else
  `'workspace'`) so optimistic UI matches what the DB stores.
- `src/lib/supabase.js` — the client (persistSession, autoRefreshToken, realtime 10 eps).

## People (the one workspace today)

Workspace **"Command Center"** — id `11111111-1111-1111-1111-111111111111`, **3 members**, all in it:

| Who | Email | `members.role` | Notes |
|-----|-------|----------------|-------|
| **Tony** | ciorciaritony@gmail.com | `owner` | The real human owner; `workspaces.owner_id`. id `1745dca1-…d22c5`. |
| **Ahmed Magdy** | ahmedkassim157@gmail.com | `owner` | **Test owner account.** id `cdbcc2e5-…b98f909`. |
| **VA** | ahmedkassim17777@gmail.com (display_name "Ahmed") | `member` | The VA. id `0598a0bc-…d42a12d`. |

Role today is the **global** `members.role` ('owner' | 'member'); owner-gated actions key off it.
(`workspace_members.role` mirrors it but isn't the authority yet — see Roadmap.)

## Data model (8 base tables)

`tasks`, `projects`, `members`, `comments`, `messages`, `notifications`, `workspaces`,
`workspace_members`. Every tenant-scoped table carries a `workspace_id`.

- `tasks.id` is **TEXT** (client-generated); `comments.task_id` / `notifications.task_id` are TEXT FKs.
- `members` cols: `id` (=auth user id), `email`, `display_name`, `role`, `created_at`. **No `name` col.**
- Storage: private bucket **`voice-notes`** (10 MB cap, audio mime allowlist); objects at
  `<uid>/<uuid>.<ext>`, served via signed URLs; path-based delete ownership.

### Private helper functions (the RLS engine)
SECURITY DEFINER, `search_path=''`, EXECUTE granted to `authenticated` only (revoked from
public/anon). Live in the **`private`** (non-PostgREST/non-API) schema so they don't trip the
`authenticated_security_definer_function_executable` advisor.
- `private.is_workspace_member(ws_id uuid) → bool` — caller ∈ that workspace. The membership gate in
  almost every policy. (Originally `public`; moved to `private` in migration `…172221`.)
- `private.shares_workspace(target_user uuid) → bool` — caller shares a workspace with target. Powers
  members' co-worker visibility.
- `private.is_workspace_owner(ws_id uuid) → bool` — caller is an **owner** of that workspace
  (`workspace_members.role='owner'`). The per-workspace owner gate (Phase 3B-2, migration `…100320`);
  used by `projects_delete_owner`. Implies membership, so it stands alone — replaced the old global
  `members.role` check.

### Triggers (all present & verified)
- `set_workspace_id` (BEFORE INSERT) on **tasks, comments, messages, notifications, projects** →
  `public.set_workspace_id_from_membership()` (SECURITY DEFINER, `search_path=''`, EXECUTE revoked):
  stamps `workspace_id` from the inserter's membership when NULL.
- `tasks_align_privacy` (BEFORE INSERT/UPDATE on tasks) → forces `privacy='private'` for `owner='me'`,
  else `'workspace'`. (Plain trigger fn, not DEFINER.)
- `members_lock_role` (BEFORE UPDATE on members) → blocks ANY `role` change via UPDATE (closes
  self-promotion to owner). Owner-managed role changes are a later phase.
- `notify_on_task_created` (AFTER INSERT on tasks) → when an **owner** creates a non-private va/shared
  task, notify every non-owner member (the VA).
- `notify_on_comment_added` (AFTER INSERT on comments) → on a workspace (va/shared) task, notify all
  members except the author. Private 'me' tasks notify no one.
- `notify_on_task_completed` (AFTER UPDATE on tasks) → on transition into `done` of a va/shared task by
  a **non-owner** (the VA), notify the owner(s).
- `notify_*` fns are SECURITY DEFINER with EXECUTE revoked; clients have **no INSERT grant** on
  `notifications` (rows come only from these triggers). RLS lets a recipient read/update/delete only
  their own rows.

## Phases done

**Phase 1 — workspaces, additive + backfill** (`…141919`, `…142227`). Created `workspaces` +
`workspace_members`; added nullable `workspace_id` + index to tasks/comments/messages/notifications;
backfilled one workspace ("Command Center"), stamped every existing row, added the `set_workspace_id`
auto-stamp trigger so the app kept working with no code change. RLS on the two new tables only.

**Phase 2 — workspace-scoped (tenant-isolated) RLS** (`…170817`, then `…172221`). Rewrote RLS on
tasks/comments/messages/notifications to gate on `is_workspace_member(workspace_id)` **on top of** the
existing within-workspace rules (tasks: `workspace OR own-private`; comments inherit task visibility;
messages: any member; notifications: recipient-only). Locked `workspace_id` NOT NULL on
tasks/comments/messages (`notifications.workspace_id` left nullable — recipient_id is the real gate and
a null-workspace notif is hidden by `is_workspace_member` anyway, so an indirect notify insert can't
roll back the parent action). `…172221` relocated `is_workspace_member` from `public` → `private` to
clear the advisor. No app change; identical behavior for the single-workspace team.

**Phase 3A — isolate projects + members** (`…193541`). Gave `projects` a `workspace_id`
(backfill + NOT NULL + auto-stamp trigger) and membership-gated policies (owner-only delete preserved).
Added `private.shares_workspace`; gave `members` self-or-shared SELECT, self-only INSERT/UPDATE, and
the `members_lock_role` trigger. DB-only; no app change.

**Phase 3B-1 — make the app workspace-aware** (`880fc8a`). First app-code change for tenancy:
- `AppProvider` resolves the active workspace **before any query/sub**. Precedence: `?ws=` (if a
  member) → `localStorage` (if still valid) → first workspace; an invalid/stale choice silently falls
  back to the first valid one and corrects URL + storage. `?ws=` is preserved across navigation;
  switching re-fetches. No-workspace users hit a placeholder (real onboarding is 3B-2).
- `WorkspaceSwitcher` in the top bar (disabled when the user has ≤1 workspace).
- API methods take an optional `workspaceId`; queries filter by it (RLS still the real gate).
- **Realtime, per table (important nuance):**
  - **tasks → client-side filter.** `tasks` is REPLICA IDENTITY DEFAULT, so a server-side
    `workspace_id` filter would drop DELETE events (old row carries only the PK). One subscription
    sees all the user's rows; the client filters INSERT/UPDATE by `task.workspaceId` and applies
    DELETE by id (no-op if not in the current list). `workspaceId` only namespaces the channel so a
    switch re-subscribes.
  - **messages → server-side filter.** `messages` is REPLICA IDENTITY FULL, so a
    `filter: workspace_id=eq.<id>` is safe for INSERT/UPDATE/DELETE alike.
  - **notifications → recipient + workspace.** Server-side `recipient_id=eq.<uid>` (the security gate)
    plus a client-side current-workspace check on top.

**Phase 3B-2 — make "owner" per-workspace** (`20260531100320` + app). Authorization no longer reads the
global `members.role`; it reads `workspace_members.role` for the relevant workspace — the prerequisite
for letting a new signup create a workspace and be its owner.
- **DB:** added `private.is_workspace_owner(ws_id)`; re-pointed the one owner-gated policy
  `projects_delete_owner` from the global-`members.role` EXISTS check to
  `private.is_workspace_owner(workspace_id)`. Nothing else changed; `members.role` + `members_lock_role`
  left as-is (now vestigial for authz).
- **App:** `workspaceMembers.listMine()` reads the caller's `{workspaceId, role}` rows (RLS
  `workspace_members_select_self` self-scopes); `AppProvider` derives `myRole` / `isOwner` / `isMember`
  from the membership row for the **current** workspace, recomputed on switch. Role-aware UI is gated
  behind `membershipsLoaded` so it never flashes the wrong role. Global `members` is still read, but
  **only for profile** (email/display_name).
- **Verified behavior-preserving:** `is_workspace_owner` = true for Tony & Ahmed Magdy, false for the
  VA; a rolled-back temp-WS2 proof showed no cross-workspace owner leakage (WS1 owners can't delete WS2
  projects; the WS2 owner isn't an owner of WS1); per-user baseline identical after.

## Behavior-preservation baselines (the gate)

The discipline on every DB change is: **per-user visible row counts must not change in ways the
migration didn't intend.** **Re-capture a FRESH baseline immediately before each change** — never reuse
the numbers below as fixed constants. This is a live app, so ordinary use ratchets the absolute counts
up between sessions (e.g. tasks were VA 13 / Tony 39 / Ahmed Magdy 15 at the 3B-1 commit; the fresh
3B-2 capture below is higher — both fine, because what's gated is the *deltas*, which must all be
explained by the change).

Latest snapshot — **2026-05-31**, identical before and after the 3B-2 DB + app change
(tasks / projects / members / messages / notifications):

| User | tasks | projects | members | messages | notifications |
|------|------:|---------:|--------:|---------:|--------------:|
| Tony (owner) | 40 | 9 | 3 | 5 | 6 |
| Ahmed Magdy (owner) | 16 | 9 | 3 | 5 | 5 |
| VA (member) | 14 | 9 | 3 | 5 | 5 |

The invariants that must always hold (the *relationships*, not the absolute numbers): projects + members
+ messages are equal across all members of a workspace; tasks = workspace-visible + own-private;
notifications are recipient-scoped.

So the gate is: **re-snapshot per-user counts immediately before a change, then confirm the only
deltas after are the ones the change intended.** Don't hard-code the table above. Re-derive read-only
by simulating each table's RLS predicate as the service role (Supabase MCP `execute_sql`):

```sql
select coalesce(m.display_name, m.email) as who, m.role,
 (select count(*) from public.tasks t
    where t.workspace_id in (select workspace_id from public.workspace_members where user_id=m.id)
      and (t.privacy='workspace' or (t.privacy='private' and t.created_by=m.id))) as tasks,
 (select count(*) from public.projects p
    where p.workspace_id in (select workspace_id from public.workspace_members where user_id=m.id)) as projects,
 (select count(*) from public.members x where x.id=m.id or exists(
    select 1 from public.workspace_members me join public.workspace_members them on them.workspace_id=me.workspace_id
    where me.user_id=m.id and them.user_id=x.id)) as members,
 (select count(*) from public.messages msg
    where msg.workspace_id in (select workspace_id from public.workspace_members where user_id=m.id)) as messages,
 (select count(*) from public.notifications n
    where n.recipient_id=m.id
      and n.workspace_id in (select workspace_id from public.workspace_members where user_id=m.id)) as notifications
from public.members m order by m.role desc, m.created_at;
```
For a true behavior-preservation proof, also run a temporary **second-workspace isolation** check
(create a throwaway workspace + member, confirm zero cross-tenant leakage, then **roll it back**).

## Conventions & landmines

- **Grants are least-privilege & explicit per table** (not default grant-all): e.g. `grant select,
  insert, update, delete … to authenticated`; `revoke insert on notifications`. Mirror this for new
  tables.
- **RLS is the gate, not the app filter.** App-side `workspace_id` filters are convenience; policies
  enforce isolation. Supabase auto-enables RLS on new tables — **a new table with no policy is
  invisible to clients.** Always add policies.
- **Policy naming:** `<table>_<verb>_<qualifier>` (e.g. `tasks_select_workspace_or_own_private`,
  `projects_delete_owner`). `to authenticated`. Keep advisor-clean: wrap auth calls as
  `(select auth.uid())` so they're evaluated once (avoids the `auth_rls_initplan` perf advisor).
- **SECURITY DEFINER helpers** live in the **`private`** schema, `search_path=''`, EXECUTE to
  `authenticated` only (revoked from public/anon) — keeps them off the API and advisor-clean.
- **Authorization is per-workspace, not global.** Owner-gated logic keys off
  `private.is_workspace_owner(workspace_id)` (DB) and the current workspace's `workspace_members.role`
  (app) — **never** the global `members.role` (vestigial since 3B-2). The app reads global `members`
  only for profile (email/display_name).
- **Trigger functions hardened:** `search_path=''` + EXECUTE revoked from public/anon/authenticated.
  Known outliers (faithful to migrations, harmless, fix if doing a hardening pass):
  `tasks_align_privacy` has `search_path=''` but EXECUTE was **not** revoked (still default-PUBLIC) —
  fine because it's a plain non-DEFINER trigger fn; and `notify_on_task_created` uses
  `search_path=public` (the other two notify_* use `''`) — fine, it fully-qualifies `public.*`.
- **Realtime needs `supabase.realtime.setAuth(token)`** (done in `App.jsx` on session change) AND
  **REPLICA IDENTITY FULL** on any table whose UPDATE/DELETE must sync with a server-side filter or
  carry full old rows (set on `comments` + `messages`; `tasks` is DEFAULT → see the tasks realtime
  nuance above). New realtime tables must be added to the `supabase_realtime` publication.
- **When recreating a table's policy set, drop ALL existing policies by real name first** via a
  `pg_policies` loop (don't assume the new names match the old), then recreate. Pattern is in the
  Phase 2/2b/3A migrations.
- **DB change discipline:** propose SQL → **wait for approval** → apply (`apply_migration`) → verify
  (preserve baselines with a STOP-on-unexpected-change check + the rolled-back temp-2nd-workspace
  isolation proof; re-run security advisors) → **add the matching file to `supabase/migrations/`**
  (named `<version>_<description>.sql`, version = the one the remote ledger assigned via
  `list_migrations`, since `apply_migration` does NOT write the file) → commit + push. Migrations are
  idempotent (create-if-not-exists / drop-if-exists / create-or-replace). *(Pre-existing ledger quirk:
  the remote has 2 early entries with no local file — `20260529185644` and a duplicate `…233941` — the
  live schema still matches the repo's files; left as-is.)*
- **Deep Freeze wipes this machine on reboot.** The DB is safe on Supabase, but local code is not —
  **always push to GitHub.** Don't leave work uncommitted/unpushed. After a wipe, follow
  **[`RESTORE.md`](RESTORE.md)** to rebuild the local env (toolchain → clone → git TLS fix →
  `npm install` → launch Claude *inside* the repo so `.mcp.json` loads → recreate `.env` → MCP auth).

## Roadmap / next

Public signup must stay **CLOSED** until onboarding + invitations exist (no orphan/no-workspace users,
no self-join).

**Done:** Phase 3B-2 — per-workspace owner authority (see Phases above). This also subsumes the old
"per-workspace roles" roadmap item for the owner case; `members.role` is now vestigial for authz.

**Required before invitations** — must land before any real multi-member / multi-workspace situation:
1. **(higher) Make the notify_* triggers workspace-aware.** `notify_on_task_created` /
   `notify_on_task_completed` read the **global** `members` table + `members.role` unscoped, so with 2+
   workspaces they'd route notifications to the wrong workspace's members (recipients are still shielded
   by the notifications workspace check, but it produces junk rows + wrong routing + bloat at scale).
   Route only to the task's-workspace members, using per-workspace roles.
2. **(lower) Scope the storage `voice_notes_*` policies to the workspace.** They currently gate on
   global members-existence, not workspace. Low severity (a voice-note path is only learnable from a
   message that's already workspace-scoped, so path-guessing is infeasible), but tighten before public
   launch.

**Next phases:**
1. **Workspace creation + onboarding + membership-on-signup** — a controlled **SECURITY DEFINER RPC**
   that atomically creates a workspace and makes the creator its owner (workspace + `workspace_members`
   row, role 'owner'); turn the 3B-1 no-workspace placeholder into a real onboarding screen.
2. **Invitations** — invite a user into an existing workspace (do "Required before invitations" #1 first).
3. **Billing** — Stripe, per-workspace subscriptions + general product-readiness.
