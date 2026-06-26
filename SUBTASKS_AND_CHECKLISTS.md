# Subtasks / Checklists — Recon, Design & Feasibility (FOR RATIFICATION)

> **Status: PROPOSAL ONLY. Nothing applied.** No migration, no RLS change, no UI. Recon + design + one
> rolled-back feasibility proof. **Do not implement until Tony picks a data-model option (§2).**
>
> Context: the codebase has a proven **45/45 tenant-isolation audit** + **35/35 role-boundary proof**.
> A new content surface must inherit the parent task's visibility EXACTLY — a Guest sees checklist items
> only on tasks they can see; no cross-role / cross-tenant leak. That requirement drives the whole design.

---

## ⚠️ Headline recon finding — subtasks ALREADY EXIST (as JSONB)

The feature is **half-built already.** `tasks.subtasks` is a live column:

- **DB:** `tasks.subtasks jsonb NOT NULL DEFAULT '[]'` — items are `{ id, title, done }`.
- **UI (already shipped):** the **TaskModal has a "Subtasks" section** (add via input+Enter, toggle done,
  delete) with a `{done}/{total}` count; the **TaskCard shows `{done}/{total} subtasks`**; `AppProvider`
  has `toggleSubtask(taskId, subId)` and the modal has `addSubtask` / `removeSub`.
- **Persistence:** `toggleSubtask` writes the **whole array** back via `updateTask(taskId, { subtasks })`.

**Because subtasks live ON the task row, they already inherit the parent's RLS perfectly and for free** —
a user who can't `SELECT` the task can't see the row at all, so they can't see its subtasks. Guest-scoping,
private-task scoping, and the 45/45 tenant-isolation **already cover subtasks today with zero extra policy.**

So this is **not** "build subtasks from scratch." It's a **data-model decision**: keep enhancing the JSONB,
or promote subtasks to a dedicated table. That decision is §2.

### What's MISSING today (the real gap to close, either way)
- No **reorder** (items are array-order; no drag/move).
- No **progress bar** (only a `3/5` text count).
- A latent **concurrent-edit clobber**: `toggleSubtask` writes the entire array built from a possibly-stale
  snapshot, so two people toggling different items on the same task can lose-update each other (last write
  wins on the whole array). Rare with one editor per task; real on a shared task.
- No per-item metadata (who/when checked), no cross-task querying.

---

## 1. Recon facts (the surface a new table would mirror)

- **`tasks.id` is `text`** (client-generated); `workspace_id uuid` is the only other mandatory column.
  `comments.task_id` / `notifications.task_id` are already `text` FKs — the precedent for a `text task_id` FK.
- **Live task policies** (what visibility/edit must mirror):
  - `tasks_select_role` (SELECT, = `can_see_task`): `is_workspace_member AND (privacy='workspace' OR (privacy='private' AND (created_by=uid OR assignee_id=uid))) AND (workspace_role(ws)<>'guest' OR created_by=uid OR assignee_id=uid)`.
  - `tasks_update_role` / `tasks_delete_role` (EDIT): `is_workspace_member AND (privacy clause) AND (workspace_role_rank(ws)>=2 OR created_by=uid OR assignee_id=uid)` — i.e. **admin+ = any; member/guest = own/assigned**.
- **`private.can_see_task(p_user, p_task)`** already exists (mentions migration) and **mirrors the SELECT
  predicate exactly, including the guest clause.** It's currently only called from DEFINER triggers, so it
  isn't yet granted to `authenticated` (a policy that calls it in the caller's context needs that grant).
- **`comments` already proves the inheritance pattern**: its SELECT policy is `EXISTS(SELECT 1 FROM tasks …)`
  and the audit proved it correctly inherits tasks' RLS. A checklist table can lean on the same idea.

---

## 2. Data-model options (PICK ONE — this is the ratification call)

| | **A. Enhance existing JSONB** | **B. Dedicated `checklist_items` table** | **C. Subtasks-as-tasks** |
|---|---|---|---|
| New schema / RLS | **None** | New table + 4 policies + 1 helper + grant | Big (reuse tasks) |
| Inherits task visibility/guest/tenant-isolation | **Automatic** (it's on the task row) | Via `can_see_task`/`can_edit_task` (proven §3) | Via task RLS but pollutes the board |
| Adds to the 45/45 audit surface | **No** | Yes (one new content table) | Yes |
| Card/board progress (`3/5`) | **Free** (on the task row) | Needs a denormalized counter or extra fetch | Heavy |
| Concurrent-edit safety | ✗ whole-array clobber | **✓ row-level** | ✓ |
| Per-item position / timestamps / querying | ✗ | **✓** | ✓ (overkill) |
| Migration of existing data | None | One-time JSONB→rows backfill | None |
| App work | Reorder + progress bar (add/toggle/remove exist) | Rewire to a table API + reorder + progress + card counter | Large |

**C (subtasks-as-tasks) is rejected for v1** — each subtask becoming an assignable/schedulable task
complicates the board, notifications, and guest-visibility for no v1 benefit. Not recommended.

### My recommendation: **A (enhance the JSONB) for v1**, B as a ready-to-ratify v2 upgrade

For the stated v1 — "checkable steps" — the JSONB **is** the lightweight checklist, and it already nails the
hardest requirement (inherits the parent's visibility/guest-scoping/tenant-isolation with **zero new RLS and
zero new audit surface**). It keeps the board progress free and matches every adjective in the brief (simple,
low-risk, doesn't complicate views/guest-visibility). The only real downside — concurrent-edit clobber — is
**mitigable app-side** (re-read-and-merge on toggle, or send a per-item patch) without a table.

**Choose B (the table) instead if** you want real concurrent-edit safety, per-item ordering/timestamps, and a
normalized foundation for future per-item features (assignee, due-on-step) — i.e. if checklists are meant to
grow into "genuine task-management depth" rather than stay simple. B is fully designed and **proven (10/10,
§3)** below, so it's ready to apply on your word. The cost is a new content surface to secure + re-audit and a
one-time backfill of the existing JSONB items.

> Honest summary: **A is the lower-risk, faster, security-minimal path that fits the current code; B is the
> more durable, concurrency-safe foundation at the cost of a new RLS surface.** Pick based on whether
> concurrent editing / per-item growth matters to you for v1.

---

## 3. Option B — exact schema + RLS (designed; proven rolled-back)

```sql
-- write-side visibility helper for an ARBITRARY user, mirroring tasks_update/delete_role exactly
create function private.can_edit_task(p_user uuid, p_task text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tasks t where t.id = p_task
    and exists (select 1 from public.workspace_members wm where wm.workspace_id=t.workspace_id and wm.user_id=p_user)
    and (t.privacy='workspace' or (t.privacy='private' and (t.created_by=p_user or t.assignee_id=p_user)))
    and (private._role_rank(coalesce((select wm2.role from public.workspace_members wm2
            where wm2.workspace_id=t.workspace_id and wm2.user_id=p_user),'')) >= 2
         or t.created_by=p_user or t.assignee_id=p_user));
$$;
revoke all on function private.can_edit_task(uuid,text) from public, anon;
grant execute on function private.can_edit_task(uuid,text) to authenticated;
grant execute on function private.can_see_task(uuid,text) to authenticated;   -- now used in a caller-context policy

create table public.checklist_items (
  id           uuid primary key default gen_random_uuid(),
  task_id      text not null references public.tasks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,  -- stamped from the task
  label        text not null,
  is_done      boolean not null default false,
  position     double precision not null default 0,   -- fractional => O(1) reorder between neighbours
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
create index checklist_items_task_id_idx on public.checklist_items(task_id);

-- workspace_id is stamped from the PARENT TASK (not the inserter's membership), so it always matches.
create function public.set_checklist_workspace() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.workspace_id is null then
    select t.workspace_id into new.workspace_id from public.tasks t where t.id = new.task_id;
  end if; return new;
end; $$;
revoke all on function public.set_checklist_workspace() from public, anon, authenticated;
create trigger set_checklist_workspace before insert on public.checklist_items
  for each row execute function public.set_checklist_workspace();

alter table public.checklist_items enable row level security;
-- SELECT = can SEE the parent task (guest gets own/assigned automatically)
create policy checklist_items_select on public.checklist_items for select to authenticated
  using (private.can_see_task((select auth.uid()), task_id));
-- INSERT/UPDATE/DELETE = can EDIT the parent task (member/guest own-assigned, admin+ any)
create policy checklist_items_insert on public.checklist_items for insert to authenticated
  with check (private.can_edit_task((select auth.uid()), task_id));
create policy checklist_items_update on public.checklist_items for update to authenticated
  using (private.can_edit_task((select auth.uid()), task_id))
  with check (private.can_edit_task((select auth.uid()), task_id));
create policy checklist_items_delete on public.checklist_items for delete to authenticated
  using (private.can_edit_task((select auth.uid()), task_id));
grant select, insert, update, delete on public.checklist_items to authenticated;
```

**Why this inherits guest-scoping instead of reimplementing it:** SELECT delegates to `can_see_task` and
writes to `can_edit_task`, which are the *same predicates* the live task policies use (including the guest
`role<>'guest' OR own/assigned` clause). Change the task rule once and the checklist follows — no duplicated
guest logic, no separate code path to drift.

### Feasibility proof (rolled back — live DB untouched, re-verified)
Built the table + helpers + RLS in a transaction, seeded a throwaway workspace (member VA · owner Ahmed ·
guest qassemmenna · **outsider** Tony not a member) with four tasks (own-private, workspace-shared,
other-member-private, guest-assigned) and one item each, impersonated each user (`set local role
authenticated` + jwt `sub`), then `RAISE`d to roll back:

```
[member] SELECT own-private items   -> 1  [PASS]
[member] INSERT on own task         -> ok       [PASS]
[member] SELECT shared-task items   -> 1  [PASS]   (sees shared)
[member] INSERT on shared not-own   -> blocked 42501  [PASS]   <- edit rule (member ≠ creator/assignee)
[member] SELECT other-priv items    -> 0  [PASS]   (cannot see another member's private)
[guest]  SELECT assigned items      -> 1  [PASS]
[guest]  INSERT on assigned task    -> ok       [PASS]
[guest]  SELECT shared-task items   -> 0  [PASS]   (guest scoped out of shared)
[guest]  INSERT on shared task      -> blocked 42501  [PASS]
[outsider] SELECT ALL items         -> 0  [PASS]   (non-member sees nothing)
---- 10 / 10 PASS, rolled back; checklist_items + can_edit_task absent and can_see_task grant reverted afterward ----
```

This proves the one-boundary requirement (Member/Guest read+write on a task they can see; 0 rows / 42501 on
one they can't; outsider sees nothing) for **both** roles. The full apply would additionally prove every
remaining boundary (admin = any; update/delete; the workspace_id stamp) **and re-run the full 45/45 isolation
audit** with the new table added as a content surface.

---

## 4. Role composability (confirmed by §3)

- **Member** edits checklist items on **own/assigned** tasks only (matches the tightened task-edit rule);
  can *see* items on any workspace-shared task they can see, but **cannot add/check/delete** there.
- **Admin / Owner** (`rank>=2`): edit checklist items on **any** task in the workspace.
- **Guest**: sees + edits checklist items **only on their own/assigned tasks** — never on workspace-shared or
  other members' tasks (proven: 0 rows + 42501).
- **Cross-tenant**: both helpers require `is_workspace_member(p_user)`, so a non-member sees nothing and can
  write nothing — the new table doesn't widen the 45/45 surface beyond what tasks already expose.

(All of the above is **automatic** in Option A, since items are part of the task row.)

---

## 5. Progress display + UI plan (same for A or B)

- **Task card:** keep the existing `{done}/{total}` and add a slim progress bar (e.g. a 2px violet fill).
  *Free in A* (counts are on the task). *In B*, the card needs the counts — either a denormalized
  `checklist_done/checklist_total` on `tasks` (kept in sync by a trigger on `checklist_items`) or a
  batched count fetch for the visible board. (This counter overhead is a real point in A's favour.)
- **Task modal (the "Subtasks"/"Checklist" section, already present):**
  - **Add** (input + Enter) — exists.
  - **Toggle done** (checkbox) — exists; in A, harden against the clobber (re-read-merge or per-item patch).
  - **Delete** — exists.
  - **Reorder** — NEW: drag handles or up/down; A reorders the array, B writes `position` (fractional).
  - **Progress bar + `3/5 done`** — NEW header in the section.
- **Realtime:** A already syncs (a subtask toggle is a `tasks` UPDATE → existing tasks realtime). B would add
  `checklist_items` to the realtime publication (REPLICA IDENTITY FULL for filtered DELETE) for per-item sync.
- **Roles in UI:** the checklist controls are **read-only when the user can't edit the task** (member on a
  shared task they don't own; guest on anything not theirs) — gate on the same `canEditTask` the modal
  already needs for the task fields, so it's one check, not a new one.

---

## RATIFICATION CHECKLIST (what I need before any apply)

1. **Data model** — **A (enhance JSONB, recommended v1)** or **B (dedicated `checklist_items` table)**?
   (C is not recommended.)
2. If **B**: OK to **backfill** existing `tasks.subtasks` JSONB into `checklist_items` and then retire the
   JSONB column (or keep it dual-written for a transition)?
3. **Reorder** — include drag-reorder in v1, or ship add/toggle/delete + progress bar first?
4. **Member edit scope on checklist items** — confirm it should match the **task edit rule** (own/assigned for
   member/guest; admin+ any), i.e. a member viewing a shared task they don't own sees the checklist
   **read-only**. (That's what §3 proves.)

**On your pick, I'll proceed to the staged apply** — for **B**: idempotent migration, prove every remaining
boundary rolled-back, re-run the full 45/45 isolation audit (new surface), add the migration file, then build
the UI; for **A**: app-only (reorder + progress bar + clobber-hardening), no DB change. **Until then: nothing
applied.**
