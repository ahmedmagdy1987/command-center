# HANDOFF — chat pass (read receipts, two-tier delete, cursor hardening) — as of 2026-07-19

> Orientation for the current state. **The chat pass is MERGED and LIVE.** `main` is the production
> branch (Vercel auto-deploys it); the one open item is the owner's in-browser verification on
> production. After a Deep Freeze wipe follow [`RESTORE.md`](RESTORE.md) first, then read this.

## Branch topology (everything merged)

| Branch | What's on it | Status |
|--------|--------------|--------|
| **`main`** | tip **`ca847e3`** — merge of `feat/chat-reads-hides-and-dm-hardening`. Deployed; see *What's live*. | live |
| **`feat/chat-reads-hides-and-dm-hardening`** | tip `33a0429` — fully contained in `main` as of `ca847e3`. | merged, can be deleted |
| **`fix/chat-ui-avatars-and-reads`** | tip `0c6b775` — also fully contained in `main` (it is the ancestor lineage of the branch above). | merged, can be deleted |

`ca847e3` (2026-07-19) merged four commits: `35bbb45` (avatar circle crop, mic button, message
spacing, a findable delete), `4634b95` (harden the message menu against the overflow bug it was
written to fix), `f4d1cf7` + `0c6b775` (the two design-only proposal commits), and `33a0429` (the
chat pass proper — three migrations plus all their client wiring).

Previous production state was `b8fbd9d` (2026-07-18, the UX batch part 3 / profile-avatar merge).

## What's live (verified 2026-07-19)

- Production serves bundle `index-CaIOqUll.js` — **SHA256-identical** to a local build of `ca847e3`
  (`641d29ae9d0c74ba…`), so the deployed code is exactly the merged tree. All new-code markers
  present in the served bundle: `chat_thread_messages`, `chat_unread_count`, `message_hides`,
  `chat_reads`, `Delete for me`, `Read by `.
- **Team-chat read receipts** — each member's small avatar sits under the last message they read and
  moves down as they read further. Backed by the new `chat_reads` cursor (server-side, so it works
  across devices and is visible to everyone); polled every 4s + on focus/visibilitychange, because
  `chat_reads` is deliberately not in the realtime publication (neither is `dm_reads`).
- **Team-chat "Delete for me" + "Delete for everyone"** — the same two-tier menu DMs already had, now
  identical on both surfaces. Delete-for-me has no time limit, works on someone else's message and on
  a tombstone, and is discoverable: visible on hover, always visible on touch, keyboard-reachable via
  `focus-visible`, dismissable with Escape.
- **`dm_reads` cursor-repudiation hole CLOSED** — this was a live bug, not a hardening nicety. See
  CLAUDE.md *Chat pass (2026-07-19)* for the full mechanism.
- **Earlier chat UI fixes** now live too: avatar circle crop, the mic button, message spacing, and a
  findable delete (`35bbb45`), plus the message-menu overflow hardening (`4634b95`).
- **Three DB migrations applied live AND committed**: `20260719134628_chat_reads_team_chat_read_cursor`,
  `20260719134702_dm_reads_identity_lock_and_future_cap`, `20260719134752_message_hides_team_chat`.
  Rolled-back proof files for all three are committed under `supabase/tests/`.
- **Proofs 75/75** run rolled back BEFORE apply (chat_reads 26, dm_reads 19, message_hides 30), each
  with a RED phase demonstrating the disease before asserting the cure.
- **Regression after apply: 267/267** — cross-tenant isolation 48/48, workspace role boundary 143/143,
  profile + avatar 40/40, dm_reads monotonic 9/9, dm_message_hides 27/27.
- Advisors clean (only the accepted `auth_leaked_password_protection` WARN — Free-plan limitation).
- Build exit 0; lint baseline **12 errors / 2 warnings** (unchanged by this pass).

## PENDING — the one open item

**Owner's browser verification of the chat pass ON PRODUCTION.** What to exercise:

1. **The unread badge moves ONCE on cutover — this is expected, and both changes are corrections.**
   (a) A departed member's messages now count (the old client's `.neq('sender_id', me)` silently
   dropped null-sender rows); (b) tombstones no longer count. Do not treat the shift as a bug.
2. **Read receipts, two browsers / two accounts** — does the other person's avatar appear under the
   right message, and move down as they read further? Your own face must never appear.
3. **"Delete for me"** on someone else's message and on an existing tombstone — both should work with
   no time limit, and the message must stay visible for the other person.
4. **Light mode** on the receipt row and the menu.
5. A member with no `chat_reads` row yet sees a full unread count on first load, then it settles.

**Rollback if something is broken:** `git revert -m 1 ca847e3 && git push`
(parent 1 = `b8fbd9d`, the pre-merge production state).

**A revert restores the CLIENT only — and that is safe.** The three migrations stay applied, and the
pre-merge client works fine against them: it does plain table reads (nothing is hidden yet),
`search_messages` kept its exact signature, and `dm_reads` `markRead` still works under the new
triggers (dm_reads proof assertion 7 asserts precisely the PostgREST-shaped upsert the client emits).
Do not revert the migrations to roll back the UI.

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

## DB change discipline (unchanged — and now extended)

Propose SQL → wait for approval → `apply_migration` → verify (preserve per-user baselines; re-run the isolation
+ role proofs; `get_advisors`) → **add the matching file to `supabase/migrations/`** (version from
`list_migrations`) → commit + push. Migrations idempotent. Rolled-back proofs use `begin; … rollback;` with the
`set local role authenticated` + `request.jwt.claims` harness (postgres has `rolbypassrls` — a proof that forgets
the role switch proves nothing; every proof opens with a self-validating harness guard).

**Extended 2026-07-19 — nothing ships DB-only.** `dm_message_hides` (20260716000040) shipped proven,
applied, and then sat there unreachable, never called by a single line of application code. A
migration and the client work that makes it reachable belong in the SAME piece of work.

**Two proof-file failure modes worth checking for by hand** — both were caught this pass, in files
that had already been written and committed:
- an **unqualified `delete from <table>`** inside a proof. It runs as the bypassrls session role, so
  it is a match-all delete of live data with only the rollback preventing it — the exact shape the
  repo banned after it wiped live tasks. Harmless the first time against a brand-new empty table, and
  *not* harmless once the file lives in `supabase/tests/` and is re-run. Scope every write to fixtures.
- `text || tgenabled` — `tgenabled` is Postgres's `"char"` type, so the concatenation is an ambiguous
  operator and the whole file errors out. Cast it. A proof that has never been RUN may not run at all.

## Exact next steps after a wipe

1. [`RESTORE.md`](RESTORE.md): toolchain → clone → git identity/TLS → `npm install` → launch `claude` from inside
   the repo (loads `.mcp.json`) → recreate `.env` → auth the Supabase MCP.
2. `git checkout main` (everything is merged). Sanity: `npm run build`, `npm run lint` (expect 12/2).
3. If the owner's production verification hasn't happened yet, that's the open item (see *PENDING*).
   If it surfaced breakage, use the rollback above. Otherwise the pass is closed — next work per
   CLAUDE.md's *Roadmap* (server-side entitlements before billing, auth dashboard hardening, and the
   still-open operational blocker V-1: confirm Auth → Confirm email = ON).

## CLAUDE.md is the durable project guide — this HANDOFF is batch-scoped and disposable.
