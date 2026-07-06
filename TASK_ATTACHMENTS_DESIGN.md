# Task file attachments — recon + design + feasibility proof (2026-07-06)

> **Status: RECON + DESIGN + FEASIBILITY PROOF ONLY. Nothing applied; no UI built. Awaiting approval.**
> Upload/download files (briefs, deliverables, images, docs) on a task — serves the "coordinate
> external freelancers" positioning. Touches storage + a metadata table + RLS; inherits the proven
> voice-notes storage pattern and the existing task visibility/edit predicates (does NOT reimplement
> guest-scoping).
>
> **⚠️ SCHEMA + STORAGE CHANGE REQUIRED** — one new private bucket (`task-attachments`), one new table
> (`public.task_attachments`), 4 helper functions, 1 stamp trigger, 3 table policies, 3 storage-object
> policies. All flagged below; none applied.

---

## Phase 1 — Recon (verified against the live DB)

- **No existing attachment table or field.** `task_attachments` does not exist; the only task
  file-ish column is the unused `tasks.links jsonb` (no render sink — see the audit). No `task-*`
  bucket exists; the only bucket is `voice-notes`.
- **TEXT-FK pattern:** `notifications.task_id → tasks`, `comments.task_id → tasks` (tasks.id is a
  client-generated TEXT PK, globally unique). New table mirrors this: `task_attachments.task_id →
  tasks(id) ON DELETE CASCADE`.
- **voice-notes bucket (the pattern to mirror):** private, 10 MB cap, audio MIME allowlist, path
  `<uid>/<file>`, policies `voice_notes_insert_member` (own-folder + members-row + the L3 rate limit),
  `voice_notes_select_member` (own folder OR referenced by a `messages`/`dm_messages` row in an
  accessible workspace/DM), `voice_notes_delete_own` (own folder). Client: `api.js` `upload` /
  `createSignedUrl(path, 3600)` / best-effort `remove` of orphans; `<audio src={signedUrl}>`.
- **Task visibility/edit predicates to delegate to** (do NOT reimplement):
  - `private.can_see_task(user, task)` already exists — mirrors `tasks_select_role` including the
    guest own/assigned clause. (Currently postgres-only; the apply adds a self-variant, see RLS.)
  - `tasks_update_role` (confirmed): `is_workspace_member(ws) AND (privacy='workspace' OR (private AND
    (uid=created_by OR uid=assignee_id))) AND (workspace_role_rank(ws)>=2 OR uid=created_by OR
    uid=assignee_id)` — this is the "can edit the task" (same gate as the subtask checklist). New
    helper `private.can_edit_task(task)` mirrors it for the current user.
- **UI slot:** `TaskModal` (`VisualTaskCommandCenter.jsx:1332`), below the subtasks (~1444) and
  `TaskComments` (1197) sections.

---

## Phase 2 — Proposed design (for ratification)

### Storage — a NEW private `task-attachments` bucket (recommended over reusing voice-notes)
Separate bucket = a different MIME allowlist, different size cap, and clean, independent policies (the
voice-notes policies stay untouched; storage policies are bucket-gated so the two never interfere).

| Setting | Recommendation | Rationale |
|---------|----------------|-----------|
| privacy | **private** | never publicly listable; all reads via RLS + signed URLs |
| **per-file size cap** | **25 MB** (`26214400`) | deliverables run larger than voice notes (10 MB) but stay cost-bounded |
| **MIME allowlist** | images `png/jpeg/gif/webp`, `application/pdf`, `text/plain`, `text/csv`, `application/zip`, MS/Open-XML office (`doc/docx/xls/xlsx/ppt/pptx`) | briefs/deliverables/images/docs; no executables/svg (svg = XSS vector) |
| **max attachments / task** | **20** | enforced in the metadata INSERT policy |
| **per-workspace quota** | **2 GB** total attachment bytes (and a storage-side object-count cap, see quota) | storage-cost DoS control under public signup, consistent with the L3 voice-note quota |
| **path scheme** | **`<workspace_id>/<task_id>/<uuid>.<ext>`** | tenant + task boundary explicit in the path; the storage INSERT policy gates on it before any metadata row exists |

### Metadata — `public.task_attachments`
```sql
create table public.task_attachments (
  id uuid primary key default gen_random_uuid(),
  task_id text not null references public.tasks(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,  -- STAMPED by trigger
  uploaded_by uuid references auth.users(id) on delete set null,
  storage_path text not null unique,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
```
`workspace_id` is stamped from the parent task by a BEFORE INSERT trigger
`set_attachment_workspace_id()` (SECURITY DEFINER, `search_path=''`, EXECUTE revoked) — authoritative,
so a client can't spoof a mismatched workspace. Metadata is immutable (no UPDATE policy/grant).
Grants: `select, insert, delete` to `authenticated` (least-privilege; the L2 pattern applies).

### RLS — delegate to the task predicates (guest-scoping inherited, never reimplemented)
Two helpers, both SECURITY DEFINER / `search_path=''` / EXECUTE to `authenticated`:
- `private.can_edit_task(task)` — mirrors `tasks_update_role` for `auth.uid()`.
- `private.can_view_task(task)` = `can_see_task(auth.uid(), task)` — a **self-variant** so the existing
  arbitrary-user `can_see_task(user,task)` stays postgres-only (no new visibility-probe surface).

```sql
-- SELECT/download iff the user can SEE the task (inherits privacy + guest own/assigned clause)
create policy task_attachments_select on public.task_attachments for select to authenticated
  using (private.can_view_task(task_id));
-- INSERT iff the user can EDIT the task (member/guest own-assigned, admin+ any — same gate as checklist)
create policy task_attachments_insert on public.task_attachments for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and private.can_edit_task(task_id)
    and private.task_attachment_count(task_id) < 20                                   -- per-task cap
    and private.workspace_attachment_bytes(
          (select t.workspace_id from public.tasks t where t.id = task_id)) < 2147483648  -- 2 GB/ws
  );
-- DELETE iff uploader-own OR admin+
create policy task_attachments_delete on public.task_attachments for delete to authenticated
  using (uploaded_by = (select auth.uid()) or private.workspace_role_rank(workspace_id) >= 2);
```

### Storage object policies (mirror voice-notes; delegate to metadata + task predicates)
```sql
-- download: object readable iff a metadata row references it AND the caller can view the task
create policy task_attach_select on storage.objects for select to authenticated
  using (bucket_id='task-attachments' and exists (
    select 1 from public.task_attachments a where a.storage_path = name and private.can_view_task(a.task_id)));
-- upload (before the metadata row exists): gate on the PATH — member of the ws folder AND can edit the task folder
create policy task_attach_insert on storage.objects for insert to authenticated
  with check (bucket_id='task-attachments'
    and private.is_workspace_member(((storage.foldername(name))[1])::uuid)
    and private.can_edit_task((storage.foldername(name))[2]));
-- delete: uploader-own OR admin+ (via the metadata row)
create policy task_attach_delete on storage.objects for delete to authenticated
  using (bucket_id='task-attachments' and exists (
    select 1 from public.task_attachments a where a.storage_path = name
      and (a.uploaded_by = (select auth.uid()) or private.workspace_role_rank(a.workspace_id) >= 2)));
```
MIME/size limits are enforced by the storage API against the bucket config (not raw SQL). **Anti-abuse
(recommended, mirrors L3):** also add a storage-side per-workspace **object-count** cap in
`task_attach_insert` (count objects under the `<ws>/` prefix) so orphan uploads that skip the metadata
row can't dodge the 2 GB/20-per-task caps.

### UI plan (design only — nothing built)
- **`TaskModal`** gains an "Attachments" section below subtasks/comments.
- **Upload:** button + drag-drop zone; client `api.js attachments.upload(taskId, file)` →
  `storage.from('task-attachments').upload('<ws>/<task>/<uuid>.<ext>')` then insert the metadata row
  (mirrors the voice-note upload-then-row flow, incl. best-effort orphan `remove` on failure).
- **List:** filename · size · uploader (via the roster) · when; image rows show a thumbnail via a
  signed URL; non-images show a file-type icon.
- **Download:** `createSignedUrl(path, 3600)` (or shorter) — bearer link to one object, ≤1 h.
- **Delete:** shown only for the uploader or admin+ (the `ConfirmModal` pattern).
- **Read-only** rendering when `!can edit the task` (member viewing others' tasks, guest on a task they
  can only see): list + download visible, upload/delete hidden — matches the RLS exactly.

---

## Phase 3 — Feasibility proof (all rolled back, all green)

| # | Scenario | Result |
|---|----------|--------|
| A | Delegation: `can_view/can_edit` for every actor × task | **outsider** false/false; **guest** true only on own-assigned (false on workspace-task & others' private — guest-scoping inherited); **member** true on workspace-task, false on others' private; **owner (admin+)** true on any; **trigger** stamps `workspace_id` from parent task ✓ |
| B | **Member** (creator) uploads object + inserts metadata on an editable task, reads back | **ALLOWED** — 1 metadata + 1 object visible |
| C | **Outsider** inserts attachment metadata on a CC task | **BLOCKED** `42501` (task_attachments RLS) |
| D | **Outsider** reads a seeded attachment on a private task | **0** metadata + **0** objects (isolation) |
| E | **Outsider** uploads a storage object into CC's `<ws>/<task>/` path | **BLOCKED** `42501` (objects RLS) |

**Conclusion:** SELECT/download strictly follows `can_see_task` (privacy + guest rules); upload/insert
strictly follows `can_edit_task` (member/guest own-assigned, admin+ any); delete is uploader-own or
admin+; storage paths prevent cross-tenant reads and writes. The design reuses the existing predicates,
so **the full apply will re-run the 45/45 isolation + 35/35 role lines** (attachments delegate to the
same gates — an added surface, not a new predicate).

---

## If approved — apply plan
1. Create the `task-attachments` bucket (private, 25 MB, MIME allowlist).
2. Create `public.task_attachments` + RLS-enable + least-privilege grants.
3. Create helpers (`can_edit_task`, `can_view_task`, `task_attachment_count`,
   `workspace_attachment_bytes`) + grant EXECUTE to `authenticated`, revoke public/anon.
4. Create the `set_attachment_workspace_id` stamp trigger (EXECUTE revoked).
5. Create the 3 table policies + 3 storage-object policies (+ the recommended per-ws object-count cap).
6. Re-run: security advisors, the **45/45 isolation** line, the **35/35 role** line, the per-user
   baseline (unchanged — new surface only).
7. Then (separate pass) build the client: `api.js attachments.*` + the `TaskModal` UI.

## Open items / follow-ups
- Client `api.js attachments.{upload,list,signedUrl,remove}` + the TaskModal UI (next pass, not this).
- **Orphan cleanup:** a pg_cron sweep removing `task-attachments` objects with no metadata row (and
  objects whose task was deleted — metadata cascades, storage objects don't). Mirrors the voice-note
  orphan concern.
- Signed-URL expiry (1 h like voice notes; could tighten). Thumbnails reuse the same signed URL.
- Confirm the storage API MIME/size enforcement is on (bucket config) in addition to the allowlist.

---
*No app code changed in this pass (design doc only) → build/lint stays 31/2. No schema/bucket change applied.*
