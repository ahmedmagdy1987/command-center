# HANDOFF — UX batch (part 3) — as of 2026-07-18

> Orientation for the tail end of the UX batch. **The batch is MERGED and LIVE.** `main` is the
> production branch (Vercel auto-deploys it); the one open item is the owner's in-browser
> verification of the profile/avatar system on production. After a Deep Freeze wipe follow
> [`RESTORE.md`](RESTORE.md) first, then read this.

## Branch topology (everything merged)

| Branch | What's on it | Status |
|--------|--------------|--------|
| **`main`** | tip **`160ee41`** — merge of `feat/ux-batch-part3` (profile/avatar system). Deployed; see *What's live*. | live |
| **`feat/ux-batch-part3`** | tip `4ad353f` — fully contained in `main` as of `160ee41`. | merged, can be deleted |

Merge history of the batch: `d6f9960` (2026-07-17) merged the earlier batch state — waveform voice
notes + default avatar, members identity lock, orphan-sweep age guard, guest board fix, DM
delete-for-me + monotonic read cursor, tasks jsonb caps, project-delete cascade/unassign RPC,
profile/avatar DB foundation — plus the perf/scale pass. `160ee41` (2026-07-18) merged the last
3 commits: `4f0c3c0` (avatars-bucket SELECT-policy fix that unblocked upload, 42501), `58c49fd`
(status emoji is a picker, not a text field), `4ad353f` (faces everywhere + a profile worth opening).

## What's live (verified 2026-07-18)

- Production serves bundle `index-iqnlb6l5.js` — **SHA256-identical** to a local build of `160ee41`,
  so the deployed code is exactly the merged tree. Site loads; new-code markers (`status_emoji`,
  `avatar_url`) present in the served bundle.
- The batch's DB migrations are **applied live AND committed** (the old "designed but NOT applied"
  status of this file is obsolete): `20260716104604_project_delete_cascade_unassign_rpc`,
  `20260716110514_members_profile_avatar_display_name_and_avatars_bucket`,
  `20260716131220_fix_avatars_select_own_unblocks_upload`. Rolled-back proof files for the new
  surfaces are committed under `supabase/tests/`.
- Build exit 0; lint baseline **12 errors / 2 warnings** (this supersedes older 31/2 mentions).

## PENDING — the one open item

**Owner's browser verification of the profile/avatar system ON PRODUCTION — especially light
mode** (the pre-merge check read the CSS; nobody has eyeballed it). Surfaces: ProfileModal
(open/edit/save, avatar upload/replace/remove, status emoji picker), avatars rendered across task
cards / comments / chat / DMs / members page, initials fallback for members with no avatar, and
every new element in light theme.

**Rollback if something is broken:** `git revert -m 1 160ee41 && git push` (parent 1 = `d6f9960`,
the pre-merge production state). The DB migrations stay — they're additive and the pre-merge app
never read the new columns.

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
2. `git checkout main` (everything is merged). Sanity: `npm run build`, `npm run lint` (expect 12/2).
3. If the owner's production verification hasn't happened yet, that's the open item (see *PENDING*).
   If it surfaced breakage, use the rollback above. Otherwise the batch is closed — next work per
   CLAUDE.md's *Roadmap* (server-side entitlements before billing, auth dashboard hardening).

## CLAUDE.md is the durable project guide — this HANDOFF is batch-scoped and disposable.
