# Workspace Roles & Permissions — Design doc + AS-BUILT reference

> ## ⚠️ STATUS: **RATIFIED, APPLIED AND LIVE** since 2026-06-26. (Corrected 2026-07-15.)
>
> **This header used to read "PROPOSAL ONLY. Nothing applied." — that was badly stale and actively
> misleading**: the roles system shipped in `20260626103433` (+ `…103550` hardening), `…111955`
> (mentions) and `…135949` (invite-as-role), was proven by a 35/35 rolled-back boundary proof, and is
> live in the UI. A reader trusting line 3 would have concluded roles don't exist.
>
> **How to read this file:** §1.2 is the **as-built** authorization surface, re-verified against the live
> DB on 2026-07-15 — trust it. Everything framed as a *proposal / plan / open question* below §2 is the
> historical design record: some of it shipped, some didn't. Where the two disagree, **§1.2 and the live
> DB win.** Known not-shipped: delete/leave-workspace and `is_workspace_admin` (verified live: zero
> matching functions; `workspaces` has exactly one policy, `workspaces_select_member`).
>
> The re-runnable proofs now live in `supabase/tests/` — `cross_tenant_isolation_rolled_back_proof.sql`
> and `workspace_role_boundary_rolled_back_proof.sql`. Run those instead of reconstructing from prose.

---

## 0. Core principle — two SEPARATE, composable layers

| Layer | Question it answers | Where enforced | Scope |
|---|---|---|---|
| **Plan entitlements** (exists, dormant) | "Is feature X unlocked / are we under limit Y?" | `lib/entitlements.js` (client today; server later) | **Workspace / account** level |
| **Workspace roles** (NEW) | "Is *this member* allowed to do action Z?" | **RLS + RPC, server-side** | **Per-member** |

**An action is allowed iff `(plan allows) AND (role permits)`.** These stay two distinct checks.
The entitlement layer must remain ignorant of roles, and the role layer ignorant of plans. They
compose only at the few call sites where both apply (see §2.4). **Do not entangle them.**

---

# PHASE 1 — RECON: the current authorization surface (facts, no changes)

## 1.1 How the role/owner model is stored TODAY

- **`workspace_members`** (the authority): `id uuid pk`, `workspace_id uuid NOT NULL → workspaces ON DELETE CASCADE`,
  `user_id uuid NOT NULL → auth.users ON DELETE CASCADE`, **`role text NOT NULL` with `CHECK (role IN ('owner','member'))`**,
  `created_at`. **`UNIQUE (workspace_id, user_id)`**. `role` has **no default**.
  - **There is NO UPDATE policy and NO role-lock trigger on `workspace_members`.** It is effectively
    **unwritable by clients** — writes happen ONLY through SECURITY DEFINER RPCs (`create_workspace`,
    `accept_invitation`). So **there is no way to change a member's role today** — roles are set once,
    at workspace creation (`owner`) or invite-accept (`member`). Adding role mutation is the new capability.
- **`workspaces.owner_id uuid NULL → auth.users ON DELETE SET NULL`** — the *historical creator*
  pointer, **NOT the authorization source** (it's nullable and informational). The per-workspace
  authority is `workspace_members.role`, read via `private.workspace_role_rank`.
- **`members.role`** (global profile table): `text NOT NULL DEFAULT 'member'`, `CHECK (role IN ('owner','member'))`.
  **Vestigial for authz** since Phase 3B-2 — used only as a profile field; protected by the
  `members_lock_identity` BEFORE-UPDATE trigger (blocks changes to `role`, and also to `id` / `email` /
  `created_at`). *(This trigger is on `members`, NOT `workspace_members`. It replaced the role-only
  `members_lock_role` on 2026-07-15 — see CLAUDE.md* Bug-fix pass*.)*

## 1.2 The complete authorization surface (every gate, live — re-verified 2026-07-15)

> **This section was rewritten on 2026-07-15.** It previously described the PRE-roles-migration world
> and was wrong in nearly every row: it named `is_workspace_owner` as "the only role-gated helper" when
> that helper now gates **nothing at all**, listed `projects_delete_owner` (renamed) as owner-only when
> project delete is **owner+admin**, and predated the guest-scoping and task-policy renames. Every row
> below was read back from `pg_policy` / `pg_get_functiondef` against the live DB.

**Role gating runs through `private.workspace_role_rank(ws_id)` → owner 3 · admin 2 · member 1 · guest 0.**
`private.is_workspace_owner` still exists but is **VESTIGIAL — zero live policies and zero live functions
reference it.** Don't reach for it; gate on rank.

**Private SECURITY DEFINER helpers** (search_path='', EXECUTE auth-only):
| Helper | Logic | Used by |
|---|---|---|
| `is_workspace_member(ws_id)` | exists membership row | almost every policy + most RPCs |
| `workspace_role(ws_id)` / `workspace_role_rank(ws_id)` | caller's role / rank in that ws | **every role-aware policy + RPC** |
| `is_workspace_owner(ws_id)` | exists membership row **with `role='owner'`** | **nothing (vestigial)** |
| `is_dm_participant(conv_id)` | `auth.uid() ∈ (user_lo,user_hi)` | all `dm_*` policies |
| `shares_workspace(target)` | caller co-members with target | `can_see_member_profile` |
| `can_see_member_profile(id)` | self OR guest-scoped co-worker visibility | `members` SELECT |
| `can_see_task(user,task)` / `can_see_team_chat(user,ws)` | evaluates a surface for an ARBITRARY user | mention triggers |
| `can_view_task(task)` / `can_edit_task(task)` | mirrors the task SELECT / UPDATE predicates | `task_attachments` + storage |

**RLS policies — ROLE-GATED:**
| Policy | Table | Cmd | Gate |
|---|---|---|---|
| `projects_delete_admin` | projects | DELETE | `workspace_role_rank >= 2` (**owner+admin**) |
| `projects_insert_member` / `projects_update_member` | projects | INSERT/UPDATE | `is_workspace_member AND rank >= 1` (excludes guests) |
| `projects_select_member` | projects | SELECT | `is_workspace_member AND role <> 'guest'` |
| `invitations_select_owner` | invitations | SELECT | `workspace_role_rank >= 2` (**owner+admin** — the *name* is stale, the gate is rank) |
| `tasks_select_role` | tasks | SELECT | member + privacy + `(role <> 'guest' OR creator/assignee)` |
| `tasks_insert_role` | tasks | INSERT | member + privacy + **`created_by = auth.uid()`** + `(role <> 'guest' OR assignee)` |
| `tasks_update_role` / `tasks_delete_role` | tasks | UPDATE/DELETE | member + privacy + `(rank >= 2 OR creator OR assignee)` |

**RLS policies — MEMBERSHIP / participant / recipient / author gated (no role distinction):**
- **messages** select: `is_workspace_member`; insert/update/delete: `sender_id=uid AND is_workspace_member`.
- **comments** select: task is visible (`EXISTS tasks` → inherits task RLS); insert/update/delete: `author_id=uid AND is_workspace_member` (+ task in same ws on insert).
- **dm_conversations** select: participant `AND is_workspace_member`. **dm_messages** all: participant (+ membership on insert). **dm_reads** all: participant.
- **notifications** select/update/delete: `recipient_id=uid AND is_workspace_member`. (No insert policy — trigger-only.)
- **members** select: `can_see_member_profile(id)`; insert: `id=uid`; update: `id=uid` **+ the
  `members_lock_identity` trigger + an `UPDATE(display_name)`-only column grant** (id/email/created_at/role
  are immutable — RLS alone can't express that, since `WITH CHECK` never sees the OLD row). (No delete.)
- **workspaces** select: member. **workspace_members** select: `user_id=uid` (self only; RPC-only writes).
- **task_attachments** select: `can_view_task`; insert: `can_edit_task` + `<20`/task; delete: uploader-own OR `rank >= 2`.

**SECURITY DEFINER RPCs and their gating:**
| RPC | Gate |
|---|---|
| `create_workspace(name)` | any signed-in user (creator becomes `owner`) |
| `create_invitation(ws,email,role)` | **`workspace_role_rank >= 2`** + email valid + not already member; `p_role` ∈ {member,guest} |
| `accept_invitation(token)` | email-bound to caller; inserts `workspace_members(ws, uid, inv.role)` |
| `revoke_invitation(id)` | **`workspace_role_rank >= 2`** |
| `invitation_preview(token)` | any authenticated (token holder) — returns ws name + invited email + status |
| `get_or_create_dm_conversation(ws,peer)` | `is_workspace_member` (caller) **AND** peer is a member |
| `workspace_members_list(ws)` | `is_workspace_member` (any member can list the roster, for the assignee picker) |
| `project_task_count(proj,ws)` | **`workspace_role_rank >= 2`** — deliberately matches `projects_delete_admin`, so the count never throws for someone allowed to delete |
| `set_member_role(ws,user,role)` / `remove_member(ws,user)` | caller must out-rank target AND new role; last-owner protected; no self-escalation |

**Storage policies (`voice-notes` bucket, private):**
- `voice_notes_insert_member`: own folder (`foldername[1]=uid`) AND `EXISTS members` (global existence).
- `voice_notes_delete_own`: own folder.
- `voice_notes_select_member`: own folder **OR** referenced by a `messages` row in a ws you're a member of **OR** by a `dm_messages` row in a conversation you participate in.

**App-side checks (`VisualTaskCommandCenter.jsx`):**
- `myRole` = `memberships.find(currentWorkspaceId).role` (from `workspaceMembers.listMine` → `workspace_members.role`).
  `isOwner = myRole==='owner'`, `isMember = myRole==='member'`. `membershipsLoaded` gates role-aware UI.
- `Sidebar` (1787) + `MobileTabs` (1833): **Members nav owner-only**. `FirstRunPanel` (2869): "Invite a teammate" owner-only.
- `ProjectsView`: `canManage = membershipsLoaded && (isOwner||isMember)` → create/edit projects (any member);
  **delete = `isOwner`**.
- `MembersView` (4604): **entire view is owner-only** (`if (!isOwner) return <not authorized>`); invite/revoke owner-only.
- `entitlements`: `ownedWorkspaceCount = memberships.filter(role==='owner').length` (feeds the per-account workspaces limit).

## 1.3 Owner vs Member, concretely (today)

- **Member can:** create / edit / complete / delete tasks (workspace-shared OR their own private),
  create + edit projects (NOT delete), post / edit-own / delete-own in team chat, start + use DMs,
  read + clear own notifications, upload voice notes, list the roster (via RPC, used by the assignee
  picker). **Cannot:** delete projects, invite / revoke members, open the Members management page.
- **Owner can:** everything a Member can **plus** delete projects, create / revoke invitations, open the
  Members page + see the invitations list, run `project_task_count`. (No workspace-delete or billing
  exists yet — those are future Owner-only powers.)
- **Nobody can change a member's role today** (no write path to `workspace_members.role`).

---

# PHASE 2 — PROPOSAL (ratify before any apply; build nothing)

## 2.1 Recommended role set — `owner` > `admin` > `member` > `guest`

A linear **rank** for write capability (owner=3, admin=2, member=1, guest=0), **plus** a separate
**visibility** restriction that only Guest carries.

| Role | One-liner | Maps from today |
|---|---|---|
| **Owner** | Full control: members, roles, projects, all tasks, **workspace delete + billing**. | today's `owner` (unchanged value) |
| **Admin** | Manage members (invite/remove/role ≤ admin), projects (incl. delete), all tasks. **No** workspace-delete, **no** billing, **cannot grant/modify Owner**. | NEW |
| **Member** | Default. Create/edit/complete/delete workspace + own tasks, create/edit projects, full chat + DMs. | today's `member` (unchanged value) |
| **Guest** | External collaborator (freelancer/contractor). **Visibility-restricted** — see §2.2. | NEW |

**Migration is data-safe:** existing `owner`/`member` rows are already valid; `admin`/`guest` are only
ever assigned going forward.

## 2.2 ⚠️ THE GUEST SCOPE — THE KEY PRODUCT DECISION (needs your call)

Guest is **not just "fewer permissions"** — it's a **visibility restriction**, which is the one place
roles touch SELECT policies (and therefore the isolation audit). Two sub-decisions:

**(a) Task visibility — recommend v1 = assigned-only:**
- **Guest v1 (recommended, NO new schema):** a Guest sees **only tasks where `assignee_id = them` (or
  `created_by = them`)** — never the full board, the projects list, or other members' tasks. They can
  create a task **assigned to themselves**, and edit/complete/delete **their own** tasks.
- **Guest v2 ("projects they're added to") needs new infrastructure:** there is **no project-membership
  table** today (`tasks.project` is free-text with no FK, no `project_members`). Scoping a Guest to
  "projects they belong to" requires a **new `project_members(project_id, user_id)` table** + policy
  joins. **Recommendation: ship Guest v1 (assigned-only) first; add project-scoping in a v2** once a
  project-membership table exists. *(Flag: confirm v1 assigned-only is acceptable, or if project-scoping
  is required up front — that enlarges this from "policy change" to "new table + backfill".)*

**(b) Guest & team chat — recommend EXCLUDE in v1 (your stated preference was "can participate"):**
- Team chat (`messages`) is a **workspace-wide broadcast** — a Guest in it can read **all** team-chat
  history. For a true external contractor that's a real exposure.
- **Option A — Guest in team chat (your prompt's lean):** simplest (no `messages` policy change), but the
  Guest sees everything anyone ever posted to the channel.
- **Option B — Guest excluded from team chat (recommended for isolation):** `messages` select/insert add
  `role <> 'guest'`; Guests coordinate via **DMs only**. *(A middle option — "Guest sees only messages
  posted after they joined" — needs a per-member join-timestamp gate; more complex; defer.)*
- **Your call.** The matrix below assumes **Option B** (recommended); say the word and I flip it to A.

Everything else about Guest: **cannot** see the members roster, **cannot** invite, **cannot** see/manage
projects, **cannot** export. **Can** DM workspace members and (plan permitting) send voice notes in DMs.

## 2.3 Full action → role permission matrix

✓ = allowed · ✗ = denied · **own** = only their own/assigned rows · **(plan)** = also gated by a plan
entitlement (see §2.4).

| Action | Owner | Admin | Member | Guest | Rationale |
|---|:--:|:--:|:--:|:--:|---|
| **TASKS** | | | | | |
| See all workspace tasks | ✓ | ✓ | ✓ | ✗ | Guest is scoped to **own/assigned** only |
| See own/assigned tasks | ✓ | ✓ | ✓ | ✓ | |
| Create task (any assignee) | ✓ | ✓ | ✓ | ✗ | Guest may only create **self-assigned** |
| Create task assigned to self | ✓ | ✓ | ✓ | ✓ | lets a Guest log their own work |
| Edit any workspace task | ✓ | ✓ | ✓ | ✗ | Guest edits **own** only |
| Edit own/assigned task | ✓ | ✓ | ✓ | ✓ | |
| Complete task | ✓ | ✓ | ✓ | own | |
| Delete workspace task | ✓ | ✓ | ✓ | ✗ | keeps today's Member power; Guest deletes **own** only |
| Delete own/private task | ✓ | ✓ | ✓ | own | |
| **PROJECTS** | | | | | |
| See projects | ✓ | ✓ | ✓ | ✗ | (v2: Guest sees projects they're added to) |
| Create / edit project | ✓ | ✓ | ✓ | ✗ | unchanged for Member; Guest excluded |
| **Delete project** | ✓ | ✓ | ✗ | ✗ | **change:** today owner-only → now **owner+admin** |
| **MEMBERS / ROLES** | | | | | |
| View members roster | ✓ | ✓ | ✓ | ✗ | already any-member via RPC; Guest excluded |
| Invite member **(plan: seats)** | ✓ | ✓ | ✗ | ✗ | **change:** today owner-only → **owner+admin** |
| Remove member | ✓ | ✓* | ✗ | ✗ | *Admin cannot remove an Owner |
| Change a member's role | ✓ | ✓* | ✗ | ✗ | *Admin: only roles **≤ admin**, never grant/modify Owner; never above own rank |
| **WORKSPACE** | | | | | |
| Rename / edit settings | ✓ | ✓ | ✗ | ✗ | |
| **Delete workspace** | ✓ | ✗ | ✗ | ✗ | Owner only |
| Billing / subscription (future) | ✓ | ✗ | ✗ | ✗ | Owner only |
| **MESSAGING** | | | | | |
| Team chat: read + post | ✓ | ✓ | ✓ | **✗** | **flagged §2.2(b)** — Option B (recommended) |
| Edit / delete own message | ✓ | ✓ | ✓ | n/a | (within the existing 10-min window) |
| DMs: start / participate | ✓ | ✓ | ✓ | ✓ | Guest DMs workspace members |
| Voice notes **(plan: voiceNotes)** | ✓ | ✓ | ✓ | ✓ (DM) | plan-gated, on whatever surface the role allows |
| **DATA** | | | | | |
| Export (JSON) | ✓ | ✓ | ✓ | ✗ | Guest has no full-workspace view to export |
| Import / bulk **(plan: bulkImport)** | ✓ | ✓ | ✓ | ✗ | |

*Notes:* "today's Member can delete any workspace-shared task" is **preserved** (not tightened) to
avoid changing existing behavior; only Guest is newly restricted. If you'd rather tighten Member
delete to own/assigned, that's a separate decision — flag it.

## 2.4 Composability: roles vs plans (where they meet)

Roles and plans are **orthogonal**; an action passes iff **both** clear. The only places **both** apply:

| Action | Plan check (entitlements.js) | Role check (RLS/RPC) |
|---|---|---|
| Invite member | `seats` limit not exceeded | role ∈ {owner, admin} |
| Send voice note | `voiceNotes` unlocked | role can post on that surface |
| Bulk import | `bulkImport` unlocked | role ∈ {owner, admin, member} |
| Create workspace | `workspaces` limit (per-account) | *(no role — it's account-level)* |

**Implementation rule:** keep `entitlements.js` with **zero** role logic and the role helpers with
**zero** plan logic. Compose **at the call site** (UI) and, where server-enforced, **inside the RPC**
(e.g. a future `create_invitation` checks role first, then — once plans are server-enforced — the seat
limit). **v1: roles are independent of plan tier** (no role is gated behind a paid tier).

**Future plan levers that sit ON TOP of roles (note, don't build):** "max N admins", "max N guest
seats" — these are **plan limits**, enforced in the `set_member_role` RPC *after* the role-permission
check, never inside the role helpers. That's the clean seam for monetizing roles later.

## 2.5 Migration shape (recommended)

- **Keep `role` as a `text` column; extend the CHECK** to
  `CHECK (role IN ('owner','admin','member','guest'))` on `workspace_members`. **Do NOT use a Postgres
  `ENUM` type** — enums are painful to reorder/extend; a text+CHECK matches the existing pattern and is
  trivially alterable. **Owner stays a role VALUE** (not `owner_id`) — the codebase already made
  `workspace_members.role` the single authority (3B-2), multiple owners already work, and `owner_id`
  stays as an informational creator pointer.
- **Backfill: none** — existing `owner`/`member` rows are already valid.
- **New helpers** (private, SECURITY DEFINER, search_path='', EXECUTE auth-only):
  - `private.workspace_role(ws_id) → text` — caller's role in `ws_id` (or null). *(proven in §3)*
  - `private.workspace_role_rank(ws_id) → int` — owner=3, admin=2, member=1, guest=0, none=-1 — for
    clean "minimum role" gates (`workspace_role_rank(ws) >= 2` = admin-or-owner).
  - Keep `is_workspace_owner` (now `rank=3`) for back-compat; optionally add `is_workspace_admin`.
- **New sanctioned RPCs** (the role-write path, since `workspace_members` stays client-unwritable):
  - `set_member_role(p_ws, p_user, p_role)` — guardrails in §2.7.
  - `remove_member(p_ws, p_user)` — guardrails in §2.7.
  - *(optional)* `leave_workspace(p_ws)` — self-removal (blocked for the last owner).
  - Extend `create_invitation(p_ws, p_email, p_role)` to take a role (validated; the `invitations.role`
    column already exists and `accept_invitation` already honors `inv.role`).

## 2.6 Table-by-table change list (the full RLS/RPC/storage surface to rewrite)

> Every item below would be applied as an idempotent migration, **each boundary proven rolled-back**,
> then the **full 45/45 isolation audit re-run**. Listed so you see the blast radius before approving.

**`workspace_members`**
- Extend `role` CHECK to 4 values. (No new UPDATE policy — role writes stay RPC-only via `set_member_role`.)

**`tasks`** (4 policies — the visibility-sensitive ones; Guest scoping lives here)
- `tasks_select_*`: add Guest scope → `... AND (workspace_role(workspace_id) <> 'guest' OR created_by=uid OR assignee_id=uid)`.
- `tasks_insert_*`: add role floor → guests may insert **only** self-assigned (`workspace_role <> 'guest' OR assignee_id=uid`). *(pattern proven in §3)*
- `tasks_update_*` / `tasks_delete_*`: restrict guests to own/assigned (member+ unchanged).

**`projects`** (4 policies)
- `projects_select_member`: exclude guests (v1) / scope to project-membership (v2).
- `projects_insert_member` / `projects_update_member`: add `workspace_role_rank >= 1` (exclude guest).
- `projects_delete_owner` → **`projects_delete_admin`**: `workspace_role_rank(workspace_id) >= 2` (owner+admin).

**`messages`** (team chat — only if Guest excluded, Option B)
- `messages_select_member` / `messages_insert_member`: add `workspace_role(workspace_id) <> 'guest'`.
- (Option A = no change.)

**`comments`** — inherits task visibility automatically (gates on task EXISTS → task RLS). Optionally add
a guest floor on insert. Likely **no change** needed beyond what tasks scoping gives.

**`dm_*`** — participant-gated; **no change** (guests can DM). `get_or_create_dm_conversation` already
requires both users be members — fine.

**`notifications`** — recipient-gated; **no change**.

**`invitations`**
- `invitations_select_owner` → owner+admin (`workspace_role_rank >= 2`).

**`storage` (voice-notes)** — `voice_notes_select_member` references `messages`/`dm_messages` visibility;
if Guests are excluded from team chat, the message branch already won't match for them. **Review, likely
no change**; tighten the insert "members existence" check to workspace membership while we're here (a
pre-existing low-pri item).

**RPCs**
- `create_invitation`, `revoke_invitation`, `project_task_count`: `is_workspace_owner` → `workspace_role_rank >= 2` (owner+admin).
- **NEW:** `set_member_role`, `remove_member`, (optional) `leave_workspace`; extend `create_invitation` with a role param.

**App (AFTER approval — not now):** derive `isAdmin` / `isGuest` / `canManageMembers` (owner||admin)
alongside `isOwner`; Members page visible to owner+admin with a role dropdown + remove; Guest UI hides
projects/board/members nav and lands on My Tasks + DMs.

## 2.7 Role-management UX plan (BUILD AFTER APPROVAL)

- **Where:** the existing **Members** page, now visible to **owner + admin**. Each member row gains a
  **role dropdown** (Owner / Admin / Member / Guest) and a **Remove** action; both route through the new
  RPCs (never a direct `workspace_members` write).
- **Guardrails (enforced in the RPC, mirrored in the UI):**
  1. **Never demote/remove the LAST owner** — `set_member_role`/`remove_member` count owners and raise if
     the change would drop the workspace to zero owners.
  2. **No self-escalation / self-lockout** — you cannot raise your own rank; self-demote allowed only if
     you're not the last owner.
  3. **Rank ceiling** — you cannot set a role **above your own** rank (Admin can't grant Owner/Admin
     beyond policy; only Owner grants Owner).
  4. **Admin limits** — Admin can manage `member ↔ guest` and (per decision) promote to Admin, but
     **cannot remove or modify an Owner**.
  5. **Confirm modals** for destructive changes (remove member, demote an owner) via the existing
     `ConfirmModal`.

---

# PHASE 3 — FEASIBILITY PROOF (done, rolled back)

**One representative boundary proven: a Guest cannot INSERT a task while a Member can, in the SAME
workspace.** Validates the exact pattern (`private.workspace_role(ws_id)` helper + a role floor in the
policy `WITH CHECK`) we'd roll out everywhere. Run as a single rolled-back `DO` block (impersonation via
`set local role authenticated` + jwt `sub`), force-rolled-back via `RAISE`:

```
==== ROLE-GATED RLS FEASIBILITY PROOF (rolled back) ====
PASS  [ctrl]   guest IS a workspace member (denial below is role-based, not a membership failure)
PASS  [member] INSERT task -> success (1 row)
PASS  [guest]  INSERT task -> blocked 42501 (role gate enforced)
---- RESULT: 3 passed / 0 failed ----
```

**Rollback verified clean:** original `tasks_insert_member` policy restored, candidate policy gone,
`workspace_members_role_check` back to 2 roles, `private.workspace_role` helper gone, throwaway
workspace gone. **Live DB untouched.**

**What this validates:** (a) a 4-value role can live in `workspace_members` (CHECK widened, rolled back);
(b) two members of the *same* workspace can hold *different* roles; (c) a SECURITY DEFINER
`workspace_role()` helper resolves the caller's per-workspace role under impersonation; (d) a role floor
in an RLS `WITH CHECK` **denies the lower role (42501) and allows the higher role** — exactly the
mechanism for the whole rollout.

## The full-apply commitment (when ratified)

When you approve the matrix, the apply will:
1. Land the migration **idempotently and staged**, and **prove EVERY role boundary** (each role × each
   gated action: see/create/edit/delete task, project CRUD, invite/remove/role-change, team-chat
   in/out, etc.) with **rolled-back impersonation tests** — pass before commit.
2. **Re-run the existing full cross-tenant isolation audit** afterward to confirm the **45/45 isolation
   is not regressed** by the role changes (the Guest SELECT scoping is the part most likely to interact
   with isolation, so it gets extra adversarial coverage).
3. Only then build the role-management UI (§2.7).

---

# RATIFICATION CHECKLIST (what I need from you before any apply)

1. **Role set** — Owner / Admin / Member / Guest as defined? (or adjust)
2. **Guest task scope** — v1 **assigned-only** (no new table), with project-scoping deferred to v2? Or
   require project-scoping up front (= new `project_members` table)?
3. **Guest & team chat** — **Option B (excluded, recommended)** or **Option A (included)**?
4. **Project delete** — open to **owner + admin** (proposed)? 
5. **Member task-delete** — keep today's "any workspace task" power (proposed), or tighten to own/assigned?
6. **Admin ceiling** — can an Admin promote others to Admin, or only manage member↔guest (Owner-only for
   Admin grants)?
7. Anything in the §2.3 matrix to change.

**On ✅ of the above, I'll proceed to the staged apply with full rolled-back boundary proofs + the
isolation re-audit. Until then: nothing applied.**
