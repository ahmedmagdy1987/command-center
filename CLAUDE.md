# Command Center — project guide for Claude

> Orientation file so any future session is instantly up to speed. Last verified against the
> live DB on **2026-07-12** — current through `20260712111044` (voice_note_rate_limit_count_operations). The
> 9ffaa42 security pass is fully CLOSED OUT: security headers + `.gitignore` verified live, the hardening
> migration was already applied 2026-07-01, and the repo filename was reconciled to the ledger in `6ec6f95`. Public
> sign-up is **OPEN** (`SIGNUP_ENABLED = true`). Tenant isolation is proven by rolled-back impersonation
> tests — **0 cross-tenant leaks** (re-run live 2026-07-12: **48/48** isolation + **40/40** role; see *Final
> comprehensive audit + fixes (2026-07-12)*) — and the **workspace roles** system (owner/admin/member/guest)
> has its own rolled-back role-boundary proof (see *Workspace roles, mentions & guest UX*). The 2026-07-12
> audit's three DB findings (V-2 author-pin, V-3 base-RLS/grants re-assert, V-4 op-count voice cap) are all
> **APPLIED**; the one remaining pre-traffic blocker is operational — confirm Auth → Confirm email = ON (V-1).

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
- `src/lib/sanitize.js` — DB⇄app shape mapping (snake_case⇄camelCase) + task normalization. Maps
  `assignee_id`⇄`assigneeId`; `privacy` is an INDEPENDENT field (`workspace`=Shared | `private`), no longer
  derived from the legacy `owner` (the app dropped `owner` entirely in 2B-2; DB column dropped in 2C).
- `src/lib/supabase.js` — the client (persistSession, autoRefreshToken, realtime 10 eps).

## People (the one workspace today)

Workspace **"Command Center"** — id `11111111-1111-1111-1111-111111111111`, **3 members**, all in it:

| Who | Email | `members.role` | Notes |
|-----|-------|----------------|-------|
| **Tony** | ciorciaritony@gmail.com | `owner` | The real human owner; `workspaces.owner_id`. id `1745dca1-…d22c5`. |
| **Ahmed Magdy** | ahmedkassim157@gmail.com | `owner` | **Test owner account.** id `cdbcc2e5-…b98f909`. |
| **VA** | ahmedkassim17777@gmail.com (display_name "Ahmed") | `member` | The VA. id `0598a0bc-…d42a12d`. |

Authorization is **per-workspace** via `workspace_members.role` — now a four-rung ladder
**owner > admin > member > guest** (the global `members.role` is vestigial, profile-only). The three live
people are unchanged (Tony & Ahmed Magdy = `owner`, VA = `member`); admin/guest exist in the model and are
exercised by the rolled-back proofs. See *Workspace roles, mentions & guest UX*.

## Data model (12 base tables)

`tasks`, `projects`, `members`, `comments`, `messages`, `notifications`, `workspaces`,
`workspace_members`, plus `invitations` (workspace invites) and the direct-messages trio
`dm_conversations` / `dm_messages` / `dm_reads`. Every tenant-scoped table carries a `workspace_id`.

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
- `private._create_workspace(p_name text) → public.workspaces` (Phase 3B-3, migration `…143755`) — the
  privileged body of the workspace-creation RPC. Same hardening, but it WRITES: creates one workspace
  owned by `auth.uid()` + one `workspace_members` row making the caller its `'owner'` (owner/member are
  ALWAYS `auth.uid()`, never params; name trimmed, non-empty, ≤80, else raises). Exposed to the app as
  the thin SECURITY INVOKER passthrough `public.create_workspace(p_name)` — the DEFINER body stays in
  `private` (so it doesn't trip the advisor) and the public wrapper is invoker (so it doesn't either).
- `private._project_task_count(p_project_id text, p_workspace_id uuid) → int` (Bundle 3, migration
  `…024124`) — owner-gated (`is_workspace_owner`, else raises `42501`) RELIABLE count of a project's tasks,
  bypassing the caller's RLS blind spots so the app can **block** deleting a project that still holds tasks
  (incl. other members' private tasks the deleter can't see). Exposed as the SECURITY INVOKER passthrough
  `public.project_task_count(p_project_id, p_workspace_id)` — same Option-B advisor-clean shape as
  `create_workspace`. Read-only (no writes); it's the deletion gate, not a write path.
- **Roles engine** (`…103433`, `search_path` hardened in `…103550`): `private.workspace_role(ws_id) → text`
  and `private.workspace_role_rank(ws_id) → int` give the caller's role / rank (**owner 3 · admin 2 · member
  1 · guest 0**) in a workspace; `private._role_rank(text) → int` is the pure name→rank map. They gate every
  role-aware policy/RPC. Role changes flow ONLY through `public.set_member_role(p_ws,p_user,p_role)` /
  `public.remove_member(p_ws,p_user)` (advisor-clean INVOKER → private DEFINER `_set_member_role`), with
  guardrails: caller must out-rank both the target AND the new role, last-owner is protected, no
  self-escalation, admins can't touch owners/other admins or grant admin (only an owner creates admins).
  `workspace_members.role` stays SELECT-only under RLS — these RPCs are its sole write path.
- **Mention visibility helpers** (`…111955`): `private.can_see_task(p_user,p_task)` and
  `private.can_see_team_chat(p_user,p_ws)` evaluate a surface's visibility for an ARBITRARY user (mirroring the
  live SELECT policies incl. the guest own/assigned rule) so a @mention NEVER notifies someone who couldn't
  already see the comment's task / the team chat.
- **Invitation RPCs** (`…041903`): `public.create_invitation` (owner+admin-gated, rank≥2) /
  `accept_invitation` (email-bound, inserts the `workspace_members` row only for `auth.uid()`) /
  `invitation_preview` / `revoke_invitation` — advisor-clean private DEFINER + public INVOKER passthroughs.
  See *Post-Bundle-3 work* and the flagged **invite-as-role** item.

**Sanctioned write path:** `create_workspace` is the **ONLY** way to write `workspaces` /
`workspace_members` — both are SELECT-only under RLS for `authenticated` (no INSERT/UPDATE/DELETE policy
or grant). Direct inserts are denied (verified); all creation goes through the RPC.

### Triggers (all present & verified)
- `set_workspace_id` (BEFORE INSERT) on **tasks, comments, messages, notifications, projects** →
  `public.set_workspace_id_from_membership()` (SECURITY DEFINER, `search_path=''`, EXECUTE revoked):
  stamps `workspace_id` from the inserter's membership when NULL.
- ~~`tasks_align_privacy`~~ — **trigger DROPPED in Phase 2A**: privacy is no longer derived from `owner`
  (the two dimensions are now independent). The function is orphaned (dropped in 2C).
- `members_lock_role` (BEFORE UPDATE on members) → blocks ANY `role` change via UPDATE (closes
  self-promotion to owner). Owner-managed role changes are a later phase.
- `notify_on_task_assigned` (AFTER INSERT OR UPDATE OF assignee_id on tasks; **replaced
  `notify_on_task_created` in Phase 2B-1**) → on create, or when `assignee_id` changes, notify the
  **assignee** — unless the assignee is the acting user (`auth.uid()`).
- `notify_on_comment_added` (AFTER INSERT on comments) → notify the task's **participants
  {created_by, assignee_id}** (distinct) minus the comment author. Self-assigned → notified once.
- `notify_on_task_completed` (AFTER UPDATE on tasks) → on transition into `done` by an actor **other
  than the creator**, notify the **creator**.
- All three (rewritten in 2B-1): key off **`assignee_id`, never `owner`**; stamp
  `notifications.workspace_id` = the task's `workspace_id`; types `task_assigned` / `comment_added` /
  `task_completed`.
- `notify_on_comment_mention` (AFTER INSERT on comments) / `notify_on_message_mention` (AFTER INSERT on
  messages) (`…111955`) → a `mention`-type notification to each user in the row's explicit `mentions uuid[]`
  (no text parsing), **only if** `can_see_task` / `can_see_team_chat` passes (guests excluded from team-chat
  mentions; a comment mention requires the task be visible to that user). `notify_on_comment_added` was
  amended to SKIP a participant who's also @mentioned (the mention supersedes — no double-notify).
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

**Phase 3B-3 — workspace creation + onboarding + auth polish** (`20260531143755` + app). The "front
door" that makes a brand-new user viable.
- **DB:** `public.create_workspace(p_name)` — the sanctioned, atomic, caller-scoped workspace-creation
  RPC (see Private helper functions / Sanctioned write path). Advisor-clean (Option B): public SECURITY
  INVOKER wrapper → `private._create_workspace` DEFINER impl. `handle_new_user` untouched — signup still
  creates only the members profile, never a workspace.
- **App:** `workspaces.create(name)` calls the RPC; `AppProvider.createWorkspace` does create →
  **re-fetch `workspaces.listMine` + `workspaceMembers.listMine` → switch** to the new workspace. The
  re-fetch-before-switch is CRITICAL: `isOwner`/`isMember` derive from `memberships`, so switching with
  a stale list would resolve the brand-new workspace as NOT its owner (React 18 batches the two state
  sets, so the render has new id + new memberships together → `isOwner` true). Real **onboarding** screen
  for no-workspace users (replaces the 3B-1 placeholder, `OnboardingScreen` + `CreateWorkspaceForm`);
  **"+ Create workspace"** always in the `WorkspaceSwitcher` (`CreateWorkspaceModal`; real dropdown once
  >1); new workspace lands on the dashboard with the existing clean empty states. Professional
  **welcome/sign-in** screen with a forgot-password reset flow (`auth.resetPassword`); **public sign-up
  stays CLOSED**, behind the single `SIGNUP_ENABLED` flag in `AuthScreen.jsx` (the one place to flip it).
- **Verified:** rolled-back DB tests (exactly 1 workspace + 1 caller-owner membership, name trimmed, WS1
  untouched; rejects empty/whitespace/null/>80-char; rejects null auth; direct INSERT denied on both
  tables; EXECUTE auth-only; security advisors clean); per-user baselines unchanged; `npm run build` clean.

**Auth routing + working password reset** (frontend only, no DB). Gave the auth/onboarding states real
URLs and made the reset-email link actually land somewhere that can set a new password.
- **Routing:** top-level `<Routes>` in `App.jsx`, gated behind the `checking` session-check so no auth
  screen flashes before session state is known: `/login`, `/forgot-password`, `/reset-password` (the
  last two reachable WITHOUT a normal session — the recovery link arrives independent of one), and
  `/*` → the authed app (`<Navigate to="/login">` when signed out). `AppShell` gives `/onboarding` a
  real route (no workspace → it; has workspace → redirect to `/`). The 8 existing view routes are
  unchanged and resolve as **descendant routes** under the `/*` splat (verified empirically: absolute
  child paths work in react-router 7 — no relativizing needed).
- **Password reset:** `auth.resetPassword` sends `redirectTo = ${window.location.origin}/reset-password`
  (origin-based; works on prod + localhost). `ResetPasswordScreen` detects the Supabase recovery session
  — `getSession()` primary, raw `supabase.auth.onAuthStateChange` `PASSWORD_RECOVERY` as the timing-race
  fallback (the `api.js` `onAuthChange` wrapper drops the event) — sets the new password via
  `auth.updatePassword` (= `supabase.auth.updateUser({ password })`), then navigates to `/` (the
  recovery session is a full session, so normal gating routes the user in). `AuthScreen` is now
  route-driven via a `mode` prop (sign-in vs reset); `SIGNUP_ENABLED` stays closed.
- **Ops note:** `/reset-password` must be added to Supabase **Auth → Redirect URLs** (dashboard step).
  `vercel.json` already SPA-rewrites every path to `index.html`, so the deep link serves the app.

**Phase 2A — generalize task assignment, DB** (`20260531205730`; additive, non-breaking). First of three
stages (2B app + its DB companion, and 2C cleanup, are queued). Breaks the `owner`⟷`privacy` weld and adds a
real assignee.
- **`tasks.assignee_id uuid NULL` → `auth.users(id)` ON DELETE SET NULL** (matches every other user FK; RLS
  compares it to `auth.uid()`) + index `tasks_assignee_id_idx`. Backfill: `owner='me'`→`assignee=created_by`;
  `owner='va'`→the workspace's sole `role='member'` (the VA, `0598a0bc…`); `owner='shared'`→NULL (unassigned).
- **Dropped the `tasks_align_privacy` trigger** — privacy is no longer derived from owner. (The client's
  `sanitizeTask` still sets privacy, so the current UI is unchanged until 2B; the orphaned function is dropped
  in 2C.)
- **New tasks RLS predicate ⟨P2⟩** on all four policies: `is_workspace_member(workspace_id) AND (privacy=
  'workspace' OR (privacy='private' AND (created_by=(select auth.uid()) OR assignee_id=(select auth.uid()))))`
  — i.e. **private = creator OR assignee** (the only access meaning assignment gains; otherwise
  visibility-neutral, and `is_workspace_member` is ANDed first so a stray non-member assignee is harmless).
- **`public.workspace_members_list(p_workspace_id)`** — advisor-clean RPC (private `SECURITY DEFINER` impl
  `private._workspace_members_list` + public `INVOKER` wrapper, like `create_workspace`) returning a
  workspace's members+profiles for the 2B assignee picker, guarded by `is_workspace_member`. Deliberately does
  NOT touch the self-scoped `workspace_members_select_self` policy, so `workspaceMembers.listMine()` / the
  `isOwner` derivation are unaffected.
- **Left intact for later:** the `owner` column + `tasks_owner_check` (dropped in 2C) and the `notify_*`
  triggers (they still read `owner`; rewritten to assignee/creator/participant targeting + workspace-scoped in
  2B's DB companion).
- **Verified (rolled-back proof, then post-commit):** per-user visible-task counts identical (Tony 42 / Ahmed
  Magdy 18 / VA 16, new predicate == old == baseline); an assignee sees a private task assigned to them, a
  third member does not, an unassigned private task stays creator-only; the member RPC returns the workspace's
  members for a member and 0 for a non-member with no cross-workspace leak; security advisors clean.

**Phase 2B-1 — notify_* rewrite (DB companion of 2B, landed in isolation)** (`20260531211450`). Rewrote the
three notification triggers off `owner` onto `assignee_id` + the task's workspace, clearing the last `owner`
reference out of the triggers (so 2C is safe). Locked semantics:
- **`notify_on_task_assigned`** (replaced `notify_on_task_created`; `AFTER INSERT OR UPDATE OF assignee_id`) —
  notify the assignee on create/reassignment, unless assignee == the acting user.
- **`notify_on_task_completed`** — notify the creator when a task goes to `done` by anyone other than the creator.
- **`notify_on_comment_added`** — notify the distinct participants {created_by, assignee_id} minus the comment
  author (self-assigned → exactly one).
- All three stamp `notifications.workspace_id` = the task's workspace; functions stay SECURITY DEFINER /
  `search_path=''` / EXECUTE-revoked. New `notifications.type` value `task_assigned` (the column has no CHECK
  and the app doesn't branch on type, so it's transition-safe).
- **Verified (rolled-back proof, then post-commit):** assigned→assignee (self/unassigned→none; reassign→new
  assignee); completed→creator (own→none); comment→participants minus author (self-assigned deduped to one);
  every notification carried the right workspace_id; task/comment writes still succeed; no `owner` reference
  remains in any notify fn; advisors clean.
- **Transient gap (expected, until 2B-2):** the app doesn't set `assignee_id` yet, so new tasks have
  `assignee_id=NULL` → assignment notifications stay quiet for new tasks in that window; completion + comment
  notifications work.

**Phase 2B-2 — make the app assignee-aware** (app only; no DB). The UI now runs entirely on `assignee_id` +
independent privacy; the legacy `owner` category is gone from the client (the DB `owner` column is dropped in 2C).
- **Data layer:** `sanitize.js` maps `assignee_id`⇄`assigneeId` and treats `privacy` as independent (no owner
  derivation); `toDbTask` stops writing `owner` (DB default fills it until 2C). `api.js` adds
  `workspaceMembers.listForWorkspace(wsId)` → the `workspace_members_list` RPC.
- **AppProvider** loads the current workspace's members (cleared on switch) and exposes `members`, `meId`, and
  `resolveAssignee(id) → {label,hex,soft}` ('Me' for self, 'Unassigned' for null, display name otherwise; color
  deterministic per user id).
- **UI:** `OwnerChip`→`AssigneeChip`; QuickAdd + TaskModal use an **assignee picker + a separate Shared/Private
  toggle** (decoupled — no owner→privacy weld); the Owner filter → a dynamic **Assignee** filter (All / Me / each
  member / Unassigned) via `matchesAssignee`; Dashboard buckets **My / Assigned-to-others / Unassigned**; **VA Desk
  → "My Tasks"** (`assigneeId===meId`) at **`/my-tasks`** (old `/va-desk` redirects, preserving `?ws=`); Sidebar/
  MobileTabs/CommandPalette nav `va`→`mine`. New-task defaults: **assignee = me, privacy = Shared**.
  `SIGNUP_ENABLED` stays closed.
- **Two intended visible changes:** (a) new quick-adds default to **Shared** (was effectively private-by-default);
  (b) former `owner='shared'` tasks now show as **Unassigned**.
- **Verified:** build clean; lint unchanged from baseline (35 errors / 2 warnings); existing-team mapping confirmed
  against live data (former `me`→creator's My Tasks, `va`→the VA's My Tasks, `shared`→Unassigned, Private view
  unchanged; per-user totals unchanged — Tony 42 / Ahmed Magdy 18 / VA 16); a 5-dimension adversarial review found
  no high/medium bugs (4 low edge-cases fixed: members cleared on switch; TaskModal label for a non-member assignee;
  `/va-desk` redirect preserves `?ws=`; QuickAdd always renders a "Me" pill).

**Phase 2C — drop the legacy `owner` column** (`20260601023453`; DB only — **completes Phase 2**).
- `alter table public.tasks drop column owner` (also dropped the dependent `tasks_owner_check`) +
  `drop function tasks_align_privacy()` (orphaned since 2A). `assignee_id` + the ⟨P2⟩ task policies are the model.
- **Pre-req gate (re-confirmed, not assumed):** app had zero task-`owner` references; the only function touching
  `tasks.owner` was `tasks_align_privacy` (dropped here) — the notify_* triggers reference no `owner`.
- **Verified:** rolled-back proof (drop → insert/complete/comment all fire → counts) then post-commit: `owner` +
  `tasks_owner_check` + `tasks_align_privacy` gone; `assignee_id` + FK + 4 policies + the 3 task triggers intact;
  create/update/complete + comment succeed; advisors clean; per-user counts unchanged from the current 26/0/0
  baseline (the old 42/18/16 is void — see the baselines note).

**UX polish — Bundle 1** (frontend only; no DB). Five small changes, all in `VisualTaskCommandCenter.jsx`:
- **`ConfirmModal`** — reusable app-styled destructive-confirm modal (replaces the native `confirm()` on
  per-task delete; z-[60], Delete focused/rose, Cancel/Esc/backdrop cancel, Esc stops bubbling). **Use it for
  future destructive confirms** instead of `confirm()`/`alert()`.
- **Kanban "+ Add task"** opens the full `TaskModal` with status pre-set (via `AppProvider.startDraftTask`:
  create a row with an empty title → open the modal). Abandoning it (closing with a still-empty title)
  auto-deletes the draft — `AppProvider.closeEditing`, routed from the modal backdrop/X and the global Esc.
- **Kanban board shows 5 columns** — Scheduled dropped from the **board only** (`STATUSES.scheduled` + `/schedule`
  intact); columns are `flex-1 min-w-[220px]` so the five fill the width with **no horizontal scrollbar** on
  desktop (5×220 + gaps = 1148px ≪ ~1300px board width).
- **"Added by X"** (read-only) on the task card + modal via `creatorLabel(createdBy)` (you / member name /
  "a former member" / fallback).
- **Removal animations** — `deleteTask` is **two-phase** (mark `exitingIds` → `fadeSlideOut` ~180ms → remove +
  persist; reconciles via refetch on failure) and `NotificationToast` fades out on dismiss; both **respect
  `prefers-reduced-motion`** (instant, JS-guarded via `prefersReducedMotion()`).

**Notification management — Bundle 2** (`0dc5ee3`; frontend only — the recipient+workspace own-row DELETE
policy + grant on `notifications` already existed, so no migration). Per-notification **delete** + **clear
all** in the `NotificationBell` panel: `api.js notifications.delete(id)` (id-scoped, RLS-gated) and
`clearAll(workspaceId)` (recipient + workspace scoped; **throws if no workspaceId** — never a bare/match-all
delete). Each panel row was restructured from a single `<button>` into a wrapper with two **sibling** buttons
(open + a hover-revealed, always-visible-on-touch, aria-labeled rose delete) to avoid a nested `<button>`; a
"Clear all" header control sits behind the Bundle-1 `ConfirmModal`; two-phase `fadeSlideOut` (local
`exitingNotifIds`, `prefers-reduced-motion` → instant). Also fixed a latent bug: `markAll`'s failure-reconcile
now passes `currentWorkspaceId` to `list()`. (Notifications realtime stays INSERT-only — deletes don't
cross-device; left as a separate realtime task.)

**Projects add / delete / rename — Bundle 3** (`ef5b1c8` DB + `223155f` app). Projects were list-only; now
**members create + rename/recolor** and **owners delete**, all RLS-enforced by the Phase-3A policies
(`projects_insert_member` / `projects_update_member` / `projects_delete_owner` — the last re-pointed to
`is_workspace_owner` in 3B-2). No new CRUD migration; the only DB change is the deletion-gate RPC.
- **`tasks.project` is FREE-TEXT** (`text NOT NULL`, holds the project **id** slug, e.g. `personal`/`other`)
  with **NO FK** to `projects`. So deleting a project strands nothing at the DB layer; the UI resolves a task's
  project via `projects.find(p => p.id === task.project)` and degrades gracefully (the chip just disappears,
  no crash) when the id no longer resolves.
- **Deletion model = BLOCK-if-has-tasks**, counted reliably via the **`project_task_count` RPC** (see Private
  helper fns). A frontend/owner-RLS count would be UNRELIABLE — an owner can't see another member's private
  tasks in a project, so a naive count could delete-and-strand them; the DEFINER RPC counts ALL workspace
  tasks. The delete `ConfirmModal` fetches the count on open and **disables confirm** ("move N tasks first")
  when >0; only an empty project deletes (two-phase `fadeSlideOut`, local `exitingProjectIds`).
- **api.js `projects`** gained `create({name,color,icon}, ws)`, `update(id, patch)`, `delete(id)`,
  `taskCount(id, ws)`. New `ProjectModal` (name / color swatch / icon) drives create + edit; `ProjectsView`
  has a "+ New project" (member), per-card owner-only delete + member inline edit. `ConfirmModal` gained a
  backward-compatible `confirmDisabled` prop.
- **sanitize.js clamp relaxed (REQUIRED):** `sanitizeTask` no longer clamps `task.project` to a hardcoded
  9-id whitelist — it accepts any non-empty id, keeps `migrateProjectId` for legacy, and defaults `'other'`
  only when blank. Without this, a task filed under a newly-created project id was silently coerced to
  `'other'` (the clamp runs on create/import via `sanitizeTask`, not on reads via `fromDbTask`).
- **Seed-default edge (flagged, not fixed):** new projects get a `uid()` id, but QuickAdd's new-task defaults
  are still the hardcoded seed ids (`'other'`, and `'personal'` in the private view). Deleting those seed
  projects leaves new-task defaults pointing at a missing id → graceful (no chip, no crash) but new tasks land
  "project-less" until re-filed. Keep `other`/`personal` as de-facto system defaults (or make the defaults
  dynamic) before relying on it.
- **Verified:** rolled-back proof (owner_visible=0 vs rpc=1 on a member's hidden private task; non-owner RPC
  caller rejected; member INSERT ok, non-owner DELETE denied, owner DELETE ok — all rolled back); advisors
  clean (only `auth_leaked_password_protection`); per-user baseline unchanged; build clean; lint at the 34/2
  baseline.

## Behavior-preservation baselines (the gate)

> **Current live data (2026-06-01): WS1 = 26 tasks, all Tony's private** (per-user visible **Tony 26 · Ahmed
> Magdy 0 · VA 0**). A manual "Clear all tasks" run as Ahmed Magdy during 2B-2 smoke-testing deleted the 16
> workspace tasks + his 2 private; only Tony's private (RLS-hidden from him) survived. That destructive command
> has since been removed (see the *No bulk-delete* landmine). **So the current baseline is 26 / 0 / 0** — the
> 42/18/16 (and the 40/16/14 table below) are historical, void after that clear.

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
- **No bulk-delete exists** — the dev-only `resetDemo` / "Clear all tasks" command (a match-all
  `tasks.bulkDelete()` reachable by ANY member via the command palette, deleting across every workspace the
  caller could under RLS) was removed after it wiped live data. Only id-scoped per-task delete remains. Don't
  reintroduce a bulk delete without: **workspace-scoping** (`.eq('workspace_id', …)`, never match-all),
  **owner-only + DB enforcement** (a `SECURITY DEFINER` RPC gated on `is_workspace_owner`), and a
  **typed-confirmation modal** (never one-click / native `confirm()` / an always-on palette command).
- **Policy naming:** `<table>_<verb>_<qualifier>` (e.g. `tasks_select_workspace_or_own_private`,
  `projects_delete_owner`). `to authenticated`. Keep advisor-clean: wrap auth calls as
  `(select auth.uid())` so they're evaluated once (avoids the `auth_rls_initplan` perf advisor).
- **SECURITY DEFINER helpers** live in the **`private`** schema, `search_path=''`, EXECUTE to
  `authenticated` only (revoked from public/anon) — keeps them off the API and advisor-clean.
- **Authorization is per-workspace, not global.** Owner-gated logic keys off
  `private.is_workspace_owner(workspace_id)` (DB) and the current workspace's `workspace_members.role`
  (app) — **never** the global `members.role` (vestigial since 3B-2). The app reads global `members`
  only for profile (email/display_name).
- **Trigger functions hardened:** `search_path=''` + EXECUTE revoked from public/anon/authenticated —
  now uniform across all DEFINER trigger fns (the former outliers are gone: `tasks_align_privacy`'s
  trigger was dropped in 2A, and `notify_on_task_created`'s `search_path=public` quirk was retired in
  2B-1 when it became `notify_on_task_assigned` with `search_path=''`). The orphaned
  `tasks_align_privacy` function was dropped in 2C (`20260601023453`).
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

## Post-Bundle-3 work (the ledger had drifted ahead of this doc — now caught up)

- **Voice-notes storage scoped to the workspace** (`20260602041008`). `voice_notes_select_member` now allows a
  read only if the object is in the caller's own folder OR referenced by a `messages`/`dm_messages` row in a
  workspace the caller belongs to / a DM they participate in — closing the old global members-existence gate.
  (Was "Required before invitations #2"; **DONE**.)
- **Invitations** (`20260602041903`). `invitations` table (SELECT-only under RLS: an owner sees their
  workspace's invites, an invitee sees pending invites to their own email) + four sanctioned RPCs
  (`create_invitation` / `accept_invitation` / `invitation_preview` / `revoke_invitation`, advisor-clean
  private DEFINER + public INVOKER passthroughs). `create_invitation` is **owner+admin-gated** (rank≥2, since
  the roles migration) and takes `p_role` (member|guest, default member) since *invite-as-role* (`…135949`);
  `accept_invitation` is **email-bound** and inserts the `workspace_members` row only for `auth.uid()` (no
  privilege escalation, no inviting as owner/admin). UI: `InviteScreen.jsx` + `/invite/:token`.
- **Workspace slugs** (`20260604102655`). `workspaces.slug` (unique) + `private._slugify`; `create_workspace`
  generates a unique slug; `?ws=` accepts a slug or an id.
- **Direct messages** (`20260604125857` + `20260604130054` FK indexes). `dm_conversations(user_lo,user_hi)`,
  `dm_messages`, `dm_reads`, all participant-gated by `private.is_dm_participant`; a conversation is created
  ONLY by the `get_or_create_dm_conversation` RPC, which enforces BOTH users are members of the workspace (no
  cross-tenant contact). `messages` + `dm_messages` are REPLICA IDENTITY FULL and in the realtime publication.
- **Message edit + soft-delete** (`20260626065335`). `edited_at`/`deleted_at` on `messages` + `dm_messages`;
  the text-or-audio CHECK relaxed for a content-stripped tombstone; `enforce_message_edit_window()` BEFORE
  UPDATE trigger is the authoritative **10-minute** gate for edit AND soft-delete — stamps the audit cols
  server-side, strips content on delete, makes a tombstone immutable. App renders "This message was deleted" /
  "(edited)"; the UI uses **soft-delete only** (hard-delete `remove()` kept but unused). 16-assertion
  rolled-back proof.
- **Packaging realignment** (app/config only, no DB). Recurring tasks + bulk import are now **Free**; voice
  notes are the **Pro** perk; the pricing page leads with Free+Pro (Business de-emphasized into a strip); the
  billing model reads **per-account** (one subscription covers the owner's workspaces). Everything still
  resolves to `founding` (all-access), so this is positioning only. **`SIGNUP_ENABLED` is now `true`.**

## Final comprehensive audit + fixes (2026-07-12) — see [`SECURITY_AUDIT_2026-07-12.md`](SECURITY_AUDIT_2026-07-12.md)

Full-surface re-audit (public sign-up now live). Verdict held: **0 critical/high, 0 confirmed cross-tenant
reads, 0 privilege escalation**; anon locked out live; strong security headers; no secrets in 111 commits;
0 XSS. **In-repo relaunch (2026-07-12) with the Supabase MCP** re-ran the blocked live proofs and applied
the three real (all low) DB findings with full discipline (rolled-back proof → apply-if-green → advisors →
migration → isolation regression → commit). All DB-only; build/lint held at **31/2**; advisors clean (only
the accepted `auth_leaked_password_protection` WARN).
- **V-2** (`20260712082020`, `3bb4460`) — pin `tasks.created_by = auth.uid()` in `tasks_insert_role`'s WITH
  CHECK (was only pinned in the private branch; a `privacy='workspace'` insert let a member forge authorship
  + misdirect the completion notification). Now matches `comments`/`messages`. *(Latent, not fixed: the tasks
  UPDATE policy doesn't pin `created_by`; no caller sends it on update today — flagged for later.)*
- **V-3** (`20260712110048`, `c67c804`) — idempotent re-assert of `enable row level security` + least-privilege
  grants for the out-of-band base tables **tasks/projects/members** (tasks/projects = SIUD; members = SIU, no
  delete; anon/public = none). No-op vs live; makes the repo a replayable source of truth for their RLS+grants
  (their base CREATE TABLE is still out-of-band).
- **V-4** (`20260712111044`, `be8dd25`) — voice-note 30/hr cap now counts **upload operations** via an
  append-only `private.voice_note_upload_log` (AFTER INSERT trigger on `storage.objects`), so delete-then-
  reupload can't reset it; the 1000-object cap stays a survivor count. Proven: bypass (35/35) → blocked at 30.
- **Live re-run:** isolation **48/48** (23 cross-table + 6 comments + 16 edit/delete + 3 DM-participant) and
  role **40/40** (reproduces & exceeds the 35/35 matrix); storage runtime **7/7**; advisors clean.
- **STILL OPEN — operational, owner action:** **V-1** — confirm Supabase **Auth → Confirm email = ON** with
  working SMTP (not SQL-readable; invite email-binding depends on it). Entitlements remain client-only
  (server-enforce before real paid plans). Presence/typing channels remain the accepted metadata residual.

## Red-team security audit (2026-07-06) — see [`SECURITY_AUDIT_2026-07-06.md`](SECURITY_AUDIT_2026-07-06.md)

Deep adversarial pass **beyond** the 45/45 + 35/35 proofs (RLS matrix, every DEFINER body, grants,
storage, realtime, git history, client), attacking as a low-privilege outsider (`qassemmenna14`, amego-only)
and a throwaway guest with rolled-back PoCs. **No DB/RLS change applied; DB fixes flagged for approval.**
**Verdict: tenant isolation + privilege separation are solid** — 0 cross-tenant reads, 0 RPC IDOR (every
outsider RPC attempt blocked `42501`), 0 injection, 0 secrets in git history, 0 XSS; email-binding proven
server-side; the comment-inheritance policy is safe because `tasks.id` is a global PK (colliding-id insert
blocked `23505`). **Real findings (all flagged, not applied):** (M) presence/typing/read-cursor channels leak
spoofable metadata — the known realtime residual, characterized; (L1) a **guest can read the full member
email roster** via `members_select_self_or_shared`→`shares_workspace` (proven); (L2) `TRUNCATE/REFERENCES/
TRIGGER` still granted to anon/authenticated (not API-reachable, least-privilege only); (L3) voice-note upload
needs only a `members` row (no workspace-membership/quota → storage-DoS). **Pre-real-traffic BLOCKERS
(operational, not code):** (1) **verify Supabase "Confirm email" is ON** — invite email-binding + account
integrity depend on it and it's not SQL-readable; (2) server-side entitlement enforcement before billing
(seats/workspaces/voiceNotes/historyDays — all client-only today); (3) auth-dashboard hardening + rate
limits/captcha. Correction to the storage note above: voice-note object keys are `<uid>/<client-random>.<ext>`
(the random is a client `uid()`, not a UUID). Current lint baseline unchanged.

## Pre-launch security audit (2026-06-26)

Full multi-tenant audit, security-first. **Tenant isolation PROVEN** by rolled-back impersonation tests with
real cross-tenant actors (a user in workspace `amego` only vs `Command Center`, plus a workspace co-member who
isn't a DM participant): **23/23** cross-table assertions + **6/6** comments + the **16/16** edit-delete proof
→ **0 cross-tenant leaks** across tasks, projects, comments, messages, notifications,
dm_conversations/messages/reads, workspaces, workspace_members, members, AND voice-notes storage; cross-tenant
writes blocked (`42501`); DM participant isolation holds even inside a shared workspace. The `comments` SELECT
policy (`EXISTS(SELECT 1 FROM tasks …)`) correctly inherits tasks' RLS (proven, not assumed). RPC DEFINER
bodies reviewed — all owner/membership/participant-gated; `accept_invitation` email-bound; anon has **no**
SELECT/INSERT/UPDATE/DELETE on any table. Client: **no XSS sinks** (no `dangerouslySetInnerHTML`; React
auto-escapes every user string; one static `mailto:` link), only the **anon key** client-side (no
`service_role`), `.env` gitignored/untracked. **Open items (flagged, not fixed):** (a) every entitlement gate
is **client-side only** — UX not security, moot under `founding`, must be enforced server-side before real
paid plans; (b) presence/typing channels are **public Realtime broadcast** (metadata only — name/typing/read
cursor) → adopt Realtime Authorization (private channels) before scale; (c) **auth dashboard hardening**
(leaked-password protection, password policy, email-confirm + SMTP, captcha, rate limits) before real traffic
— since updated: password min is **10** (2026-07-06) and the leaked-password WARN is **ACCEPTED** (Free-plan
limitation; see *Roadmap* item 1).
Fixed in-pass: workspace-scoped task-reconcile, removed the global-presence footgun default, no-empty catches.
**(Current lint baseline: 31 errors / 2 warnings.)**

## Workspace roles, mentions & guest UX (2026-06-26, after the audit above)

**Workspace roles — owner/admin/member/guest** (`20260626103433`, hardened `20260626103550`). Promoted
`workspace_members.role` from 2 values to the four-rung ladder (CHECK owner/admin/member/guest) and made it
the authority for every gate (see *Roles engine*). Capabilities: **owner** = everything incl. delete-workspace
+ manage all roles; **admin** = invite + manage members below admin + project delete, but can't touch
owners/admins or grant admin; **member** = full task/chat/projects, but edits/deletes only their OWN tasks;
**guest** = sees + works ONLY their own/assigned tasks + DMs, excluded from team chat / projects / others'
tasks. The task SELECT predicate gained the guest clause `(role<>'guest' OR creator/assignee)`; member task
UPDATE/DELETE tightened to own/assigned (admin+ = any — the one intended behavior change).
`set_member_role`/`remove_member` carry the guardrails. **Proven** by a 35/35 rolled-back boundary proof
(every cross-rank action allowed/denied as specified) + an isolation re-audit showing no regression
(member visibility old==new). App derives `myRole`/`isOwner`/`isAdmin`/`isMember`/`isGuest` from the current
membership (gated behind `membershipsLoaded`); a Members page with a role dropdown (owner sets any; admin sets
member/guest) + remove. Design doc: `ROLES_AND_PERMISSIONS.md`.

**@mention notifications** (`20260626111955`; DB + app). Explicit `mentions uuid[]` on `comments` + `messages`
(populated from an @-picker, NOT text-parsed); visibility-gated triggers (see Triggers) deliver a `mention`
notification ONLY to users who can already see the surface — a mention can never leak task/chat content to
someone otherwise walled off. UI: a portaled `@`-picker with keyboard nav in both composers + full-name
mention pills. **Proven** by a 9/9 gate proof + 7/7 isolation. Due-soon/overdue + email digests deferred (a
pg_cron follow-up). Design doc: `NOTIFICATIONS_AND_ACTIVITY.md`.

**Guest nav cleanup + assignee dropdown** (app only; no DB). Guests now get a flat **My Tasks + Direct
messages** nav (sidebar + mobile) and are bounced off any other view to `/my-tasks` (`GUEST_VIEWS`) —
nav-visibility only, no permission change. The assignee picker became a scalable, portaled, type-to-filter,
keyboard combobox (`AssigneeSelect`, single-select — multi-assignee is a separate DB-touching decision)
replacing the inline name-pills in QuickAdd + TaskModal + the top-bar filter. A systemic light-mode
accent-contrast sweep + an @-mention keyboard/contrast fix pass landed alongside.

**Invite-as-role — APPLIED** (`20260626135949`). `invitations_role_check` widened to all four roles and
`create_invitation` gained `p_role` (default `'member'`, backward-compatible) validated to `member|guest`
(rank≥2 caller; owner/admin are still assigned only via `set_member_role` after join). `accept_invitation`
already applies `inv.role`, so no accept-side change. Proven by a **6/6 rolled-back boundary proof**
(owner/admin invite as guest → invitation carries it → accept joins as guest; admin-invites-admin and
member-caller both rejected), re-run green before apply; advisors clean (only the standing leaked-password
WARN). UI: the Members invite form has a **Member|Guest** toggle (both owner & admin see the same two options
— invites can't grant owner/admin); `api.invitations.create(ws,email,role)` passes `p_role`.

## Due-date reminders — proactive notifications via pg_cron (2026-06-26)

**Due-date reminders** (`20260626152555`, hardened `…152653`). The first **time-based** notification +
the project's first **scheduler**. Completes the notification system (was deferred in
`NOTIFICATIONS_AND_ACTIVITY.md`).
- **Mechanism:** **`pg_cron` is now ENABLED** (`create extension pg_cron`; it was available but not
  installed). An **hourly** job `cron.schedule('due-date-reminders','0 * * * *', 'select
  private._run_due_reminders()')` runs an **in-DB** SECURITY DEFINER function — **no Edge Function / pg_net
  / HTTP / secrets**. `private._run_due_reminders()` (search_path='', EXECUTE-revoked, like the notify
  exemplars) notifies the **assignee** when their task is **due within 24h** (`due_soon`) or **past due**
  (`overdue`), via an atomic updating CTE (`UPDATE … RETURNING → INSERT`). Unassigned tasks are skipped;
  `actor_id=null`. New `notifications.type` values `due_soon`/`overdue` (type has no CHECK).
- **Dedupe:** `tasks.due_reminder_stage text default 'none'` (`none → due_soon → overdue`, monotonic) so each
  fires once, never per-run; a BEFORE UPDATE trigger `reset_due_reminder_stage` resets it to `'none'` when
  `due_date` changes (reschedule re-arms). All UTC `timestamptz` math (date-only due dates are noon-anchored).
- **Role/tenant safety = by construction:** a reminder ALWAYS targets the assignee, who can always see their
  own task (incl. a **guest** assignee → their own reminder); body carries only the title; notifications RLS
  unchanged (recipient-only). **Proven:** 11/11 rolled-back feasibility proof + a **19/19 cross-tenant
  isolation re-audit** (0 leaks across every WS-scoped surface incl. the new due-reminder notifications — the
  45/45 isolation holds). Advisors clean. UI: bell + toast gain glanceable icons (clock=due_soon,
  alert=overdue); deep-link unchanged (they carry `task_id` → `openTask`). Design doc: `DUE_DATE_REMINDERS.md`.
- **Manual trigger (no waiting for the hour):** `select private._run_due_reminders();` as the service role
  (Supabase MCP `execute_sql`) — or inspect the schedule via `select * from cron.job` / runs via
  `cron.job_run_details`.

## Roadmap / next

**Public sign-up is now OPEN** (`SIGNUP_ENABLED = true` in `AuthScreen.jsx`). Onboarding routes a
no-workspace user to create their first workspace; invitations let an owner add members. The DB isolation
prerequisites that gated this are all done (notify_* workspace-awareness in 2B-1; voice-notes storage
scoping in `20260602041008`; invitations in `20260602041903`). Before leaning on open signup for real
traffic, complete the **auth dashboard hardening** below.

**Done since the early phases:** per-workspace owner authority (3B-2), workspace creation + onboarding + auth
polish (3B-3), Phase 2 fully (per-member `assignee_id` + independent privacy; legacy `owner` gone), Bundles
1–3, **voice-notes storage scoping** (`20260602041008`), **invitations** (`20260602041903`), **workspace
slugs** (`20260604102655`), **direct messages** (`20260604125857`/`…130054`), **message edit + soft-delete**
(`20260626065335`), **workspace roles owner/admin/member/guest** (`20260626103433`/`…103550`), **@mention
notifications** (`20260626111955`), **guest nav cleanup + the scalable `AssigneeSelect` dropdown** (app),
**invite-as-role** (`20260626135949`), **concurrency-safe subtask checklists** (app), **due-date reminders via
pg_cron** (`20260626152555`/`…152653`), and the **per-account Free/Pro packaging realignment** (config only).
`members.role` is vestigial for authz. **(Current lint baseline: 31 errors / 2 warnings.)**

**Invite-as-role is DONE** (`20260626135949`) — an owner/admin picks member/guest at invite time (the
`invitations_role_check` widen + `p_role` arg on `create_invitation` + the Members invite-form toggle; 6/6
rolled-back proof). See *Workspace roles, mentions & guest UX*.

**Before real paid traffic (flagged by the 2026-06-26 audit — none applied yet):**
1. **Auth dashboard hardening** (Supabase dashboard — no code): **password minimum raised 6 → 10**
   (2026-07-06; app UI hints/validation synced same day). **Leaked Password Protection = ACCEPTED risk — do
   NOT chase the standing `auth_leaked_password_protection` advisor WARN**: the toggle is a Supabase
   **Pro-plan** feature and this project is on the **Free** plan; revisit at the Pro upgrade (planned before
   real users anyway, primarily for daily backups). Still open: Confirm-email + working SMTP, Captcha / bot
   protection, Auth rate limits, and the redirect-URL allowlist (incl. `/reset-password`).
2. **Server-side entitlement enforcement** — every plan/feature/limit gate is **client-only** today (fine
   under the all-access `founding` default, bypassable the moment real plans exist). Enforce in RLS/RPCs
   before the paywall goes live (the `resolvePlanId` seam + a DB plan column are the landing spots).
3. **(lower) Realtime Authorization for presence** — mark presence/typing channels private + add RLS on
   `realtime.messages` so a known workspace/conversation UUID (or a removed member) can't observe
   typing/name/read-receipt metadata. Message **content** is already RLS-safe; this is metadata only.

**Next product phases:** Billing (Stripe via the dormant `billing.startCheckout` seam + a per-account plan in
the DB) and general product-readiness.
