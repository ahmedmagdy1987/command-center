# Command Center — project guide for Claude

> Orientation file so any future session is instantly up to speed. Last verified against the
> live DB on **2026-07-22** — current through `20260722080911`
> (guest_scoped_avatar_visibility). The **avatars private-bucket conversion** is **MERGED AND
> LIVE** — `main` tip **`972b618`**, production serves `index-DofwQkiD.js`, SHA256-identical to a
> local build of that tree; the `avatars` bucket is now PRIVATE and `members.avatar_url` stores a
> storage **path**, not a URL. See *Avatars private conversion (2026-07-22)*.
>
> `20260722080911` closes a guest over-exposure the post-deploy audit found in that conversion —
> **MERGED AND LIVE** at **`f83f538`** (see *Guest avatar scope fix (2026-07-22)*). DB-only, no
> `src/` files, so the bundle is unchanged: production still serves `index-DofwQkiD.js`.
>
> > ### 🔴 THE ONE ROLLBACK LINE IN THIS PROJECT THAT IS NOT SAFE
> > `git revert -m 1 972b618` restores the CLIENT but **not** the database, and unlike every other
> > entry in this file **that is not a safe end state**: the bucket stays private and the column stays
> > path-shaped, so a reverted client would build public URLs against a private bucket and store URLs
> > the trigger rejects — re-opening the exact degraded state the merge closed. The DB half cannot
> > cleanly come with it either: the URL→path backfill is **one-way**, and `update storage.buckets set
> > public=true` does NOT restore the old values. **Forward-only from here** — fix avatars with a new
> > commit, never by reverting this merge.
>
> Previous anchor: `20260719172122`
> (delete_project_validate_reassign_target); see *Remediation pass (2026-07-19)*, which stopped
> "Keep the tasks" from silently unfiling them, made "Delete for me" reversible, and removed the
> recurring-tasks UI that had **no backend at all**. Earlier the same day, *Chat pass (2026-07-19)*
> shipped team-chat read receipts + "Delete for me" and closed a **live cursor-repudiation hole in
> `dm_reads`**. Both are **merged and live** — `main` tip **`c2004b3`**, regression **519/519**;
> rollback `git revert -m 1 c2004b3`, and LEAVE the migration applied (see that section's box).
> Earlier anchor: `20260718195854`
> (accept_invitation_email_confirm_guard); see *DB pass (2026-07-18)*. Earlier anchor:
> **task file attachments** shipped 2026-07-12 (see *Task attachments*). Two production bugs were found
> and fixed on 2026-07-15 — a live self-service **impersonation** hole and an orphan sweep that could
> **delete live uploads**; see *Bug-fix pass (2026-07-15)*. The
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

## People (3 workspaces live)

> **CORRECTED 2026-07-15 — this table used to be WRONG, and it mattered.** It listed the **vestigial
> `members.role`** column (which reads owner/owner/member) as if it were the authority. The real authority is
> **`workspace_members.role`**, and it says something different: **the VA is an `admin`, not a `member`, and
> Ahmed Magdy is an `admin`, not an `owner`.** Read back from the live DB and re-proven under impersonation.

Workspace **"Command Center"** — id `11111111-1111-1111-1111-111111111111`, **3 members**:

| Who | Email | **`workspace_members.role`** (authority) | `members.role` (vestigial) | Notes |
|-----|-------|------------------------------------------|-----------------------------|-------|
| **Tony** | ciorciaritony@gmail.com | **`owner`** | `owner` | The real human owner; `workspaces.owner_id`. id `1745dca1-…d22c5`. |
| **Ahmed Magdy** | ahmedkassim157@gmail.com | **`admin`** | `owner` | Test account. **NOT an owner of this workspace.** id `cdbcc2e5-…b98f909`. |
| **VA** | ahmedkassim17777@gmail.com (display_name "Ahmed") | **`admin`** | `member` | The VA. id `0598a0bc-…d42a12d`. |

Two other workspaces exist: **"ahmed"** (`f1d15518-…`; VA = `owner`, Ahmed Magdy = `member`) and **"amego"**
(`016db12d-…`; qassemmenna14 = `owner`) — the outsider tenant the isolation proofs impersonate.

**RATIFIED 2026-07-15: both Ahmeds KEEP `admin`. This is intentional — not drift to be "corrected".** Do
not "fix" these roles back to `member`/`owner`; the docs were wrong, the DB was right.

**What `admin` grants them (proven live under impersonation, rolled back):** edit **and delete ANY task in
the workspace** — including tasks they neither created nor are assigned to — plus delete projects, invite
people, and manage members below admin. So **the VA has full workspace power**, which the old docs
(`member` = own/assigned only) badly understated. **The ladder is intact and correctly bounded:** an admin
still cannot promote themselves to `owner`, cannot remove Tony, and cannot touch owners or other admins
(all `42501`). Only Tony (`owner`) can create admins or delete the workspace.

Authorization is **per-workspace** via `workspace_members.role` — a four-rung ladder
**owner > admin > member > guest** (the global `members.role` is vestigial, profile-only — never read it for
authz, and never write this table from it again). See *Workspace roles, mentions & guest UX*.

## Data model (16 base tables)

`tasks`, `projects`, `members`, `comments`, `messages`, `notifications`, `workspaces`,
`workspace_members`, plus `invitations` (workspace invites), the direct-messages quartet
`dm_conversations` / `dm_messages` / `dm_reads` / `dm_message_hides`, their team-chat counterparts
`chat_reads` (read cursor → per-member receipts) and `message_hides` ("Delete for me"), and
`task_attachments` (task file attachments — see *Task attachments*). Every tenant-scoped table
carries a `workspace_id`.
*(The count read "13" until 2026-07-19 and had already missed `dm_message_hides`, which shipped
2026-07-16 — corrected here along with the two added by* Chat pass (2026-07-19)*.)*

- `tasks.id` is **TEXT** (client-generated); `comments.task_id` / `notifications.task_id` are TEXT FKs.
- `members` cols: `id` (=auth user id), `email`, `display_name`, `role`, `created_at`. **No `name` col.**
- Storage: private bucket **`voice-notes`** (10 MB cap, audio mime allowlist); objects at
  `<uid>/<uuid>.<ext>`, served via signed URLs; path-based delete ownership.
- Storage: private bucket **`task-attachments`** (25 MB cap, image+pdf+text/csv+zip+office allowlist,
  no svg/executables); objects at `<workspace_id>/<task_id>/<uuid>.<ext>`, signed-URL download;
  2 GB/workspace byte quota + 2000-object cap + 60/hr/user op-rate limit (see *Task attachments*).
- Storage: **`avatars`** — **PRIVATE since 2026-07-22** (`20260722061442`; it was the last public
  bucket). 2 MB cap, png/jpeg/webp/gif only — **never add svg**, it is stored XSS the moment anything
  renders it inline. Objects at `<uid>/<client-random>.<ext>`; 12/hr/user op-rate limit + 20 objects
  + 20 MB per user; hourly orphan sweep. **`members.avatar_url` stores the storage PATH, not a URL**,
  and that column is a **capability** — it grants co-workspace read on the object it names, so it is
  pinned by trigger to the row owner's own uid folder. Rendering mints short-lived signed URLs
  (batched `createSignedUrls`). See *Avatars private conversion (2026-07-22)*.

### Private helper functions (the RLS engine)
SECURITY DEFINER, `search_path=''`, EXECUTE granted to `authenticated` only (revoked from
public/anon). Live in the **`private`** (non-PostgREST/non-API) schema so they don't trip the
`authenticated_security_definer_function_executable` advisor.
- `private.is_workspace_member(ws_id uuid) → bool` — caller ∈ that workspace. The membership gate in
  almost every policy. (Originally `public`; moved to `private` in migration `…172221`.)
- `private.shares_workspace(target_user uuid) → bool` — caller shares a workspace with target. Powers
  members' co-worker visibility.
- `private.is_workspace_owner(ws_id uuid) → bool` — caller is an **owner** of that workspace
  (`workspace_members.role='owner'`). Introduced as the per-workspace owner gate (Phase 3B-2, migration
  `…100320`) to replace the old global `members.role` check. **Now VESTIGIAL — verified live 2026-07-15:
  it gates NOTHING.** Zero policies and zero functions reference it; the roles migration (`…103433`) moved
  every gate to `private.workspace_role_rank`. It still exists and still works; just don't reach for it —
  new gates use rank (owner 3 · admin 2 · member 1 · guest 0).
- `private._create_workspace(p_name text) → public.workspaces` (Phase 3B-3, migration `…143755`) — the
  privileged body of the workspace-creation RPC. Same hardening, but it WRITES: creates one workspace
  owned by `auth.uid()` + one `workspace_members` row making the caller its `'owner'` (owner/member are
  ALWAYS `auth.uid()`, never params; name trimmed, non-empty, ≤80, else raises). Exposed to the app as
  the thin SECURITY INVOKER passthrough `public.create_workspace(p_name)` — the DEFINER body stays in
  `private` (so it doesn't trip the advisor) and the public wrapper is invoker (so it doesn't either).
- `private._project_task_count(p_project_id text, p_workspace_id uuid) → int` (Bundle 3, migration
  `…024124`) — **owner+admin**-gated (`workspace_role_rank >= 2`, else raises `42501`; re-pointed off
  `is_workspace_owner` by the roles migration so it still matches the delete policy it guards) RELIABLE count of a project's tasks,
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
- `members_lock_identity` (BEFORE UPDATE on members; **replaced `members_lock_role` on 2026-07-15**,
  migration `…142400`) → makes `id` / `email` / `created_at` / `role` **immutable** (raises `42501`).
  `members_update_self` is column-agnostic (it pins the ROW, not the COLUMNS), and RLS structurally
  cannot express "email unchanged" because a `WITH CHECK` only ever sees the NEW row — so this trigger
  is the authoritative control, backed by a least-privilege `UPDATE (display_name)` column grant as an
  independent second layer. **`display_name` is the only column a user may ever write on their own
  profile row**; a profile UI adding fields must extend that grant deliberately. See *Bug-fix pass*.
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
*(Both details are now SUPERSEDED — this paragraph is the historical record, not current state: project
delete is **owner+admin** since the roles migration, and `members_lock_role` became
`members_lock_identity` on 2026-07-15. See* Project delete is owner+admin *and* Bug-fix pass.*)

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
  *(Historical: BOTH names are gone today — `projects_delete_owner` → `projects_delete_admin` (rank ≥ 2)
  and `members_lock_role` → `members_lock_identity`. `is_workspace_owner` itself is now vestigial too.)*
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
**members create + rename/recolor** and **owners+admins delete**, all RLS-enforced by the projects policies
(`projects_insert_member` / `projects_update_member` / **`projects_delete_admin`**). No new CRUD migration;
the only DB change is the deletion-gate RPC. **Delete is owner OR admin** (`workspace_role_rank >= 2`) since
the roles migration — Bundle 3 shipped it as `projects_delete_owner`/`is_workspace_owner`, and both that
policy name and that gate are gone. Verified live 2026-07-15.
- **`tasks.project` is FREE-TEXT** (`text NOT NULL`, holds the project **id** slug, e.g. `personal`/`other`)
  with **NO FK** to `projects`. So deleting a project strands nothing at the DB layer; the UI resolves a task's
  project via `projects.find(p => p.id === task.project)` and degrades gracefully (the chip just disappears,
  no crash) when the id no longer resolves.
- **Deletion model = BLOCK-if-has-tasks**, counted reliably via the **`project_task_count` RPC** (see Private
  helper fns). A frontend/RLS count would be UNRELIABLE — a deleter can't see another member's private
  tasks in a project, so a naive count could delete-and-strand them; the DEFINER RPC counts ALL workspace
  tasks. The RPC's gate (`rank >= 2`) deliberately **matches** the delete policy's, so the count never throws
  for someone who is allowed to delete. The delete `ConfirmModal` fetches the count on open and **disables confirm** ("move N tasks first")
  when >0; only an empty project deletes (two-phase `fadeSlideOut`, local `exitingProjectIds`).
- **api.js `projects`** gained `create({name,color,icon}, ws)`, `update(id, patch)`, `delete(id)`,
  `taskCount(id, ws)`. New `ProjectModal` (name / color swatch / icon) drives create + edit; `ProjectsView`
  has a "+ New project" (member), per-card **owner/admin** delete + member inline edit. `ConfirmModal` gained a
  backward-compatible `confirmDisabled` prop. (The UI gate at `ProjectsView` is `(isOwner || isAdmin)` and
  correctly matches `projects_delete_admin`; it was only ever the docs that said owner-only.)
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
  **owner-only + DB enforcement** (a `SECURITY DEFINER` RPC gated on `private.workspace_role_rank(ws) = 3`), and a
  **typed-confirmation modal** (never one-click / native `confirm()` / an always-on palette command).
- **Policy naming:** `<table>_<verb>_<qualifier>` (e.g. `tasks_select_workspace_or_own_private`,
  `projects_delete_admin`). `to authenticated`. Keep advisor-clean: wrap auth calls as
  `(select auth.uid())` so they're evaluated once (avoids the `auth_rls_initplan` perf advisor).
- **SECURITY DEFINER helpers** live in the **`private`** schema, `search_path=''`, EXECUTE to
  `authenticated` only (revoked from public/anon) — keeps them off the API and advisor-clean.
- **Authorization is per-workspace, not global.** Role-gated logic keys off
  **`private.workspace_role_rank(workspace_id)`** (DB — owner 3 · admin 2 · member 1 · guest 0) and the
  current workspace's `workspace_members.role` (app) — **never** the global `members.role` (vestigial
  since 3B-2), and no longer `is_workspace_owner` (itself vestigial since the roles migration; it gates
  nothing live). The app reads global `members` only for profile (email/display_name), and since
  2026-07-15 may only ever WRITE `members.display_name` (see *Bug-fix pass*).
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
  idempotent (create-if-not-exists / drop-if-exists / create-or-replace). *(The long-standing "2 early
  ledger entries with no local file" quirk — `20260529185644` and a duplicate `…233941` — is **RESOLVED
  and this note was stale**: both files exist in `supabase/migrations/`. Re-verified 2026-07-22 by
  diffing the remote ledger against the repo in both directions — **66/66 exact, zero orphans on either
  side**. If you re-check and it still balances, don't reintroduce the caveat.)*
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

## Task attachments (2026-07-12) — see [`TASK_ATTACHMENTS_DESIGN.md`](TASK_ATTACHMENTS_DESIGN.md)

Files on a task (briefs, deliverables, images, docs). Three DB migrations + a client pass.
- **`20260712124036_task_attachments_core`** — the private **`task-attachments`** bucket (25 MB/file, MIME
  allowlist images+pdf+text/csv+zip+office, **no svg/executables**); **`public.task_attachments`** metadata
  table (immutable — SELECT/INSERT/DELETE grants, no UPDATE), `workspace_id` stamped from the parent task by
  the `set_attachment_workspace_id` BEFORE INSERT trigger (client can't spoof it). **RLS DELEGATES to the task
  predicates, never reimplements guest-scoping:** SELECT via `private.can_view_task` (= `can_see_task(auth.uid(),
  …)`, inherits privacy + guest own/assigned), INSERT via `private.can_edit_task` (mirrors `tasks_update_role`:
  member/guest own-assigned, admin+ any) + `<20`/task, DELETE = uploader-own or admin+ (`workspace_role_rank>=2`).
  Storage-object policies mirror it (download needs a metadata row + `can_view_task`; upload gates the path on
  ws-membership + `can_edit_task`). Helpers `can_view_task` / `can_edit_task` / `task_attachment_count` /
  `workspace_attachment_bytes` / `workspace_attachment_object_count` (DEFINER, `search_path=''`, EXECUTE to
  `authenticated`). Quotas: **2 GB/workspace** byte quota (live storage bytes) + **2000-object/ws** cap.
- **`20260712124336_task_attachment_upload_rate_limit`** — **60 uploads/hour/user** counted on OPERATIONS via
  append-only `private.task_attachment_upload_log` + AFTER INSERT trigger `log_task_attachment_upload` (delete-
  resistant, mirrors the hardened voice-note pattern), wired into the storage INSERT policy.
- **`20260712124726_task_attachment_orphan_sweep`** — hourly **pg_cron** job (the project's **2nd** scheduler,
  after `due-date-reminders`) `private._sweep_orphan_task_attachments()` GCs `task-attachments` objects whose
  metadata row was cascaded away by a task delete (uses `session_replication_role=replica` to bypass the storage
  direct-delete guard). The client also removes attachment objects via the Storage API on task delete (blobs);
  the sweep is the row-reconciliation backstop.
- **Client** (`api.js attachments.{list,upload,signedUrl,remove,removeAllForTask}` + `fromDbAttachment`; TaskModal
  Attachments section): drag-drop/click upload w/ progress + errors, list (name/size/uploader/date), image
  thumbnails via signed URL, download, delete (uploader/admin+), **read-only when `!canEditTask`** (same gate as
  the checklist). `remove()` deletes the OBJECT first (the storage-delete policy needs the metadata row to
  authorize it) then the row. Client MIME/size/count checks are UX only — the server RLS/bucket is authoritative.
- **Proven:** feasibility A-E 14/14 (delegation matrix + happy path + outsider blocks); quotas (size, per-task
  20, rate 60 delete-resistant); orphan sweep 5/5; regression isolation 36/36 + role 40/40 + storage 14/14.

## Avatars private conversion (2026-07-22) — **MERGED AND LIVE**

Two migrations, applied in this order on 2026-07-22 after each was re-proven rolled-back against the
live DB immediately beforehand. Advisors clean (only the accepted `auth_leaked_password_protection`
WARN). Regression after: **534 assertions across 15 suites, zero failures** (isolation 48/48 · role
143/143 · profile 42/42 · avatars-upload-RLS 20/20 · stripe 45/45 · the rest unchanged). Build clean;
lint held at the **12 errors / 2 warnings** baseline. Per-user baseline unchanged in every invariant
that matters — projects/members/messages equal across all WS1 members (6/3/15), tasks =
workspace-visible + own-private, notifications recipient-scoped, and the amego outsider still reads
**0** on every workspace-scoped surface.

| # | Ledger version | What | Proof |
|---|---|---|---|
| 1 | `20260722061032` | `avatars_quota_rate_limit_and_orphan_sweep` | **37/37** rolled-back |
| 2 | `20260722061442` | `avatars_private_bucket_and_signed_urls` | **30/30** rolled-back, then **11/11** live post-apply |

**Deployed 2026-07-22** as merge `972b618` (parent 1 `a463c79`). Production serves
`index-DofwQkiD.js` — SHA256 `34262957…CD7F1809`, 784,129 bytes — **byte-identical** to a local build
of the merged tree, CSS included. **The sweep has since run for real in production**: `avatar-orphan-
sweep` fired at 06:30 UTC, 16 minutes after the conversion landed, status `succeeded`, and the live
avatar object is still present — the exact-equality rule running unsupervised against real data and
correctly sparing an in-use avatar.

> ### THE CUTOVER RAN IN REVERSE ORDER — WHAT THAT COST, AND WHEN NOT TO REPEAT IT
> The owner directed DB-apply-first with the branch left unmerged so production could be verified
> before the client shipped. That **inverted the runbook this section used to carry** (merge → deploy
> → apply). It was deliberate and owner-approved, and it worked — but it traded a ~60-second
> incompatibility window for a **~50-minute** one, during which every avatar rendered as initials and
> photo-saves failed `22023`. Nothing was lost: the one live avatar object and its `avatar_url` row
> converted intact. **Closed by merge `972b618`.**
> **The lesson, for the next mutually-incompatible change:** this was the right call for a two-person
> internal tool with one avatar in play; it is **not the default**. With real users, either ship a DB
> half that accepts BOTH shapes during a transition, or keep the halves simultaneous and minimise the
> window. The DB-first inversion is only safe when you can afford the whole window.

**1 — quota / rate limit / sweep.** `avatars` was the only bucket of the three with **no rate limit,
no byte quota and no object cap**; this adds 12/hr (delete-resistant, operations-counted via an
append-only `private.avatar_upload_log`), 20 objects / 20 MB per user, and the third pg_cron job
`avatar-orphan-sweep` (`30 * * * *`) carrying the 20260715142424 **age guard**.
**→ Landmine already paid for once:** the first draft used
`perform set_config('session_replication_role','replica',true)`, which raises **42501** because this
project's `postgres` is **not a superuser** — the cron job would have errored every hour forever,
silently. Use `SET LOCAL`, as the shipped precedent does. The proof carries a permanent regression
guard (S00) against reintroducing it.

**2 — public → private.** It was the only public bucket, so "Remove photo" left a **world-readable**
image live forever, and any co-member who received a URL held a permanent, unrevokable,
anonymously-fetchable link that outlived their membership. **The design in one line:** `avatar_url`
stops storing a URL and stores the **storage PATH**; a co-workspace SELECT policy gates on the object
being *referenced* by a members row you may see; and the sweep's matching rule becomes exact equality
against that same column — giving one invariant: **an object is VISIBLE iff it is REFERENCED iff it
is NOT SWEPT.**

**Four things a future reader must not undo:**
- **The hard blocker:** `avatars_select_own` is own-folder ONLY. While the bucket was public that never
  mattered (the public endpoint bypasses RLS), but signing needs SELECT — reproduced live in the RED
  phase, where a co-member selected **zero** of a peer's avatar object. Flipping the flag alone
  silently degrades **every avatar except your own** to initials. `avatars_select_own` is KEPT and
  still load-bearing: it is how you read your own just-uploaded, not-yet-saved object.
- **The trigger pin is a CONTROL — and it closed a gap that was LIVE.** The docs used to imply
  `members_validate_profile` already pinned the path to the row owner's uid. **It did not.** The
  pre-change body validated only the public-URL *prefix*, and `authenticated` already held
  `UPDATE (avatar_url)` — so user A could point their `avatar_url` at user B's object *before* this
  change. Harmless while the bucket was public (anyone could fetch it anyway); the instant
  `avatar_url` **grants read access to the object it names**, it becomes A publishing B's private
  image to A's whole workspace. Now pinned to `^<new.id>/[A-Za-z0-9._-]{1,200}$` — pinned to
  **`new.id`, not `auth.uid()`**, so the backfill and future DEFINER maintenance (which run as
  postgres with no `auth.uid()`) still work, and single-segment so sub-paths/traversal are foreclosed.
- **The sweep rule is the sharpest edge.** Suffix matching via `right()` *happens to still work* under
  a path column — it fails **silently correct**, which is exactly what makes it dangerous. Replaced
  with exact equality, which **cannot** match a legacy URL, so a skipped backfill would make the next
  hourly run **delete a live avatar** — and the one live object predated the change by six days, so
  the 1-hour age guard would NOT have saved it. Mitigated twice: a refuse-to-commit backfill guard,
  and a fail-safe that RAISES `55000` rather than deletes if any `avatar_url` is not a bare path.
  Both were exercised live (rolled back).
- **`storage.protect_delete()` is a STATEMENT-level BEFORE DELETE trigger**, so a direct SQL delete on
  `storage.objects` raises 42501 *before RLS is consulted* — an avatars DELETE-policy outcome is
  therefore **not behaviourally provable in SQL** (the proof pins it structurally instead, and says
  so). This is also why the sweep's `SET LOCAL session_replication_role='replica'` is load-bearing.

**Live post-apply verification (11/11, rolled back, against the REAL production rows):** Tony and
Ahmed Magdy each SELECT the VA's real avatar object → signing succeeds and a co-member's face renders;
the amego outsider selects **zero** and lists an **empty** bucket (it was world-readable before);
Ahmed **cannot** point his `avatar_url` at the VA's path (`22023`); the old public-URL shape is
rejected; the sweep runs against live data leaving the real avatar intact; and one URL-shaped value
makes the sweep RAISE `55000` with the object still present.

**Backfill result:** exactly one row converted — the VA's 127-char public URL → the bare path
`0598a0bc-…/ltnts5q5w58m.jpg`, which matches its storage object by exact equality. **0** rows are not
a bare own-uid path; **0** objects are collectable by the sweep.

**Trigger rewrite was verified byte-exact.** `members_validate_profile` was recreated in full, so the
`display_name` / `status_text` / `status_emoji` / `bio` blocks were compared to the pre-image after
apply: **zero differing characters**, and the emoji-range regex is **byte-identical (79 octets)**.
Only the `avatar_url` block changed.

**Client half (branch `feat/avatars-private-signed-urls`, tip `270f513` + this pass).**
`uploadAvatar` returns a path; a dedicated `AvatarSignCtx` + a batched signing cache in AppProvider
(`createSignedUrls`, **plural** — one request per batch, never one per face) that eagerly signs the
roster and proactively re-signs 5 min before the 3600s TTL; `Avatar` resolves a path→signed-URL
through that cache and — the finding-3 fix — tracks the failed `src` in `brokenSrc` (keyed off `src`,
not a sticky boolean) so a refreshed URL retries instead of degrading to initials forever, with
`onError` force-re-signing once per load-cycle. `removeAvatar` deletes the object on Remove-photo, on
re-upload (the previous session object), and on save (the replaced saved object); `savedPathRef`
guarantees the SAVED object is never deleted before a replacement commits. ProfileModal shows a
`blob:` preview on pick. Verified there is **no `getPublicUrl` anywhere in `src/`**.

**The two inverted test files were updated in the same commit** (house landmine rule):
- `avatars_upload_rls` (14 → **20** assertions). Its S-group now proves the reference rule in BOTH
  directions, because that distinction *is* the design: a peer's **unreferenced** object stays hidden
  (S01/S02), a peer's **referenced** object becomes visible (S04/S05 — the hard blocker), a peer's
  superseded object **in the same folder** stays hidden (S06 — so a folder-level "simplification"
  fails loudly), and an outsider still sees nothing (S07). A10 now plants a bare path; A11/A12 pin the
  rejection of the old URL shape and of another user's path.
- `profile_and_avatar` (40 → **42**). It **re-creates `members_validate_profile` inside its own
  transaction**, so it had to track the shipped body or it would silently prove a rule that no longer
  exists — the same landmine already flagged for `_looks_like_role_title`. Bucket now created PRIVATE;
  W18 plants the path shape; W21/W22 added for the old-URL and foreign-path rejections.

**⚠ The two avatars proofs DO NOT RUN AT ALL post-apply — and it is worse than "some assertions
fail".** Measured 2026-07-22: both **abort mid-transaction and emit no verdict whatsoever** (one
during RED fixture setup, one inside GREEN), because their fixtures plant the old public-URL-shaped
`avatar_url` that the rewritten trigger now rejects with `22023`. A careless reader sees a SQL error,
not a red assertion — which is exactly how a suite rots into being ignored. Both headers now record
the exact failing line and error. Fixing them means the **REWIND** pattern;
`guest_scoped_avatar_visibility_rolled_back_proof.sql` is the worked example of a REWIND-built suite
that stays green forever, and is why the guest fix is re-runnable while these two are not.

## Guest avatar scope fix (2026-07-22) — `20260722080911`, **MERGED AND LIVE** (`f83f538`)

> **Rollback is NORMAL here** — `git revert -m 1 f83f538 && git push` (parent 1 = `88306dd`), and
> **LEAVE the migration applied**. It only TIGHTENS visibility and touches no client contract, so it
> is strictly protective. Note the deliberate contrast with `972b618` directly above, which is the
> one merge in this project whose revert is *not* safe.


A post-deploy security audit of the conversion above found — and **reproduced live** — that a
**GUEST could read (and therefore sign a URL for) the avatar object of an ARBITRARY co-member**: a
person the roster deliberately hides from them, and whose `members` row they cannot read at all.
Measured under impersonation: guest → non-peer avatar object = **1 row**, while the same guest got
**0** from `public.members` and **0** from `workspace_members_list`.

**Root cause, and the reusable lesson.** `private.is_visible_avatar_object` is SECURITY DEFINER *on
purpose* — a storage policy whose correctness rides on another table's RLS is a coupling that breaks
quietly. But DEFINER means the guest exclusion baked into `public.members`' own policy no longer
applies, so the share check had to be restated by hand — and it reached for
`private.shares_workspace`, the **pre-2026-07-06** helper with no guest clause, instead of the
guest-scoped rule `20260706035653` introduced everywhere else.
**→ The moment a storage-policy helper becomes DEFINER, every visibility rule it used to inherit
must be restated by hand. Enumerate them; do not assume.** Contrast `voice_notes_select_member`,
a NON-definer `EXISTS` over `messages`, which inherits the guest exclusion for free (verified live:
a guest reads 0 of a team-chat voice-note object).

**The obvious fix was the wrong one.** `can_see_member_profile`'s guest branch is `me.role <>
'guest'`, so for a GUEST CALLER it collapses to `p_target = auth.uid()` — **self only**. Using it
would have returned 0 for a guest's genuine task/DM peers and degraded their faces to initials.
The proof pins the product intent empirically (R03): the roster **does** return those peers to the
guest, so they must keep rendering. The shipped predicate `private.can_see_member_avatar` therefore
mirrors the **roster's** guest clause — non-guest sees any co-member; guest sees self, plus anyone
they share a **task** or a **DM** with — generalised to "in at least one shared workspace".

**Also dropped `private.shares_workspace`** — after the swap it had **zero** references anywhere
(asserted). It was the last pre-guest-scoping visibility helper still alive, and leaving a
guest-blind helper lying around is exactly how this defect happened.

**Proven 13/13 rolled-back** (incl. an anti-vacuity mutation: reverting the predicate makes the leak
return) and **7/7 live post-apply** — non-peer → 0, task-peer → 1, DM-peer → 1, guest listing exactly
{own, task-peer, DM-peer}, non-guest and outsider unchanged, and Tony still sees the VA's real
production avatar. Non-guests are provably unaffected: for them the predicate reduces to the same
membership overlap, and `me.role <> 'guest'` short-circuits before the task/DM subqueries run.

**→ THREE proof files had to change in the same commit**, and the reason is worth knowing: they each
`create or replace` `is_visible_avatar_object` to mirror live, with a body calling the dropped helper.
A `language sql` body is validated **at creation time**, so they would have failed on the DDL, not on
an assertion — a confusing failure mode. `avatars_upload_rls`, `profile_and_avatar` and
`avatars_private_bucket_and_signed_urls` now call `can_see_member_avatar`.

### Guest predicate sync debt (deliberate — referenced by both migration comments)

`private.can_see_member_avatar` (`20260722080911`) and `private._workspace_members_list`
(`20260716110514`) now implement the **same guest rule in two places** and **can drift**. Left
separate on purpose: unifying them means rewriting an RPC carrying 40+ live assertions, inside what
was a security fix — a blast radius not worth taking there. **If you change the guest visibility
rule, change it in BOTH.** Inline warnings sit on each. Unify if the rule ever changes for a third
reason.

### Harness-consistency note (same audit)

The audit's first pass flagged three suites as missing a `rolbypassrls` self-check. On inspection
only **one** was real: `stripe_sandbox_billing` (guard added). `workspace_role_boundary` was a **false
positive** — it guards on `current_user` inside `probe`/`probe_val` and *asserts that guard* in A00,
which is stronger; and `task_attachment_orphan_sweep_age_guard` is **legitimately exempt** — it never
impersonates, because it exercises a DEFINER cron function as postgres and makes no RLS claim.

## Remediation pass (2026-07-19, later the same day) — data integrity, a11y, dead code

> **MERGED AND LIVE.** `main` tip **`c2004b3`**; production serves `index-B1SY169F.js`,
> SHA256-identical to a local build of that tree. Previous state `ce9741a`.
> **Rollback: `git revert -m 1 c2004b3 && git push`** — and **LEAVE `20260719172122` APPLIED.**
> It is strictly protective: the pre-merge client sent a hardcoded seed id that the new validation
> rejects LOUDLY (P0002) instead of silently unfiling tasks. Reverting the migration would restore
> the data-loss path. Revert the client, re-apply forward.

Triggered by a post-deploy audit of the chat pass. Regression after: **519 assertions across 15
suites, zero real failures**; advisors clean (13 lints, zero new). Build clean, lint held at **12/2**.

- **`_delete_project` now validates the reassign target** (`20260719172122`). It checked the target
  was non-blank and different, and that the project being DELETED existed — but never that the
  **target** resolved. `tasks.project` is free text with **no FK**, so "Keep the tasks" moved them
  onto an unresolvable id and silently unfiled them; the chip just disappears and nothing errors.
  **0 tasks were already stranded** (checked live before applying) but the trap was armed everywhere:
  **no workspace has a project `'other'`** and two of three lack `'personal'` — the exact ids the
  client hardcoded. Shipped WITH its client half by necessity: alone it converts a silent stranding
  into a loud P0002 on nearly every project. The modal now has a real destination **picker**, and a
  shared **`defaultProjectId()`** fixed the same assumption in **five** call sites.
- **"Delete for me" is finally reversible.** Both `message_hides` and `dm_message_hides` shipped a
  DELETE policy AND a grant that **nothing ever called** — the same built-but-not-wired shape as the
  hide feature itself. Added `unhide`/`unhideAll`/`hiddenCount` on both surfaces, an **Undo** toast
  (`showToast` gained an optional `{label,onClick}` action, 8s), and a persistent
  **"N hidden — restore"** header control for after the toast expires.
- **Recurring tasks REMOVED from the UI** (owner decision: remove now, build later). No DB function,
  trigger or cron job ever read `tasks.recurring`; five live tasks had carried active rules since
  2026-04-26 producing nothing, while it was advertised on **every** pricing tier. Column and
  `sanitize.js` round-trip retained, so every rule is preserved for a future build.
- **A11y:** message menus are keyboard-operable (focus enters the menu, arrows/Home/End rove,
  focus-out closes, one menu at a time); the mic button's focus ring is back (it was a 1.92:1 border
  tint — under the WCAG 1.4.11 3:1 minimum); and `Avatar`'s `aria-hidden` regression is fixed. That
  last one was **self-inflicted**: the justification "every call site pairs it with a real name" was
  true of three call sites and false of `AssigneeChip` with `showLabel={false}`.
- **Four dead `api.js` exports deleted**, each with a note on what superseded it.

**→ PROOF LIFECYCLE — the reusable lesson.** A proof written BEFORE its migration has two lifecycles
and they conflict: its RED phase attacks a hole the migration then closes, so on re-run it either
fails "expectedly" or **aborts the whole transaction and reports nothing**. Five suites hit this. The
fix is the **REWIND** pattern: transaction-locally restore the pre-migration body, let RED demonstrate
the disease against it, then re-apply and let GREEN prove the cure. Applied to `chat_reads`,
`dm_reads_identity_lock`, `delete_project`, `accept_invitation`, `role_title_match_anchored`.
`message_hides` could NOT be rewound (its RED asserted a table's absence; recreating that means
DROPping a live table and holding an ACCESS EXCLUSIVE lock mid-run) so it became a structural
precondition instead. **Also:** `stripe_sandbox_billing` had been *silently un-runnable since it was
written* — 42501 on its own temp results table, because `record_result` is INVOKER and runs as
`authenticated` during impersonated phases. One grant; now 45/45.

## Chat pass (2026-07-19) — team-chat read receipts, "Delete for me", + a live dm_reads hole

> **MERGED AND LIVE.** `main` tip **`ca847e3`** (merge of `feat/chat-reads-hides-and-dm-hardening`,
> 2026-07-19); production serves `index-CaIOqUll.js`, **SHA256-identical** to a local build of that
> tree. Previous production state was `b8fbd9d`.
> **Rollback: `git revert -m 1 ca847e3 && git push`** (parent 1 = `b8fbd9d`).
> That restores the **CLIENT only, and that is safe** — leave the three migrations applied. The
> pre-merge client works against them unchanged: it does plain table reads (nothing is hidden yet),
> `search_messages` kept its exact signature, and `dm_reads` `markRead` still works under the new
> triggers (asserted by the dm_reads proof's assertion 7, which reproduces the exact
> PostgREST-shaped upsert the client emits). **Do not revert the migrations to roll back the UI.**

Three DB migrations **and the client wiring for all of them, in one change** — the process rule that
nothing ships DB-only, after `dm_message_hides` (20260716000040) shipped proven, applied, and never
called by a single line of app code. Full discipline: proofs run rolled-back FIRST (75/75 across the
three) → owner approval → apply → advisors → regression → ledger-named files → commit.
Advisors clean (only the accepted `auth_leaked_password_protection` WARN). Regression **267/267**:
isolation 48/48 · role 143/143 · profile 40/40 · dm_reads_monotonic 9/9 · dm_message_hides 27/27.
Build clean, lint held at the **12 errors / 2 warnings** baseline.

- **`chat_reads`** (`20260719134628`, 26/26). The team-chat read cursor DMs already had — team chat
  had NOTHING server-side, just a per-device `cc_chat_last_seen:<wsId>` localStorage key that was
  lost on a wipe and invisible to everyone else. Mirrors `dm_reads` ((scope,user) PK, broad SELECT so
  receipts are visible, self-only writes, no DELETE) and then closes two holes dm_reads left open.
  **Guests get two independent layers:** the write policies restate the guest exclusion, AND the
  SELECT policy evaluates the **ROW OWNER's** visibility — so a member later **DEMOTED** to guest
  disappears from everyone's receipts. Layer 2 is not redundant; demotion is the case layer 1 cannot
  reach (asserted).
- **`dm_reads` identity lock + future cap** (`20260719134702`, 19/19) — **A LIVE BUG, not a
  hardening nicety.** `20260715235959` claimed the row "can never be destroyed and re-genesised"
  because there is no DELETE grant. That only rules out DELETE — **not an UPDATE that moves the row
  off its PK.** `dm_reads_update_own` pins `user_id` but says nothing about `conversation_id`, and
  the grant is table-wide UPDATE, so anyone with two DM threads could move their cursor A→B (the
  clamp compares OLD/NEW of the *same* row, so it never fires), vacating A's PK slot, then
  genesis-insert A at any past time. Since the SELECT policy is peer-inclusive *by design*, the peer
  observes it: **"Seen" un-says itself.** The proof's RED phase reproduced this against the then-live
  rules, plus the opposite hole (a cursor dated **2126** was accepted, after which monotonicity makes
  it permanently unmovable). Fixed with the same two triggers `chat_reads` carries.
  **→ Landmine:** the fix MUST be a trigger, not a tighter column grant. PostgREST compiles
  `.upsert()` to `ON CONFLICT DO UPDATE SET <every payload column>` including the conflict-target
  columns, and Postgres checks UPDATE privilege at executor startup whether or not a conflict occurs
  — so `grant update (last_read_at)` would 42501 **every** markRead. The trigger is compatible only
  because the arbiter is the **PRIMARY KEY** (EXCLUDED then necessarily matches OLD on those two
  columns). **Keep the arbiter on the PK**; a different `onConflict` would start failing 42501.
- **`message_hides`** (`20260719134752`, 30/30). Team-chat "Delete for me" — the twin of
  `dm_message_hides`, so both surfaces now have the identical two-tier menu (delete for everyone =
  soft-delete inside the 10-min window; delete for me = personal hide, **no time limit**, works on
  someone else's message and on a tombstone). Guests excluded by construction (the gate delegates to
  the team-chat visibility predicate, so the hide surface can never drift from the message surface).
  SELECT pinned to `user_id = auth.uid()` and nothing else; the workspace clause is deliberately
  **absent** from SELECT because it would fail OPEN (losing membership would make a hidden message
  REAPPEAR). Two oracle probes asserted: duplicating a real hide → **42501, never 23505**; a
  nonexistent `message_id` → **42501, never 23502**. Also replaces `search_messages`, which would
  otherwise hand hidden bodies straight back to the command palette.
  **→ ACCEPTED LOCKOUT:** a member who hides and is then demoted to guest cannot unhide. Harmless
  (a guest can't see team chat at all) and re-promotion restores it; on record, not an accident.

**TWO ACCEPTED BEHAVIOUR CHANGES — the badge moves ONCE on cutover** (owner-approved, both are
corrections): (1) `messages.sender_id` is nullable, and the old client `.neq('sender_id', me)`
silently DROPPED null-sender rows, so **a departed member's messages never counted** — `is distinct
from` counts them; (2) tombstones no longer inflate the count ("this message was deleted" is not an
unread message).

**Client wiring** (`api.js` + `VisualTaskCommandCenter.jsx`): `messages.list`/`listBefore` route
through `chat_thread_messages` via the existing `hideAwareRead` helper (the RPC returns DESC, so both
callers keep their `.reverse()`), and now **THROW on a falsy `workspaceId`** — the old table read just
omitted the `.eq()` filter and mixed every visible workspace into one channel, while the RPC would
match zero rows (a silently empty channel); both are wrong, so fail loudly. `messages.unreadCount`
→ `chat_unread_count` and **lost its `exceptSenderId` argument** (the RPC pins the exclusion to
`auth.uid()`). New `messages.hide()` uses **`ignoreDuplicates`** — load-bearing, same trap as the DM
version: a merge-duplicates upsert needs an UPDATE privilege this table deliberately withholds and
would 42501 on every call including the first. New `chatReads` API. `markChatRead(coverAt)` writes
the server cursor anchored to the triggering message's **server** timestamp, and moved INSIDE the
load `.then` so a failed load no longer claims to have read what it couldn't fetch. Read receipts
poll every 4s + focus + visibilitychange (`chat_reads` is not in the realtime publication, same as
`dm_reads`) and render each member's 14px avatar under the last message at/before their cursor.
`MessageList`'s `receiptFor` lost its `mine &&` gate (behaviour-preserving for DMs, whose
`receiptFor` already returns null unless the message is the last OWN one).
**→ A hide fires NO realtime event** (`message_hides` is deliberately unpublished), so nothing
self-heals: the hiding client calls the new `refreshChatUnread` explicitly.

**Two defects found in the PROOF FILES themselves and fixed before running** — worth knowing because
both classes recur: the `chat_reads` proof carried an **unqualified `delete from public.chat_reads`**
(the banned match-all shape — harmless on a brand-new empty table, NOT harmless once the file lives
in `supabase/tests/` and is re-run against real cursors), and the `dm_reads` proof used
`text || tgenabled` where `tgenabled` is Postgres's `"char"` type — an ambiguous-operator error that
meant **the file could never have run at all**.

**Four client defects found by a 4-lens adversarial review and fixed before commit** (8 raised, 4
refuted). All four are landmines for anyone touching this code again:
1. **The badge race.** Moving `markChatRead` into the load `.then` made the read-mark fully async,
   while AppProvider's boot/switch refresh still recomputed from the server concurrently — and since
   the cursor upsert sits behind a fetch AND a `getSession`, the recompute's `since` is reliably the
   PRE-OPEN cursor, so the stale count usually lands LAST and wins. You would sit in a fully-read
   channel looking at "5". The old localStorage cursor was ordered-safe *by construction* (a
   synchronous `setItem` in a child effect, read by a synchronous `getItem` in the parent) — that
   safety was invisible and it was lost silently. Fixed with the same `viewing` guard `refreshDms`
   already carries.
2. **`chatReads.reads()` needs its `ORDER BY`.** Unordered it plans as a bitmap heap scan in physical
   order, and every `markRead` upsert rewrites a row's heap tuple and moves it — so in an active
   channel the receipt faces visibly permute every poll, and *which* people hide behind the "+N"
   churns. Proven empirically on the live DB, not assumed. `dm_reads` escapes this only because a 1:1
   thread renders one peer.
3. **Receipts were unidentifiable without a mouse.** At 14px `Avatar`'s initials fallback renders at
   ~5px and a `title` tooltip is mouse-only, so on touch and for a screen reader "who read this" was
   unobtainable. Now each face is a real `PersonButton` (focusable, per-person title) plus an
   `sr-only` summary naming everyone *including* those behind the "+N". Also fixed at the source:
   `Avatar`'s initials branch is now `aria-hidden`, matching the photo (`alt=""`) and silhouette
   branches — it was the one branch leaking bare initials into the a11y tree, app-wide.
4. **`reads` is workspace-TAGGED, not applied blind.** ChatView is route-mounted with no workspace
   key, and `receiptsByMessage` matches cursors to messages on TIMESTAMP alone while `people` is not
   workspace-scoped — so a late-resolving fetch could render a non-member of the new workspace, by
   name and face, as having read its messages.

**→ Team chat deliberately DIVERGES from `DmThread.hideForMe` on one point:** it does NOT refresh the
badge after a hide. DMs must (refreshDms also rebuilds previews and other threads' counts); team chat
has one channel, and a hide is only reachable from inside ChatView where the badge is already pinned
to 0 — recomputing there would at best do nothing and at worst re-inflate it from a not-yet-landed
cursor. Don't "restore the parity".

## DB pass (2026-07-18) — anchored role-title rule + invite email-confirm guard

Two DB-only migrations, both with the full discipline (recon → rolled-back proof → owner approval →
apply → advisors → 48/48 + 143/143 regression → ledger-named file → commit). Advisors clean (only the
accepted `auth_leaked_password_protection` WARN).

- **Anchored role-title matching** (`20260718195827`). `private._looks_like_role_title` SUBSTRING-matched
  the folded/stripped text, so **any value CONTAINING a role word was rejected** — `staff meeting`,
  `verified the deploy`, `on official leave`, and the name `Staffan` all failed as "impersonation". The
  rule is now **ANCHORED** (`^…$`): the WHOLE folded value must BE a role title, optionally
  `the`-prefixed, scope-prefixed (`workspace|team|site|app|global|super|sys`), or pluralized. The NFKC
  fold + separator strip are UNCHANGED from `20260716110514`, so every lookalike class still dies:
  `A D M I N`, fullwidth `ａｄｍｉｎ`, math-bold, zero-width-split, `-- Admin --`, `Workspace Owner`,
  `The Admin`, `Admins`, `owner.`, `sysadmin`, `superuser`. **Proven 31/31 rolled-back** (3 RED
  anti-vacuity + RLS-live control + 14 blocked + 7 allowed + 4 e2e through the live trigger + a
  no-regression scan). The rule is strictly NARROWER than the old one, so no already-stored value can
  become newly invalid.
  **→ ACCEPTED WIDENING (ratified, not an oversight):** a role word with a **suffix** now passes —
  `Admin — Tony`, `Owner | Ops`. Blocking those while allowing `staff meeting` is not expressible in one
  regex (a leading-anchor rule would re-reject `verified the deploy`). Cyrillic/Greek confusables and
  leetspeak remain documented residuals, unchanged.
  **→ Landmine:** `supabase/tests/profile_and_avatar_rolled_back_proof.sql` RE-CREATES this function
  inside its own transaction. It was updated in the same commit to the anchored body. **If you change
  this rule again, change it there too** — otherwise that suite silently tests a body that no longer
  ships. (Its 40 assertions all use BARE role words, so none depended on substring matching.)
- **Invitation email-confirm guard** (`20260718195854`). `private._accept_invitation` now rejects a
  caller whose `auth.users.email_confirmed_at IS NULL` (`42501`). The whole invite model is
  **email-bound**, so its strength rested entirely on the dashboard Confirm-email toggle; this asserts
  the invariant in the DB. The check runs **before the token is looked at**, so an unconfirmed account
  gets no `P0002` oracle for token validity. **Proven 17/17 rolled-back** (RED confirmed the gap was
  live; then unconfirmed→42501 with no membership row and the invite left `pending`; confirmed still
  accepts; idempotent re-accept, expired/revoked/wrong-email/unauthenticated paths all intact;
  invite-as-role preserved). 0 pre-existing unconfirmed users, so nobody was locked out.
  **→ HONEST LIMITATION (unchanged by this):** with autoconfirm ON, GoTrue stamps `email_confirmed_at`
  at signup without verification, so this guard alone does NOT stop an attacker signing up as the
  invited email. It closes never-confirmed accounts (admin-created, interrupted flows, future
  providers, legacy) and makes a silent config dependency explicit. **Keeping Auth → Confirm email = ON
  is still the real control** (V-1).
  No app change needed: `InviteScreen.jsx:75` already renders `err.message`, and the guard's message is
  written to be user-facing.

**Proof-harness notes (reusable, learned live this pass):** an assertion running as `authenticated`
**cannot INSERT into the temp results table** — either `grant insert on _r to authenticated` (it's
scratch, nothing asserts on it) or `reset role` before each insert. `invitations` carries
`invitations_one_pending` (UNIQUE `workspace_id, lower(email)` WHERE `status='pending'`), so a proof
needing both a pending AND an expired invite for the same email must put them in **different
workspaces**. And a bare `CREATE OR REPLACE FUNCTION` **cannot run inside a plpgsql `DO` block** — put
the DDL under test at top level between the RED and GREEN blocks; it still rolls back.

## Bug-fix pass (2026-07-15) — two production bugs

Found while scoping a UX batch; fixed ahead of it, with the full discipline (recon → rolled-back proof →
apply-if-green → advisors → baseline → migration file). Both DB-only. Advisors clean; per-user baseline
unchanged (Tony 24/6/11/2 · Ahmed Magdy 0/6/11/6 · VA 0/6/11/7 · outsider 0/0/0/0).

- **BUG A — live impersonation** (`20260715142400`, `2684b6e`). `members_update_self` is **column-agnostic**:
  `USING`/`WITH CHECK` are both just `id = (select auth.uid())`, which pins WHICH ROW you may update but not
  WHICH COLUMNS — and `authenticated` also held a **table-wide UPDATE grant**. So any signed-in user could
  rewrite their own `members.email`, which is **the identity display fallback throughout the UI**. Reproduced
  live (rolled back): the VA set their own email to `ciorciaritony@gmail.com.evil.test` and it stored.
  **RLS structurally cannot fix this** — a `WITH CHECK` only ever sees the NEW row, so it cannot compare
  `new.email` to `old.email`. Fix = two independent layers: the `members_lock_identity` BEFORE UPDATE trigger
  (id/email/created_at/role immutable, `42501`; supersedes and drops `members_lock_role`) **+** a
  least-privilege `revoke update … / grant update (display_name)` column grant. **Proven 25/25 rolled-back +
  14/14 live**, including a phase that deliberately re-grants the wide UPDATE to show the trigger still holds.
  Zero-regression: the app has **no write path to `members` at all** (`api.js` only SELECTs, `:51`/`:58`);
  signup is an INSERT via `handle_new_user`, untouched.
  **→ Consequence for any future profile UI: `display_name` is the ONLY writable column.** Adding e.g.
  `avatar_url` requires deliberately extending that grant. A future backend email-sync would need
  `session_replication_role='replica'` to bypass the trigger (the trick the sweep already uses).
- **BUG B — the orphan sweep could delete LIVE uploads** (`20260715142424`, `2684b6e`). The client uploads the
  blob **first** and inserts the `task_attachments` row **second** (`api.js:977-981`, because the
  storage-delete policy needs the metadata row to authorize a later delete), so an in-flight upload
  legitimately has no metadata row. `_sweep_orphan_task_attachments` tested *only* "no metadata row" and
  deleted it — and the metadata INSERT would then still succeed, leaving a **dangling row pointing at a
  missing blob** (a permanently broken attachment, worse than the orphan the sweep exists to collect). The
  window widens with large files (25 MB cap) and slow connections. Fix: `and o.created_at < now() - interval
  '1 hour'`. **Proven 17/17 rolled-back** (age-0s upload destroyed before / survives after; 59-vs-61-minute
  boundary; 61-minute orphan still collected; linked objects never touched; DEFINER/`search_path` hardening
  and the pg_cron schedule survive `CREATE OR REPLACE`).

**Proof-methodology note (reusable).** `postgres` on this project has **`rolbypassrls = true`**, so any proof
that forgets `set local role authenticated` silently bypasses RLS and proves nothing. Every proof here opens
with self-validating controls — `current_user='authenticated'`, `auth.uid()` wired, and a known-denied write
returning `rows=0` — before asserting anything else. `begin; … select …; rollback;` in one `execute_sql` call
returns the result set *and* rolls back cleanly.

## Project delete is owner+admin (doc correction, 2026-07-15)

CLAUDE.md, `ROLES_AND_PERMISSIONS.md` §1.2 and two `api.js` comments claimed project delete was **owner-only**
via `projects_delete_owner` / `is_workspace_owner`. **Both names are gone.** Live truth (re-read from
`pg_policy`): **`projects_delete_admin` → `private.workspace_role_rank(workspace_id) >= 2` = owner OR admin**,
and `private._project_task_count` (the delete gate) matches at `rank >= 2`, so the count never throws for
someone allowed to delete. The **frontend was already correct** (`ProjectsView` gates on `(isOwner || isAdmin)`,
and the delete modal fails **closed** — `blocked = deleteCount === null || deleteCount !== 0`, so a failed count
blocks). Only the docs were stale. **`private.is_workspace_owner` is now fully vestigial — verified live: zero
policies and zero functions reference it.** Gate on rank.

## Final comprehensive audit + fixes (2026-07-12) — see [`SECURITY_AUDIT_2026-07-12.md`](SECURITY_AUDIT_2026-07-12.md)

Full-surface re-audit (public sign-up now live). Verdict held: **0 critical/high, 0 confirmed cross-tenant
reads, 0 privilege escalation**; anon locked out live; strong security headers; no secrets in 111 commits;
0 XSS. **In-repo relaunch (2026-07-12) with the Supabase MCP** re-ran the blocked live proofs and applied
the three real (all low) DB findings with full discipline (rolled-back proof → apply-if-green → advisors →
migration → isolation regression → commit). All DB-only; build/lint held at **31/2**; advisors clean (only
the accepted `auth_leaked_password_protection` WARN).
- **V-2** (`20260712082020`, `3bb4460`) — pin `tasks.created_by = auth.uid()` in `tasks_insert_role`'s WITH
  CHECK (was only pinned in the private branch; a `privacy='workspace'` insert let a member forge authorship
  + misdirect the completion notification). Now matches `comments`/`messages`. *(The UPDATE path was closed
  the same day by `20260712130915` — an `enforce_task_author_immutable` BEFORE UPDATE trigger raising 42501 on
  any `created_by` change; a WITH CHECK pin can't be used on UPDATE without rejecting legitimate non-creator
  edits. Proven 7/7 rolled-back.)*
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
**(Lint baseline was 31/2 at the time of this entry; it is 12 errors / 2 warnings as of 2026-07-19 — see *Chat pass (2026-07-19)*.)**

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
pg_cron** (`20260626152555`/`…152653`), the **per-account Free/Pro packaging realignment** (config only), and
the **chat pass** — team-chat read receipts (`20260719134628`), the `dm_reads` cursor-repudiation fix
(`20260719134702`), and team-chat "Delete for me" (`20260719134752`), all three **shipped wired into the UI
in the same change** (see *Chat pass (2026-07-19)*), and the **avatars private-bucket conversion** —
quota/rate-limit/sweep (`20260722061032`) + public→private with signed URLs (`20260722061442`),
**merged and live at `972b618`** (see *Avatars private conversion (2026-07-22)*). With that, **all
three storage buckets are private** and none is missing a rate limit, quota or orphan sweep.
`members.role` is vestigial for authz. **(Lint baseline was 31/2 at the time of this entry; it is 12 errors / 2 warnings as of 2026-07-19 — see *Chat pass (2026-07-19)*.)**

**Invite-as-role is DONE** (`20260626135949`) — an owner/admin picks member/guest at invite time (the
`invitations_role_check` widen + `p_role` arg on `create_invitation` + the Members invite-form toggle; 6/6
rolled-back proof). See *Workspace roles, mentions & guest UX*.

### KNOWN GAP — advertised-but-unenforced plan limits (owner-accepted 2026-07-19, deliberately deferred)

**`historyDays`, `prioritySupport`, `seats` and `workspaces` are advertised on the pricing page and
enforced NOWHERE.** Confirmed against the live catalog, not just the docs: there are **zero plan or
billing columns** anywhere in the schema, and `private._create_workspace` / `private._create_invitation`
contain **no count checks at all** — so the seats and workspaces limits are pure client-side UX.
`historyDays` has no retention job of any kind, and `prioritySupport` has no mechanism in the product.

**This is deferred ON PURPOSE, not forgotten.** Enforcing it requires the **per-account vs
per-workspace** billing decision the owner has not made yet (the packaging realignment currently reads
per-account, but nothing implements it). Building enforcement before that decision would mean
enforcing the wrong shape. Everything resolves to the all-access `founding` plan today, so nothing is
mis-sold in practice.

**When billing is built, this is the first thing to close** — see *Roadmap* item 2. Until then, do not
"fix" one of these four in isolation; they share the same missing foundation.

*(Contrast with `recurringTasks`, which was advertised the same way and was REMOVED on 2026-07-19 —
see the RECURRENCE note in `VisualTaskCommandCenter.jsx`. The difference: recurring tasks had no
backend and no path to one without a design decision, whereas these four are limits whose enforcement
is well-understood and merely blocked on a pricing-model choice.)*

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
