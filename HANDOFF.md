# HANDOFF — UX batch (part 3) — as of 2026-07-16

> Orientation for resuming the UX batch. Everything is on **`feat/ux-batch-part3`** — **nothing is merged
> to `main`** and (as of this handoff) the batch's DB migrations are **designed + proven but NOT yet applied**.
> The Supabase DB is safe in the cloud; local code is not (Deep Freeze) — after a wipe follow
> [`RESTORE.md`](RESTORE.md) first, then read this.

## Branch topology (nothing merged to `main`)

| Branch | What's on it | Status |
|--------|--------------|--------|
| **`main`** | production (Vercel auto-deploys from it). Untouched by this batch. | live |
| **`feat/ux-batch-part3`** | the UX batch — committed work (below) + the pending items 1–5. | working tip |

**Committed on the branch** (tip `0c96e41`): waveform voice notes + one default avatar (`9cca0f0`); members
identity-column lock + orphan-sweep age guard (`2684b6e`); roles-docs correction + committed isolation/role
proofs (`a4a008a`); guest-can't-board-workspace-tasks fix (`eabdf1f`); DM delete-for-me hides + monotonic read
cursor + tasks jsonb server-side hardening (`0c96e41`).

## The UX batch — items 1–5 (designed + PROVEN via rolled-back proofs; awaiting apply)

All DB work was proven with `begin; … rollback;` proofs against the live DB (harness guard + anti-vacuity
guard + completeness guard; adversarially re-verified). **Nothing applied yet.**

1. **Project delete — cascade / unassign** (`public.delete_project` RPC). cascade (delete tasks + project) =
   **owner-only (rank 3)** + typed-confirm modal; unassign (re-file tasks) = **owner+admin (rank 2)**. Both
   scoped by `workspace_id` (the cross-tenant guard — shared free-text slugs like `personal`/`other`) AND by
   `can_see_task` (GATE A — invisible private tasks untouched at every rank); project-existence guard blocks the
   slug footgun. `projects_delete_admin` kept unchanged (143/143 F10 stays green). **Proof: 29/29** incl. the M8
   "strip workspace_id → RED" demonstration. (`supabase/tests/project_delete_cascade_rolled_back_proof.sql`)
2+3. **Profile + avatar + display_name hardening** (one migration, one roster-RPC recreate). Adds
   `avatar_url`/`bio`/`status_text`/`status_emoji` to `members`; `members_validate_profile` trigger closes the
   role-impersonation hole on `status_text`, `status_emoji`, and `display_name` (fullwidth/mathematical/
   zero-width/spacing/literal role words via `private._looks_like_role_title`); `handle_new_user` sanitizes the
   OAuth-derived name so **signup never fails**; extended `UPDATE` column grant (identity stays locked); roster
   RPC recreated to expose the new fields (guest still gets NULL email+bio + row-scoping). **Proof: 38/38.**
   (`supabase/tests/profile_and_avatar_rolled_back_proof.sql`) **Residuals (documented, out of scope):**
   Cyrillic/Greek confusables + leetspeak (proof W08/W09 assert them allowed); `avatar_url` is https-only and a
   tracking-pixel residual **until the storage-hosted avatars bucket lands in this batch** (then restricted to
   the storage host).
4. **Baseline + ledger-gap files + this HANDOFF** (docs/files only — see *Rebuild gaps* below).
5. **Permanent proof files** — commit the rolled-back proofs for the new surfaces (project delete, profile,
   DM hides, …) into `supabase/tests/` so a future change can't silently regress them.

**Agreed apply order** (re-run **48/48** cross-tenant isolation + **143/143** role-boundary after EACH apply):
**baseline (no-op) → project delete → profile+avatar+display_name recreate → proof files.**

## Rebuild gaps (honest — read before trusting a from-scratch rebuild)

The migration ledger does **not** fully reproduce the DB from zero. Known gaps:

1. **No original baseline `CREATE TABLE` exists.** `tasks` / `projects` / `members` were created directly on
   Supabase **before the ledger began** — no hand-written script was ever written (confirmed with the owner).
   `supabase/migrations/00000000000000_baseline.sql` is a **BEST-EFFORT RECONSTRUCTION** from the live schema,
   rewound to the pre-ledger shape, **honesty-flagged inline** (`«?»`), and **never applied** (no-op live). It is
   NOT a verified artifact — a real from-scratch rebuild must be validated **end-to-end** (DB password + owner
   present). The original base RLS policies are unrecoverable (placeholders provided, superseded by Phase 2/3A).
2. **`rls_auto_enable()` + the `ensure_rls` event trigger** (auto-enables RLS on new public tables) and the
   **original `handle_new_user()`** are also pre-ledger/out-of-band. Their live definitions are exact but were
   never in a migration file; the baseline includes best-effort copies (functions are later `CREATE OR REPLACE`d
   by real migrations, so the final state is correct on replay).
3. **Two ledger entries had no local file — now recovered.** `20260529185644` (the revoke-EXECUTE hardening) and
   `20260529233941` (the **superseded** first version of the notifications migration; the corrected re-apply is
   `…234347`, already in-repo) were pulled **verbatim** from `supabase_migrations.schema_migrations.statements`
   and committed. The remote ledger's `…233941`/`…234347` duplicate is now represented in-repo.

## DB change discipline (unchanged)

Propose SQL → wait for approval → `apply_migration` → verify (preserve per-user baselines; re-run the isolation
+ role proofs; `get_advisors`) → **add the matching file to `supabase/migrations/`** (version from
`list_migrations`) → commit + push. Migrations idempotent. Rolled-back proofs use `begin; … rollback;` with the
`set local role authenticated` + `request.jwt.claims` harness (postgres has `rolbypassrls` — a proof that forgets
the role switch proves nothing; every proof opens with a self-validating harness guard).

## Exact next steps after a wipe

1. [`RESTORE.md`](RESTORE.md): toolchain → clone → git identity/TLS → `npm install` → launch `claude` from inside
   the repo (loads `.mcp.json`) → recreate `.env` → auth the Supabase MCP.
2. `git checkout feat/ux-batch-part3`. Sanity: `npm run build`, `npm run lint`.
3. Resume the UX batch: apply items 1–5 in the agreed order once the owner approves, re-running 48/48 + 143/143
   after each apply. Then the app-side work (project-delete modal + RPC wiring; ProfileModal self-editor +
   `members.updateProfile`; avatars bucket + storage-hosted avatar wiring).

## CLAUDE.md is the durable project guide — this HANDOFF is batch-scoped and disposable.
