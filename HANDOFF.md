# HANDOFF — avatars private-bucket conversion + guest scope fix — as of 2026-07-22

> Orientation for the current state. **This batch is MERGED and LIVE.** `main` is the production
> branch (Vercel auto-deploys it). After a Deep Freeze wipe follow [`RESTORE.md`](RESTORE.md) first,
> then read this.

## What just happened, in two paragraphs

The `avatars` bucket was the last **public** bucket in the project: reads evaluated no policy and no
JWT, so every face ever uploaded was a permanent, world-readable asset that "Remove photo" could not
revoke. It is now **private**, `members.avatar_url` stores a **storage path** instead of a URL,
rendering mints short-lived signed URLs, and the bucket finally has quotas and an orphan sweep. The
DB half was applied **before** the client half was merged (owner's call, so production could be
verified), which opened a ~50-minute degraded window where avatars showed as initials and photo-saves
failed `22023`. **That window is closed** by `972b618`.

A **post-deploy security audit of that work then found a real defect** and it was fixed the same day:
the new avatar visibility predicate had **no guest clause**, so a GUEST could read — and sign a URL
for — the avatar object of an *arbitrary* co-member the roster deliberately hides from them.
Reproduced live, fixed by `20260722080911`, merged as `f83f538`. Details below under
*Guest scope fix*.

## Branch topology

| Branch | What's on it | Status |
|--------|--------------|--------|
| **`main`** | tip **`f83f538`** — merge of `fix/guest-avatar-visibility-scope`. Deployed; see *What's live*. | live |
| **`fix/guest-avatar-visibility-scope`** | tip `d60e0d4` — contained in `main`. | merged, can be deleted |
| **`feat/avatars-private-signed-urls`** | tip `ea6f994` — in `main` since `972b618`. | merged, can be deleted |
| **`fix/project-delete-avatars-and-unhide`** | tip `78da1b8` — in `main` since `c2004b3`. | merged, can be deleted |
| **`fix/data-integrity-a11y-and-dead-code`** | tip `85c8d78` — contained in the branch above. | merged, can be deleted |

`972b618` merged `270f513` (the signed-URL client half) and `ea6f994` (the applied migrations, the two
inverted test files, docs). `f83f538` merged `d60e0d4` (the guest scope fix — **no `src/` files**).

## Rollback — THE TWO MERGES ARE NOT EQUALLY SAFE

**`f83f538` (guest scope fix) — NORMAL, safe:**
```
git revert -m 1 f83f538 && git push        # parent 1 = 88306dd
```
**Leave `20260722080911` applied.** It only TIGHTENS visibility and touches no client contract, so it
is strictly protective — the standard case. The branch has no `src/` files, so reverting it changes
nothing a user sees; it just removes the migration file, proofs and docs from the repo.

**`972b618` (private-bucket conversion) — ⚠ NOT A CLEAN ROLLBACK. The one exception in this project.**
```
git revert -m 1 972b618 && git push        # parent 1 = a463c79
```
Every *other* rollback line here is safe because the migration is protective and can stay applied.
**This one is different: reverting the client alone re-opens the exact degraded state that deploy
closed** — the DB would still be private and path-shaped while the restored client builds public URLs
and stores URLs.

And the DB half **cannot cleanly come with it**: the URL → path backfill is **one-way**, and flipping
`storage.buckets.public` back to `true` does not restore the old `avatar_url` values. That would
leave a path-shaped column behind a URL-shaped world and strand every avatar anyway.

**So: forward-only on the conversion.** If something is wrong with avatars, fix forward with a new
commit — which is exactly what the guest scope fix did. A true revert would need its own forward
migration re-prefixing the paths back to absolute URLs *and* re-flipping the bucket, applied in the
same deploy as the client revert. Don't improvise that under pressure.

## What's live (verified 2026-07-22)

- Production serves **`index-DofwQkiD.js`**, **SHA256-identical** to a local build of `972b618`
  (`34262957C9810BF7D610858C53F53D929BE59D6CA0A259B114554F03CD7F1809`, 784,129 bytes). The CSS
  (`index-BAJ4N6IX.css`) matches byte-for-byte too. Previous production bundle was `index-B1SY169F.js`.
- **The `avatars` bucket is PRIVATE.** Every public URL ever minted for it now returns 400 — that is
  the point of the change, not a side effect.
- **`members.avatar_url` stores a bare storage path**, pinned by trigger to the row owner's own uid
  folder. One live row was backfilled (`0598a0bc-…/ltnts5q5w58m.jpg`); 0 rows are off-shape.
- **Avatars render from batched signed URLs** (`createSignedUrls`, plural — one request per batch,
  never one per face), eagerly signed for the roster and re-signed 5 minutes before the 3600s TTL.
- **Quotas exist at last:** 12 uploads/hr/user (delete-resistant, operations-counted via an
  append-only log), 20 objects and 20 MB per user, plus the hourly `avatar-orphan-sweep` cron job at
  `:30` — the project's **third** scheduler.
- **The sweep has already run for real in production.** `cron.job_run_details` shows it fired at
  06:30 UTC, 16 minutes after the conversion landed, status `succeeded`, and the live avatar object is
  still present. That is the exact-equality rule running unsupervised against real data and correctly
  sparing an in-use avatar.
- **A live gap was closed, not just a theoretical one.** Before this change the trigger validated only
  the public-URL *prefix* and never checked the folder belonged to the row owner, while `authenticated`
  already held `UPDATE (avatar_url)` — so user A could already point their `avatar_url` at user B's
  object. Harmless while the bucket was public; a private-image leak the instant `avatar_url` became a
  read grant. Proven blocked live under impersonation (`22023`).
- **Guest avatar visibility is scoped to the roster's rule** (`20260722080911`): a guest sees their
  own avatar plus those of people they actually share a **task** or a **DM** with, and **nothing
  else**. Non-guests and outsiders are unchanged. `private.shares_workspace` — the last
  pre-guest-scoping helper — is **dropped**, with zero references remaining.

## Guest scope fix — what the audit found

`private.is_visible_avatar_object` is SECURITY DEFINER *on purpose*: a storage policy whose
correctness rides on another table's RLS is a coupling that breaks quietly. But going DEFINER means
the guest exclusion baked into `public.members`' own policy no longer applies, so the share check had
to be restated by hand — and it reached for `private.shares_workspace`, the **pre-2026-07-06** helper
with no guest clause, instead of the guest-scoped rule `20260706035653` introduced everywhere else.

**→ The reusable lesson: the moment a storage-policy helper becomes DEFINER, every visibility rule it
used to inherit must be restated by hand. Enumerate them; do not assume.** Contrast
`voice_notes_select_member`, a NON-definer `EXISTS` over `messages`, which inherits the guest
exclusion for free (verified live: a guest reads 0 of a team-chat voice-note object).

**The obvious fix would have been wrong.** `can_see_member_profile`'s guest branch is
`me.role <> 'guest'`, so for a GUEST CALLER it collapses to self-only — it would have blanked a
guest's genuine task/DM peers. The proof pins the product intent empirically: the roster **does**
return those peers to the guest, so their faces must keep rendering.

## Verification evidence

| Check | Result |
|---|---|
| Quota/sweep migration, rolled-back | **37/37** (incl. S00, the `SET LOCAL` regression guard) |
| Conversion migration, rolled-back | **30/30** |
| Conversion, live post-apply against REAL production rows | **11/11** |
| Guest scope fix, rolled-back | **13/13** (incl. an anti-vacuity mutation that makes the leak return) |
| Guest scope fix, live post-apply | **7/7** |
| Full regression, 16 re-runnable suites | **547/547**, zero failures |
| Security advisors | clean (only the accepted `auth_leaked_password_protection`) |
| Build / lint | clean / **12 errors, 2 warnings** (baseline held) |
| Trigger rewrite fidelity | **zero differing characters** before the `avatar_url` block; emoji regex **byte-identical, 79 octets** |

The 11/11 live pass is the one worth remembering: Tony and Ahmed Magdy each SELECT the VA's real
avatar object (so signing succeeds and a co-member's face renders), the amego outsider selects **zero**
and lists an **empty** bucket, Ahmed cannot name the VA's path, the sweep spares the live object, and a
single URL-shaped value makes the sweep RAISE `55000` instead of deleting. The 7/7 guest pass adds:
non-peer → **0**, task-peer → **1**, DM-peer → **1**, guest listing exactly {own, task-peer, DM-peer},
non-guest and outsider unchanged, and Tony still sees the VA's real production avatar.

## PENDING — owner action

**1. Browser verification on production.** The DB-layer behaviour is proven; these are the client-side
things only a browser can confirm:
  * **A co-member's avatar renders** (not initials) — the headline fix. The VA's photo should appear
    for Tony and for Ahmed Magdy.
  * **Remove photo actually deletes the object**, and a **re-upload does not leak the old one**. These
    are the paths that finally make `avatars_delete_own` reachable — it shipped with a policy *and* a
    grant that nothing ever called. Not DB-provable: `storage.protect_delete()` is a statement-level
    BEFORE DELETE trigger that refuses direct SQL deletes before RLS is ever consulted.
  * **A stale signed URL recovers instead of sticking at initials.** The one item with no DB-side
    proof. The 3600s TTL means you will not hit natural expiry by hand — force it by going offline
    briefly so an `<img>` errors, then restore; the face should come back.
  * Upload a photo and confirm the save succeeds (it failed `22023` during the degraded window).

**2. V-1, still open from the 2026-07-12 audit:** confirm Supabase **Auth → Confirm email = ON** with
working SMTP. Not SQL-readable; the whole invite model's email-binding depends on it.

## Proof-suite health

**16 of the 18 files in `supabase/tests/` run to completion: 547 assertions passing, zero failures.**
Three suites changed this batch — `avatars_upload_rls` 14 → **20**, `profile_and_avatar` 40 → **42**
(the conversion deliberately inverts both), and the new `guest_scoped_avatar_visibility` at **13**.

**TWO FILES DO NOT RUN AT ALL, and it is worse than "some assertions fail."** The two avatars proofs
were written *before* their migrations, and post-apply they **abort mid-transaction and emit no
verdict whatsoever** — one during RED fixture setup, one inside GREEN, both `22023` because their
fixtures plant the old public-URL-shaped `avatar_url` the rewritten trigger rejects. A careless reader
sees a SQL error, not a red assertion, which is exactly how a suite rots into being ignored. Both
headers now record the precise failing line and error. They are **excluded from the 547**.

The cure is the **REWIND** pattern — transaction-locally restore the pre-migration state, let RED
demonstrate the disease against it, then re-apply and let GREEN prove the cure. Already used by
`chat_reads`, `dm_reads_identity_lock`, `delete_project`, `accept_invitation`,
`role_title_match_anchored`, and — as the cleanest worked example — the new
`guest_scoped_avatar_visibility`, which is why *that* proof still runs 13/13 after its own migration
shipped. Copy that one when retrofitting the other two.

**Three files are landmines.** `avatars_upload_rls` proves the reference rule in *both* directions, so
a folder-level "simplification" of `avatars_select_shared_workspace` fails loudly (S06) and reverting
the policy fails loudly (S04). `profile_and_avatar` **re-creates `members_validate_profile` inside its
own transaction**, so if that rule changes it must change there too — the same trap documented for
`private._looks_like_role_title`. And **all three avatars proofs re-create
`is_visible_avatar_object`**: when `shares_workspace` was dropped they would have failed on the *DDL*,
not on an assertion, because a `language sql` body is validated at **creation** time. That is a
confusing failure mode worth recognising quickly.

**Harness guards.** `stripe_sandbox_billing` gained the missing `rolbypassrls` self-check this batch
(it still passes 45/45, which is itself proof its impersonation was real). `workspace_role_boundary`
was a **false positive** in the audit's first pass — it guards on `current_user` inside
`probe`/`probe_val` and *asserts that guard* in A00, which is stronger. And
`task_attachment_orphan_sweep_age_guard` is **legitimately exempt**: it never impersonates, because it
exercises a DEFINER cron function as postgres and makes no RLS claim.

## Known gaps, deliberately deferred

- **Advertised-but-unenforced plan limits** (`historyDays`, `prioritySupport`, `seats`, `workspaces`).
  Zero plan/billing columns exist and the workspace/invitation RPCs contain no count checks. Blocked
  on the unmade **per-account vs per-workspace** billing decision — see CLAUDE.md.
- **Recurring tasks** — removed from the UI, column retained, design note in place.
- Presence/typing channels remain the accepted realtime metadata residual.
- **CDN residual (accepted):** flipping the bucket to private may leave edge-cached copies of
  previously-requested avatar objects reachable for their cache TTL, and it cannot un-see an image
  someone already saved. Bounded and small; every NEW object is never public for even one instant.
- **Guest predicate sync debt (new, deliberate — owner decision 2026-07-22: leave as documented
  debt).** `private.can_see_member_avatar` (`20260722080911`) and `private._workspace_members_list`
  (`20260716110514`) now implement the **same guest rule in two places** and can drift. Unifying them
  means rewriting an RPC carrying 40+ live assertions, which was not worth doing inside a security
  fix and is not worth doing speculatively. **If you change the guest visibility rule, change it in
  BOTH** — inline warnings sit on each, plus a CLAUDE.md section. Unify only if it actually causes a
  problem.
- **Avatar object filenames are `Math.random()`-derived**, not crypto-random:
  `sanitize.js uid()` = 8 base36 chars of `Math.random()` + 4 chars of `Date.now()`. Path secrecy is
  not a security boundary here (RLS is), so this is a residual rather than a hole — but note it if a
  future change ever makes knowing a path sufficient to read it.

## Rebuild gaps (honest — read before trusting a from-scratch rebuild)

1. **No original baseline `CREATE TABLE` exists.** `tasks` / `projects` / `members` were created directly on
   Supabase **before the ledger began**. `supabase/migrations/00000000000000_baseline.sql` is a
   **BEST-EFFORT RECONSTRUCTION**, honesty-flagged inline (`«?»`), and **never applied**. A real
   from-scratch rebuild must be validated end-to-end. The original base RLS policies are unrecoverable.
2. **`rls_auto_enable()` + the `ensure_rls` event trigger** and the **original `handle_new_user()`** are
   pre-ledger/out-of-band; the baseline holds best-effort copies (later `CREATE OR REPLACE`d by real
   migrations, so the final state is correct on replay).
3. **The ledger and the repo now agree exactly** — re-verified 2026-07-22, **66/66 in both directions**,
   zero orphans on either side. The old "two ledger entries have no local file" caveat is **resolved**;
   both files were recovered and committed. Don't reintroduce that note.

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

**⚠ NEW THIS BATCH — ordering a non-backward-compatible cutover.** This was the first change where the
DB and client halves were *mutually* incompatible (new trigger rejects a URL; old client stores one).
The written runbook said merge → deploy → apply. We did the reverse, deliberately, so the DB could be
verified before shipping the client — and that traded a ~60-second window for a ~50-minute one. It was
the right call *here* (a two-person internal tool, one avatar affected, nothing lost) but **it is not
the default.** With real users, apply the client-compatible half first, or make the DB half accept
both shapes during a transition. When the halves are genuinely simultaneous, minimise the window.

**Statement order inside a migration can substitute for transactionality.** The conversion put the
backfill and its refuse-to-commit guard *before* the sweep's rule change, so the exact-equality rule
cannot exist without a completed backfill — true even if a runner executed statement-by-statement. The
sweep additionally RAISES rather than deletes anything it cannot parse. Two independent mitigations
for one sharp edge; both were exercised against live data.

**Failure modes worth checking by hand in any new proof:** an unqualified `delete from <table>` (runs
as the bypassrls session role — a match-all delete of live data saved only by the rollback);
`text || tgenabled` (`"char"`, ambiguous operator — the file errors out entirely); a temp results
table with no `grant insert ... to authenticated`; and `perform set_config('session_replication_role',…)`
which raises 42501 because this project's `postgres` is not a superuser — use `SET LOCAL`.

## Exact next steps after a wipe

1. [`RESTORE.md`](RESTORE.md): toolchain → clone → git identity/TLS → `npm install` → launch `claude`
   from inside the repo (loads `.mcp.json`) → recreate `.env` → auth the Supabase MCP.
2. `git checkout main`. Sanity: `npm run build`, `npm run lint` (expect **12 errors / 2 warnings**).
3. The open items are the browser verification above, V-1, then CLAUDE.md's *Roadmap*.

## CLAUDE.md is the durable project guide — this HANDOFF is batch-scoped and disposable.
