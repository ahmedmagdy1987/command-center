# Task Notifications & Activity — Recon, Design & Feasibility (FOR RATIFICATION)

> **Status: PROPOSAL ONLY. Nothing applied.** No migration, no RLS change, no UI. Recon + design +
> one rolled-back feasibility proof. **Do not implement until Tony ratifies** (esp. the @mention
> design). Notifications must respect the shipped role system (owner/admin/member/guest) and the
> clean 45/45 tenant-isolation audit.

---

## ⚠️ Headline recon finding (changes the framing)

The premise was "only DMs notify; core task events don't notify at all." **The DB says otherwise:**
the task event triggers **already exist, are attached, and are role-safe** —

| Trigger (live) | Fires | Notifies | type |
|---|---|---|---|
| `notify_on_task_assigned` | AFTER INSERT/UPDATE OF assignee on `tasks` | the **assignee** (unless assignee = actor) | `task_assigned` |
| `notify_on_task_completed` | AFTER UPDATE on `tasks` | the **creator** (on →done by someone else) | `task_completed` |
| `notify_on_comment_added` | AFTER INSERT on `comments` | distinct **{creator, assignee}** minus the comment author | `comment_added` |
| `notify_on_dm_message` | AFTER INSERT on `dm_messages` | the other DM **participant** | `dm_received` |

**Why it *looks* like only DMs notify:** the live data has only **`dm_received` rows (10)** and **zero**
task notifications — because WS1's tasks are almost all **self-assigned** (Tony → Tony), and the assign
trigger deliberately skips when `assignee = actor`. So the mechanism is sound; it just hasn't fired for
the current data. **I proved the assignment path works end-to-end below (9/9).**

**So the actual new work is narrower than it looked:** events 1/2/4 are **done + role-safe** (verify,
don't rebuild). The genuine gaps are **(3) @mentions** (net-new) and **(5) due-soon/overdue** (time-based
→ scheduler).

---

# PHASE 1 — RECON (facts)

## 1.1 `notifications` table
- Cols: `id uuid pk`, `workspace_id uuid NULL → workspaces`, `recipient_id uuid NOT NULL → auth.users
  ON DELETE CASCADE`, `actor_id uuid NULL → auth.users SET NULL`, `task_id text NULL → tasks ON DELETE
  CASCADE`, `ref_id text NULL` (polymorphic — e.g. a DM conversation id), `type text NOT NULL`,
  `title text NULL`, `message text NOT NULL`, `read bool default false`, `created_at`.
- **`type` has NO CHECK constraint** → adding `mention` / `due_soon` / `overdue` is transition-safe.
- **RLS** (recipient-only): SELECT/UPDATE/DELETE all `recipient_id = auth.uid() AND
  is_workspace_member(workspace_id)`. **No INSERT policy and no INSERT grant** → rows come ONLY from the
  SECURITY DEFINER triggers. `authenticated` has SELECT/UPDATE/DELETE. ✅ A user can read only their own.
- Set-workspace trigger present (BEFORE INSERT) for any null-workspace insert.

## 1.2 Existing notify triggers
All four are `SECURITY DEFINER`, `search_path=''`, EXECUTE-revoked, and stamp `workspace_id` from the
source row. Critically, **all are participant-targeted** (assignee / creator / comment-participants /
DM-participant) — never "all workspace members" — which is what makes them inherently role-safe (§2.2).

## 1.3 The bell UI (`NotificationBell`, VisualTaskCommandCenter.jsx)
- Renders each notification's `title` + `message`; realtime INSERT subscription is **recipient-filtered**
  (`recipient_id=eq.<uid>`) + current-workspace check; mark-read, clear-all, per-row delete, toasts.
- **Deep-link already type-aware:** `dm_received` → open the DM (`refId` = conversation); **otherwise →
  `openTask(n.taskId)`**. So task notifications already route correctly the moment they exist; only a new
  `mention`-in-chat case would need a small addition (open `#Team`).

## 1.4 Task/comment model + mentions
- `tasks`: `assignee_id uuid`, `created_by uuid`, **`due_date timestamptz NULL`**, `title`, `workspace_id`,
  `privacy`, `status`. `tasks.id` is TEXT.
- `comments`: `id`, `task_id text NOT NULL`, `author_id`, `body text NOT NULL`, `workspace_id`. Comments
  exist and are RLS-gated to task visibility.
- **No @mention anywhere** — no parsing, no mentions column, no mention notification. Net-new.

---

# PHASE 2 — PROPOSAL (ratify before any apply)

## 2.1 Event set — who's notified, dedupe, copy

| # | Event | Status | Recipient(s) | Dedupe | Copy (title — message) |
|---|---|---|---|---|---|
| 1 | Task assigned/reassigned to you | **exists** | the assignee (≠ actor) | one per assignee change | "Assigned to you" — *“**{actor}** assigned you “{title}”.”* |
| 2 | Comment on a task you created/are assigned to | **exists** | {creator, assignee} − author | distinct; self-assigned → one | "New comment" — *“**{actor}** commented on “{title}”.”* |
| 4 | A task you created was completed | **exists** | the creator (≠ actor) | one per →done transition | "Task completed" — *“**{actor}** completed “{title}”.”* |
| 3 | **@mention** of you (comment or team chat) | **NEW** | each mentioned user **who can see the surface** | supersedes #2 for a mentioned participant | "Mentioned you" — *“**{actor}** mentioned you in {a comment on “{title}” \| #Team}.”* |
| 5 | **Due soon / overdue** (your assigned tasks) | **NEW, time-based** | the assignee | once per task per threshold (no repeat spam) | "Due tomorrow"/"Overdue" — *““{title}” is {due tomorrow \| overdue}.”* |

*Copy note:* events 1/2/4 currently use generic copy ("New comment on …") with no actor name. The table
above enriches them with **{actor}** (a `members` lookup in the trigger). Adopting the richer copy is a
small optional change to the three existing functions — confirm if you want it, else leave as-is.

## 2.2 Role & tenant safety (critical)

**Events 1/2/4/5 are inherently role-safe** because the recipient is always a **task participant**
(assignee or creator). Under the role system, a participant can always see that task — including a
**Guest**, whose visibility is *exactly* "tasks I created or am assigned to." So a Guest only ever gets
notified about their own/assigned tasks; a member/admin only about tasks they're a party to. The
notification body carries only the task **title**, which the recipient can already see. **No
cross-role or cross-tenant content leak.** (Proven for assignment below; same shape for the others.)

**Event 3 (@mention) is the ONE that needs an explicit per-recipient visibility gate** — you must not
notify someone about a surface they can't see:
- **Comment mention:** notify the mentioned user only if they can **see the task** — i.e. they're a
  member AND (the task is workspace-shared **or** they are its creator/assignee), and if they're a
  **guest**, ONLY if creator/assignee = them. (Evaluated for the *mentioned* user's role, not the actor's.)
- **Team-chat mention:** notify only **non-guest members** (guests are excluded from team chat — Option B).
- **DM mention:** the only other party is the conversation partner (already covered by `dm_received`) →
  **skip** DM mentions.
- A mention of a **non-member** (or someone who can't see the surface) is **silently dropped**.

**Tenant safety:** every notification stamps `workspace_id` from the source row; the notifications RLS
(`recipient_id = auth.uid() AND is_workspace_member(workspace_id)`) is **already correct and unchanged** —
a user reads only their own rows, and only while still a member. No RLS change needed.

## 2.3 @mention design (the key decision)

**Encoding — recommend an explicit `mentions uuid[]` column** (default `'{}'`) on `comments` and
`messages`, populated by the client from an **@-picker** of workspace members (so it's exact user-ids, not
fragile name-parsing). The notify path reads `NEW.mentions` and, per id, inserts a `mention` notification
**iff** that id passes the §2.2 visibility gate, **deduped** against the participant notification (a
mentioned creator/assignee gets ONE `mention`, not also `comment_added`).

- **Surfaces:** comments + team chat. **Skip DMs** (redundant). *(Your call.)*
- **Validation in the trigger:** drop non-members; for chat drop guests; for comments drop those who
  can't see the task.
- **Shape:** new `mentions uuid[]` columns; a `notify_on_mention` path (a new trigger on `messages`, and
  an extension to `notify_on_comment_added` or a sibling trigger on `comments`). DEFINER, `search_path=''`,
  EXECUTE-revoked — same exemplar as the existing four.

## 2.4 Delivery
- **In-app bell first** — it already renders + realtime-subscribes + deep-links task notifications, so
  events 1/2/4 light up the moment they fire; `mention` needs only a small `handleOpen` case (comment
  mention → `openTask`; chat mention → open `#Team`).
- **Email = deferred (flagged).** Real email needs a custom **SMTP** provider + templates + an
  unsubscribe/preference model; out of scope here. Ship in-app, add email as a separate track.

## 2.5 Event-based vs time-based (recommended split)
- **Ship now — event-based (1–4):** plain AFTER triggers; 1/2/4 already live, `mention` is the only new
  trigger. Deterministic, no scheduler.
- **Follow-up — time-based (5, due-soon/overdue):** needs a **scheduler** (Supabase **`pg_cron`**). Shape:
  a DEFINER function runs every ~15–30 min, scans `tasks` with an assignee and `due_date` crossing a
  threshold (e.g. within 24h, or now past due), inserts `due_soon`/`overdue` for the assignee, **deduped**
  via a per-task marker (a `due_notified_at` column or an existence check) so it fires once, not every run.
  Recommend shipping **event-based first**, due-date reminders as a fast follow.

## 2.6 DB shape (when ratified)
- **Types:** reuse `task_assigned`/`task_completed`/`comment_added` (exist); add `mention` now,
  `due_soon`/`overdue` later. (`type` has no CHECK — additive + safe.)
- **Columns:** `comments.mentions uuid[] default '{}'`, `messages.mentions uuid[] default '{}'`.
  (Time-based later: `tasks.due_notified_at timestamptz` for dedup.)
- **Functions/triggers:** `notify_on_mention` (messages) + comment-mention path; all DEFINER/`''`/revoked.
  Optional: enrich the three existing copies with the actor name.
- **RLS:** notifications — **no change** (already recipient-only). New `mentions` columns ride the
  existing comments/messages RLS.
- **Grants/realtime:** notifications already realtime-published + recipient-subscribed; new types flow
  through with no change.

---

# PHASE 3 — FEASIBILITY PROOF (done, rolled back)

Proved the **assignment event end-to-end on the LIVE trigger** (no DDL needed — the mechanism exists),
with full role/tenant + RLS coverage, in a throwaway workspace (A=owner/actor, B/C=members, G=guest,
O=outsider), force-rolled-back:

```
==== TASK-ASSIGNED NOTIFICATION FEASIBILITY (rolled back) ====
PASS  assign -> exactly ONE notification created (only B)
PASS  notification: recipient=B, type=task_assigned, ref=task, workspace+actor stamped
PASS  [RLS] B reads their own notification (1)
PASS  [RLS] other member C reads 0 (recipient-scoped)
PASS  [RLS] outsider reads 0
PASS  guest assigned -> notified for their OWN assigned task
PASS  [RLS] guest reads their own notification (1)
PASS  self-assign -> no notification (assignee==actor)
PASS  reassign B->C -> fresh notification for C
---- RESULT: 9 passed / 0 failed ----
```
**Rollback verified clean** (throwaway workspace/tasks/notifications all gone; total notifications still
10). This validates the foundation and the harness. The **new `mention` trigger** will be proven the same
way at apply — specifically the visibility gate: *guest mentioned in team chat → NOT notified; guest
mentioned in a comment on their own task → notified; non-member mention → dropped* — plus a full
isolation re-audit, before anything ships.

---

# RATIFICATION CHECKLIST (what I need before any apply)

1. **Keep events 1/2/4 as-is** (they exist + are role-safe), or enrich their copy with the **actor name**?
2. **@mention encoding:** explicit **`mentions uuid[]`** column (recommended) vs `@name` parsing?
3. **@mention surfaces:** comments **+ team chat**, **skip DMs** — confirm?
4. **@mention visibility rules** (guest excluded from chat mentions; comment mention gated by task
   visibility; non-members dropped) — confirm?
5. **Dedup:** a `mention` supersedes a `comment_added` for the same recipient on the same comment — confirm?
6. **Due-soon/overdue:** defer to a **pg_cron** follow-up (ship event-based first) — confirm?
7. **Email:** deferred (in-app first) — confirm?

**On ✅, I'll apply staged + idempotent, prove every new path rolled-back (esp. the mention visibility
gate), re-run the 45/45 isolation audit, then extend the bell. Until then: nothing applied.**
