# Due-Date Reminders — Recon, Design & Feasibility (FOR RATIFICATION)

> **Status: PROPOSAL ONLY. Nothing applied.** No migration, no RLS change, no scheduler, no UI. Recon +
> design + one rolled-back feasibility proof. **Do not implement until Tony ratifies (§2).**
>
> This completes the notification system — making it **proactive** (due soon / overdue) instead of only
> reactive. It's the time-based piece explicitly deferred in `NOTIFICATIONS_AND_ACTIVITY.md` (§2.5). It
> must respect the role system (owner/admin/member/guest), guest task-visibility, and the proven 45/45
> tenant-isolation.

---

## 1. Recon findings

### 1.1 Scheduler availability — the feature hinges on this ✅
| Extension | Available? | Installed? |
|---|:--:|:--:|
| **`pg_cron`** (job scheduler) | **YES** (default 1.6.4) | **No** (not yet enabled) |
| `pg_net` (async HTTP) | yes (0.20.0) | no |
| `http` | yes (1.6) | no |
| `pgmq` | yes (1.5.1) | no |

**`pg_cron` is available and can be enabled** (`create extension pg_cron`). That's the clean mechanism:
schedule an **in-DB SECURITY DEFINER function** directly — **no Edge Function, no `pg_net`, no HTTP
endpoint, no service-role secret**. The job runs inside Postgres, inserts notification rows via a DEFINER
function (exactly like the existing notify triggers), and never leaves the DB. *(A scheduled Edge Function
hitting a DEFINER RPC via `pg_net` is the fallback if pg_cron were unavailable — it isn't, so we don't need
that complexity or its secret-management surface.)*

### 1.2 `due_date` storage + timezone
- `tasks.due_date` is **`timestamptz`** (nullable); so are `scheduled_date`, `completed_at`. `now()` is UTC.
- The app stores **date-only** due dates anchored at **local-noon**: the modal does
  `new Date('YYYY-MM-DD' + 'T12:00:00').toISOString()`, i.e. noon-of-day in the user's local zone, stored as
  UTC. So a "due 2026-07-01" is a real instant (~noon local) — comparisons are unambiguous timestamp math.
- **Currently 0 of 28 tasks carry a `due_date`** — the feature is dormant until users start setting them
  (so it won't retro-spam; it begins firing as due dates appear).

### 1.3 `notifications` — a new type slots in with no schema/RLS change
- Cols: `id, recipient_id, actor_id, task_id text, ref_id text, type text, title, message, read, workspace_id, created_at`.
- **`type` has NO CHECK** → adding `due_soon` / `overdue` is additive + safe (no constraint change).
- **No INSERT policy / no INSERT grant** → rows come ONLY from SECURITY DEFINER code. The reminder job's
  DEFINER function inserts directly (bypassing RLS/grants), same as the four notify triggers.
- **RLS = recipient-only** (`recipient_id = auth.uid() AND is_workspace_member(workspace_id)`) for
  SELECT/UPDATE/DELETE — **unchanged**; a user reads only their own, only while a member.
- **Bell deep-link already handles it:** `NotificationBell` routes `dm_received` → the DM, **everything else
  → `openTask(n.taskId)`**. `due_soon`/`overdue` carry `task_id`, so clicking opens the task **with zero UI
  change** (an optional icon-per-type is the only nicety to add later).

---

## 2. Proposal (ratify before any apply)

### 2.1 Events + thresholds (recommended)
| Event | Condition | Recipient | Copy |
|---|---|---|---|
| **`due_soon`** | `due_date > now()` AND `due_date <= now() + 24h`, `status<>'done'`, has assignee, not yet reminded | the **assignee** | "Due soon" — *"\"{title}\" is due within a day."* |
| **`overdue`** | `due_date <= now()`, `status<>'done'`, has assignee, not yet at the overdue stage | the **assignee** | "Overdue" — *"\"{title}\" is overdue."* |

- **Two reminders max per task**, one of each kind: a task crosses into the 24h window → `due_soon`; later
  crosses `now()` → `overdue`. Proven below (the `r-progress` case: due_soon → overdue).
- **Same-day morning reminder? — recommend NO for v1.** A "9am your time" nudge needs **per-user
  timezones**, which we don't store; it'd add a third stage and a TZ model. Defer until we capture user TZ.
- **Schedule: hourly** (`0 * * * *`). Due dates are day-granularity (noon-anchored), so hourly catches the
  24h-window / overdue crossings within an hour — plenty fresh, lightest load. Trivially tunable to 15–30 min.

### 2.2 Recipient = the assignee only (and what about unassigned)
- **Assigned task → the assignee, and ONLY the assignee.** By construction this is leak-proof: the assignee
  can *always* see their assigned task (the task SELECT rule is `private = creator OR assignee`, and the guest
  rule is `creator/assignee`). The body carries only the **title**, which they can already see. So a reminder
  never reaches anyone who couldn't see the task — no cross-role, cross-tenant, or guest leak (§2.3).
- **Unassigned task → recommend SKIP in v1.** No assignee = no clear owner of the deadline; reminding the
  creator of every unassigned overdue task risks noise (a manager who files many unassigned tasks). Unassigned
  overdue work is better surfaced on the **dashboard** than as a personal ping. *(Easy alternative if you
  prefer: also notify `created_by` for unassigned tasks — the creator can see the task, so it's equally
  leak-safe. One-line change. Your call.)*

### 2.3 Role & tenant safety (by construction)
- **Guest assignee:** a guest's visibility is *exactly* "tasks I created or am assigned to," so their assigned
  task is visible → reminding them is correct and leak-free (**proven**: `r-guest` → the guest got their own
  `due_soon`, and no one else did).
- **Member / Admin / Owner assignee:** all can see a task assigned to them → safe.
- **`workspace_id` stamped from the task**, so the recipient-only RLS (`recipient_id = auth.uid() AND
  is_workspace_member`) is correct and **unchanged**. Other members and outsiders read **0** (proven).
- **No notifications RLS change.** Reminders are a new *type*, not a new surface — they ride the existing
  recipient-only policy. The apply will still re-run the full **45/45 isolation audit** to prove the new rows
  don't widen any read path.

### 2.4 Dedupe — the one small column needed (FLAGGED DB change)
A scheduled job must not re-send every hour. **Recommended: a single marker column**

```sql
alter table public.tasks add column due_reminder_stage text not null default 'none';
        -- 'none' -> 'due_soon' -> 'overdue', monotonic; one reminder fires per stage transition
```

- The job only picks `stage='none'` for due_soon (→ sets `'due_soon'`) and `stage<>'overdue'` for overdue
  (→ sets `'overdue'`), so each kind fires **exactly once**. (Proven: re-running the job created **0**
  duplicates — `4 -> 4`.)
- **Reschedule re-arms** via a tiny BEFORE-UPDATE trigger that resets the stage when `due_date` changes, so
  editing a due date lets the reminders fire again (proven: changing `due_date` reset stage to `'none'`):

```sql
create function public.reset_due_reminder_stage() returns trigger language plpgsql as $$
begin
  if new.due_date is distinct from old.due_date then new.due_reminder_stage := 'none'; end if;
  return new;
end; $$;
create trigger reset_due_reminder_stage before update on public.tasks for each row
  execute function public.reset_due_reminder_stage();
```

*(Alternative considered: dedupe by an existence-check against `notifications` rows — rejected: it can't tell
the two stages apart cleanly and mishandles due-date edits. The one column is simpler and self-documenting.
A two-timestamp variant — `due_soon_notified_at` / `overdue_notified_at` — is equivalent but adds a column;
the single stage is the minimal choice.)*

### 2.5 Scheduler design
```sql
-- the job body: one DEFINER function, search_path='', EXECUTE revoked (cron calls it, clients can't)
create function private._run_due_reminders() returns void
language plpgsql security definer set search_path = '' as $$
begin
  with picked as (                                   -- DUE SOON
    update public.tasks set due_reminder_stage = 'due_soon'
    where assignee_id is not null and status <> 'done' and due_reminder_stage = 'none'
      and due_date is not null and due_date > now() and due_date <= now() + interval '24 hours'
    returning id, assignee_id, workspace_id, title
  )
  insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
  select assignee_id, null, id, 'due_soon', 'Due soon',
         '"'||coalesce(title,'Untitled')||'" is due within a day.', workspace_id from picked;

  with picked as (                                   -- OVERDUE
    update public.tasks set due_reminder_stage = 'overdue'
    where assignee_id is not null and status <> 'done' and due_reminder_stage <> 'overdue'
      and due_date is not null and due_date <= now()
    returning id, assignee_id, workspace_id, title
  )
  insert into public.notifications (recipient_id, actor_id, task_id, type, title, message, workspace_id)
  select assignee_id, null, id, 'overdue', 'Overdue',
         '"'||coalesce(title,'Untitled')||'" is overdue.', workspace_id from picked;
end; $$;
revoke all on function private._run_due_reminders() from public, anon, authenticated;

-- the schedule (hourly)
create extension if not exists pg_cron;
select cron.schedule('due-date-reminders', '0 * * * *', $$ select private._run_due_reminders(); $$);
```
- **Updating-CTE pattern** = atomic per kind: the `UPDATE … RETURNING` claims the rows (sets the stage) and
  feeds the exact same rows to the `INSERT`, so there's no double-count and no read-then-write race.
- `actor_id = null` (it's a system reminder, no human actor). `title`/`message` carry only the task title.
- The function is DEFINER so it inserts notifications (which have no client INSERT grant); EXECUTE is revoked
  from everyone — only the cron job (running as the scheduling role) invokes it.

### 2.6 Timezone handling
All comparisons are **UTC `timestamptz` math** (`due_date`, `now()`): unambiguous, no per-row TZ logic. Because
date-only due dates are anchored at **local-noon** (stored UTC), "due within 24h" and "overdue" land
sensibly on the intended day. A true per-user "morning" reminder would need stored user timezones — deferred
(see §2.1).

### 2.7 Copy + bell
- Copy as in §2.1. Deep-link needs **no bell change** — `due_soon`/`overdue` carry `task_id`, and the bell
  already opens the task for any non-DM type. (Optional polish later: a clock/alarm icon per type.)

---

## 3. Feasibility proof (done — 11/11 PASS, rolled back)

Built the column + `_run_due_reminders()` + the reset trigger in a transaction, seeded a throwaway workspace
(assignee **VA**=member · **Ahmed**=owner/other-member · **qassemmenna**=guest · **Tony**=outsider) with eight
tasks spanning every case, ran the job (twice, for dedupe), impersonated each user for RLS, then `RAISE`d to
roll back:

```
due_soon created (r-soon + r-guest)     -> 2  [PASS]
overdue created (r-over + r-progress)   -> 2  [PASS]
done/far/already/unassigned reminders   -> 0  [PASS]   (correctly skipped)
r-progress stage due_soon -> overdue    -> overdue  [PASS]   (two-stage progression)
guest assignee got their own due_soon   -> 1  [PASS]
re-run does NOT duplicate (dedupe)      -> 4 -> 4  [PASS]
[RLS] assignee VA reads own reminders   -> 3  [PASS]
[RLS] other member Ahmed reads          -> 0  [PASS]   (recipient-only)
[RLS] guest reads own reminder          -> 1  [PASS]
[RLS] outsider Tony reads               -> 0  [PASS]
reschedule resets stage to none         -> none  [PASS]   (due-date change re-arms)
---- 11 / 11 PASS, rolled back; column + function + trigger absent and 0 due-notifications afterward ----
```

This proves the core query, the **dedupe**, the **two-stage progression**, the **skip rules** (done / not-in-
window / already-reminded / unassigned), the **guest-assignee** path, and **recipient-only RLS** (other member
and outsider see nothing). The full apply will additionally verify the live `pg_cron` schedule runs the
function, prove the reset trigger end-to-end on the live shape, and **re-run the full 45/45 isolation audit**
(reminders are a new notification surface — prove no leak) before anything ships.

---

## RATIFICATION CHECKLIST (what I need before any apply)

1. **Events + thresholds** — `due_soon` (within 24h) + `overdue` (past due), assignee-only, as above?
2. **Same-day morning reminder** — skip for v1 (needs per-user TZ), confirmed?
3. **Unassigned tasks** — **skip** (recommended), or also notify `created_by`?
4. **Dedupe** — the single `tasks.due_reminder_stage` column + reset-on-reschedule trigger (the flagged DB
   change), confirmed? (Or prefer the two-timestamp variant?)
5. **Schedule** — **hourly** `pg_cron`, confirmed? (or 15–30 min)
6. **Scheduler mechanism** — enable **`pg_cron`** + an in-DB DEFINER function (recommended), confirmed? (vs a
   scheduled Edge Function — not needed.)
7. **Copy** — "Due soon / Overdue" wording as above, or tweak?

**On your ✅, the apply will:** enable `pg_cron`; add the `due_reminder_stage` column + reset trigger; add the
DEFINER `_run_due_reminders()`; schedule it; prove every path rolled-back; **re-run the 45/45 isolation audit**;
add the migration file; then (optionally) a bell icon for the new types. **Until then: nothing applied.**
