# HANDOFF — post-deploy remediation batch — as of 2026-07-19

> Orientation for the current state. **This batch is MERGED and LIVE.** `main` is the production
> branch (Vercel auto-deploys it). One design is finished and **awaiting owner approval before apply**
> (avatars). After a Deep Freeze wipe follow [`RESTORE.md`](RESTORE.md) first, then read this.

## Branch topology

| Branch | What's on it | Status |
|--------|--------------|--------|
| **`main`** | tip **`c2004b3`** — merge of `fix/project-delete-avatars-and-unhide`. Deployed; see *What's live*. | live |
| **`fix/project-delete-avatars-and-unhide`** | tip `78da1b8` — contained in `main`. | merged, can be deleted |
| **`fix/data-integrity-a11y-and-dead-code`** | tip `85c8d78` — **contained in the branch above**, so also in `main`. | merged, can be deleted |

`c2004b3` (2026-07-19) merged two batches at once, because the second was based on the first:
`85c8d78` (recurring removal, a11y, dead code, proof repairs) and `78da1b8` (delete_project
validation + client, unhide). Previous production state was `ce9741a`.

## Rollback

```
git revert -m 1 c2004b3 && git push
```
parent 1 = `ce9741a`, the pre-merge production state.

**The `20260719172122` migration STAYS APPLIED on revert.** It is strictly protective: the pre-merge
client sent the hardcoded seed id `'other'`, which under the new validation fails **loudly** (P0002)
instead of silently unfiling tasks. Reverting the client and re-applying forward is correct;
reverting the migration would restore the data-loss path. Same principle as the earlier chat pass —
**never revert a protective migration to roll back a UI.**

## What's live (verified 2026-07-19)

- Production serves `index-B1SY169F.js`, **SHA256-identical** to a local build of `c2004b3`
  (`12d4a38334cac6cd…`). New-code markers present in the served bundle; the recurring-tasks UI is
  confirmed absent from it.
- **Recurring tasks REMOVED from the UI** (owner decision: remove now, build later). It had **no
  backend of any kind** — no DB function, trigger or cron job ever read `tasks.recurring`, and five
  live tasks had carried active rules since 2026-04-26 without generating one occurrence, while being
  advertised on every pricing tier. The **column stays** and `sanitize.js` still round-trips it, so
  every existing rule is preserved for a future build. A design note sits where the code was.
- **Project delete can no longer strand tasks** (`20260719172122`). `_delete_project` validates the
  reassign target resolves in the same workspace; the modal offers a real destination **picker** and
  disables "keep the tasks" when there is nowhere to move them. A shared `defaultProjectId()` fixed
  the same seed-id assumption in **five** call sites (QuickAdd, ColumnQuickAdd, addTask, the modal).
- **"Delete for me" is reversible** on both surfaces: an **Undo** toast (8s) at the moment of hiding,
  plus a persistent **"N hidden — restore"** control in the team-chat and DM headers.
- **Message menus are keyboard-operable**: focus enters the menu, arrows/Home/End rove, focus-out
  closes, Escape returns to the trigger, one menu open at a time.
- Mic-button focus ring restored; the `Avatar` `aria-hidden` regression fixed with an `sr-only` label.
- Four dead `api.js` exports deleted, each with a note on what superseded it.

## PENDING — owner action

**1. Approve the avatars work (designed, proven, NOT applied).** Two migrations that must land
together, in this order:
  1. `PROPOSED_avatars_quota_rate_limit_and_orphan_sweep.sql` — **37/37 proven**. Adds the 12/hr
     upload rate limit (delete-resistant, operations-counted), a 20-object / 20 MB per-user cap, and
     an hourly orphan sweep with the 1-hour age guard. This is the only bucket of the three with no
     limits of any kind today.
  2. `PROPOSED_avatars_private_bucket_and_signed_urls.sql` — the public → private conversion.

**Why private matters here:** `avatars` is the only **public** bucket, so "Remove photo" today leaves
a **world-readable** image live forever, and a co-member who receives a URL holds a permanent,
unrevokable, anonymously-fetchable link that outlives their membership.

**The blocker that makes this non-trivial:** `avatars_select_own` is own-folder only. While the bucket
is public that never mattered (the public endpoint bypasses RLS), but signing requires SELECT — and it
was *proven by impersonation* that a workspace admin can select **zero** of a co-member's avatar
objects. Flipping the bucket flag alone would silently degrade **every avatar except your own** to
initials. A co-workspace SELECT policy is mandatory, alongside a `members_validate_profile` rewrite
(it pins `avatar_url` to the literal public-URL shape), a backfill of the stored value to a path, and
the client half (batched `createSignedUrls`, a TTL refresh cache, `Avatar`'s `onError` reset, and
`removeAvatar` actually deleting the object).

**2. Browser verification of this batch on production.** Worth clicking: delete a project that has
tasks and confirm the destination picker names a real project; hide a message and use Undo, then hide
another and use "N hidden — restore"; Tab into a message menu and drive it with arrows; Tab to the
mic button and confirm you can see focus; check light mode on the new controls.

## Proof-suite health

All 15 suites in `supabase/tests/` run to completion. **519 assertions passing, zero real failures**
as of the pre-merge run.

A proof written *before* its migration lands has two lifecycles, and they conflict: its RED phase
attacks a hole the migration then closes, so on re-run it either fails "expectedly" or aborts the
whole transaction and reports nothing. Five suites hit this. The fix is the **REWIND** pattern —
transaction-locally restore the pre-migration body, let RED demonstrate the disease against it, then
re-apply and let GREEN prove the cure. Applied to `chat_reads`, `dm_reads_identity_lock`,
`delete_project`, and (this pass) `accept_invitation` and `role_title_match_anchored`.
`message_hides` could not be rewound — its RED asserted a table did not exist, and recreating that
would mean DROPping a live table and holding an ACCESS EXCLUSIVE lock mid-run — so that one became a
structural precondition instead.

`stripe_sandbox_billing` had been **silently un-runnable since it was written** (42501 on its own
temp results table, because `record_result` is INVOKER and runs as `authenticated` during
impersonated phases). Fixed with the documented grant; now 45/45.

## Known gaps, deliberately deferred

- **Advertised-but-unenforced plan limits** (`historyDays`, `prioritySupport`, `seats`, `workspaces`).
  Zero plan/billing columns exist and the workspace/invitation RPCs contain no count checks. Blocked
  on the unmade **per-account vs per-workspace** billing decision — see CLAUDE.md.
- **Recurring tasks** — removed from the UI, column retained, design note in place.
- Presence/typing channels remain the accepted realtime metadata residual.
- **V-1 still open:** confirm Supabase **Auth → Confirm email = ON** with working SMTP.

## Rebuild gaps (honest — read before trusting a from-scratch rebuild)

1. **No original baseline `CREATE TABLE` exists.** `tasks` / `projects` / `members` were created directly on
   Supabase **before the ledger began**. `supabase/migrations/00000000000000_baseline.sql` is a
   **BEST-EFFORT RECONSTRUCTION**, honesty-flagged inline (`«?»`), and **never applied**. A real
   from-scratch rebuild must be validated end-to-end. The original base RLS policies are unrecoverable.
2. **`rls_auto_enable()` + the `ensure_rls` event trigger** and the **original `handle_new_user()`** are
   pre-ledger/out-of-band; the baseline holds best-effort copies (later `CREATE OR REPLACE`d by real
   migrations, so the final state is correct on replay).
3. **Two ledger entries had no local file — recovered** verbatim from
   `supabase_migrations.schema_migrations.statements` and committed.

## DB change discipline

Propose SQL → **wait for approval** → `apply_migration` → verify (per-user baselines; re-run the
isolation + role proofs; `get_advisors`) → **add the matching file to `supabase/migrations/`**
(version from `list_migrations`) → commit + push. Migrations idempotent. Proofs use
`begin; … rollback;` with the `set local role authenticated` + `request.jwt.claims` harness — postgres
has `rolbypassrls`, so a proof that forgets the role switch proves nothing; every proof opens with a
self-validating guard.

**Nothing ships DB-only.** `dm_message_hides` shipped proven, applied, and unreachable for three days;
its DELETE half stayed unreachable for three more. A migration and the client work that makes it
reachable belong in the SAME piece of work.

**Failure modes worth checking by hand in any new proof:** an unqualified `delete from <table>` (runs
as the bypassrls session role — a match-all delete of live data saved only by the rollback);
`text || tgenabled` (`"char"`, ambiguous operator — the file errors out entirely); a temp results
table with no `grant insert ... to authenticated`; and `perform set_config('session_replication_role',…)`
which raises 42501 because this project's `postgres` is not a superuser — use `SET LOCAL`.

## Exact next steps after a wipe

1. [`RESTORE.md`](RESTORE.md): toolchain → clone → git identity/TLS → `npm install` → launch `claude`
   from inside the repo (loads `.mcp.json`) → recreate `.env` → auth the Supabase MCP.
2. `git checkout main`. Sanity: `npm run build`, `npm run lint` (expect **12 errors / 2 warnings**).
3. The open item is the avatars approval (see *PENDING*), then CLAUDE.md's *Roadmap*.

## CLAUDE.md is the durable project guide — this HANDOFF is batch-scoped and disposable.
