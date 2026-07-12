# Final comprehensive security audit — Command Center (2026-07-12)

> Full-surface, adversarial re-verification of the entire codebase + DB, run because **public
> sign-up is now live**. Method: a 34-agent audit (11 dimension finders → 23 adversarial verifiers
> that each tried to *refute* their finding) across frontend code, the DB/RLS model (from
> `supabase/migrations/`, the source of truth), storage, realtime, invitations, and full git
> history — plus **live outsider probes against production** using only the public key.
>
> **Apply-nothing-to-the-DB discipline held:** no DB/RLS change was applied. Every DB finding is
> flagged below with a ready-to-run rolled-back PoC and its fix, for owner approval. The only change
> applied is one trivial, frontend-safe hardening (§ Applied fix).

## Executive verdict

**Is the code + DB safe for real public traffic? — YES, tenant isolation and code-security are
solid, with ONE hard operational blocker to confirm and a short list of recommended low-severity
hardening.**

- **Zero critical, zero high. Zero confirmed cross-tenant reads. Zero privilege escalation.** Both
  items that a finder initially rated *medium* were **downgraded to low** on adversarial
  verification — both are already-known, already-accepted residuals.
- **Live-proven this session** (production, using only the public `sb_publishable_` key):
  - Anon has **zero** access — all **12 tables** return `401 / 42501 permission denied`; anon
    INSERT denied; **every sanctioned RPC** returns `42501 permission denied for function`.
  - **Security headers are live and strong** (CSP `script-src 'self'`, `object-src 'none'`,
    `frame-ancestors 'none'`, HSTS preload, `X-Frame-Options: DENY`, `nosniff`).
  - **No secret anywhere** — not in the shipped bundle, not in any tracked file, not in any of the
    **111 commits** of history. `.env` is gitignored and was never committed.
  - **Zero XSS sinks** in `src/`; all user content is React-escaped; no user-controlled `href`/`src`.

- **THE ONE BLOCKER (operational, not code):** the invite email-binding and account integrity depend
  on Supabase **Auth → "Confirm email" being ON**, which is **not readable from SQL or the repo** —
  it must be confirmed in the Supabase dashboard before real traffic. If it is already ON (as
  intended), there is no residual auth-integrity gap. See finding **V-1**.

- **Not re-run this session (Supabase MCP was not loaded — this Claude was launched from the home
  dir, so `.mcp.json` didn't load).** The live service-role rolled-back **45/45 isolation** +
  **35/35 role-regression** re-run, the **security-advisor re-list**, and live storage/realtime
  runtime tests are **BLOCKED pending an in-repo relaunch**. All PoC SQL below is turnkey for that
  session. This does not change the verdict — the anon-outsider surface (the part public sign-up
  actually exposes) was verified live, and the authenticated model was verified statically against
  the migration source-of-truth, which the live DB is asserted (and independently corroborated) to
  match.

---

## (a) Confirmed-secure surfaces

Each verified with file:line / migration evidence and, where noted, a **live** production probe.

| Surface | Verification |
|---|---|
| **XSS / render paths** | Full-`src/` grep: **no** `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function`, `document.write`, string-`setTimeout`, `srcdoc`, `DOMParser`. Every user string (task titles/descriptions/subtasks/tags/blocked-reason, comment + team-chat + DM bodies, mention pills, notification title/message, project + workspace names, member display_name/email, invite data) renders as React JSX children/controlled inputs → auto-escaped. The one text transformer, `MentionText`, regex-escapes names and emits only strings + `<span>` children, never HTML. No markdown/rich-text lib in `package.json`. |
| **URL / scheme injection** | No user-controlled `href`/`src` anywhere. Only anchor is `SiteChrome.jsx:115` over **hardcoded** footer arrays; only programmatic anchor is a **blob:** JSON-export download; only media `src` is a Supabase **https signed URL** into `<audio>` (cannot execute `javascript:`). No `target="_blank"` → no reverse-tabnabbing. `task.links` is carried but has **no clickable render site** (see hardening H-1). |
| **Client secrets** | Only the **anon/publishable** key exists, read from `import.meta.env` in `src/lib/supabase.js` with no hardcoded fallback. **No** `service_role`, `sb_secret_`, JWT `eyJ…`, Stripe live key, AWS key, or password in any tracked file or the `dist/` bundle. |
| **Git history (111 commits, all refs)** | Pickaxe + regex sweep for `service_role`/`sb_secret`/`sk_live`/`rk_live`/`AKIA`/PEM/`whsec_`/`ghp_`/Slack/Google keys/credentialed `postgres://` → only matches are documentation prose, SQL role-names, literal `REDACTED` placeholders, and one **package-lock SRI `sha512` hash** (false positive). `.env` never committed on any ref. Not even the public key **value** was ever committed. **No history rewrite / rotation needed.** |
| **RLS — anon lockout** | **LIVE:** all 12 tables → `42501 permission denied`; anon INSERT denied; all RPCs → `42501 permission denied for function`. Corroborates the least-privilege explicit grants (`to authenticated` only). |
| **SECURITY DEFINER hygiene** | Every DEFINER helper/RPC/trigger fn sets `search_path = ''`, is EXECUTE-revoked from public/anon (granted to `authenticated` only), and uses **no** user-input dynamic SQL. Public API RPCs are advisor-clean INVOKER wrappers over `private.*` DEFINER impls. (One consistency-only exception: H-4.) |
| **Invitation token security** | 122-bit `gen_random_uuid()` tokens (regenerated on re-invite), **server-side** 14-day expiry, revocation check, `for update` lock + idempotent re-accept guard (no double-membership), and **server-side email-binding**: `_accept_invitation` reads the caller email from `auth.users` via `auth.uid()`, rejects on mismatch, and inserts `workspace_members` with `user_id = auth.uid()` (never a param). `create_invitation` is rank≥2-gated and hard-caps `p_role` to `member|guest` (cannot invite as owner/admin). |
| **DM isolation** | `dm_conversations`/`dm_messages`/`dm_reads` participant-gated by `private.is_dm_participant`; a conversation is created only via `get_or_create_dm_conversation`, which requires **both** users be members of the workspace (no cross-tenant contact). |
| **Roles guardrails** | `set_member_role`/`remove_member` enforce out-rank-both-target-and-new-role, last-owner protection, no self-escalation, admins can't touch owners/admins or grant admin. `workspace_members` is SELECT-only under RLS (write only via RPC). |
| **Storage read-scoping** | Private bucket; SELECT gated to own-folder OR an object referenced by a `messages`/`dm_messages` row in a workspace/DM the caller belongs to (no global members-existence read gate remains). |
| **Security headers** | **LIVE**, strong CSP + HSTS preload + XFO DENY + nosniff + Permissions-Policy (microphone→self for voice notes). |

---

## (b) Real vulnerabilities (all LOW, contained) — DB fixes flagged for approval, none applied

### V-1 — Invite email-binding depends on Supabase "Confirm email" = ON  *(low; OPERATIONAL BLOCKER #1)*
**Why it matters:** the whole email-binding model trusts `auth.users.email` as a *verified*
address. If the dashboard toggle is OFF, an attacker who **also** holds the invite token could
`signUp('victim@corp.com')`, get an immediate session, and pass the `_accept_invitation` email check
— joining as the invited role. **Contained:** only `member|guest` (create_invitation caps the role),
so no owner/admin escalation, and it requires the 122-bit token.
**PoC (conditional; not repo-verifiable):** with Confirm-email OFF and a leaked invite token,
`supabase.auth.signUp('victim@corp.com','pw')` → `supabase.rpc('accept_invitation',{p_token})`
inserts a `workspace_members` row for the attacker's uid.
**Fix:** *Operational* — **confirm Confirm-email is ON with working SMTP before real traffic.**
Optional SQL defense-in-depth (flagged, not applied):
```sql
-- inside private._accept_invitation, before the membership INSERT:
if (select email_confirmed_at from auth.users where id = (select auth.uid())) is null then
  raise exception 'confirm your email before accepting an invitation' using errcode = '42501';
end if;
```

### V-2 — `tasks.created_by` not pinned to `auth.uid()` for workspace-privacy tasks  *(low; within-tenant authorship spoofing)*
`tasks_insert_role`'s WITH CHECK only constrains `created_by` in the **private** branch; a
`privacy='workspace'` insert skips it. `comments.author_id` / `messages.sender_id` are pinned —
`tasks` is the outlier.
**Impact (contained to the caller's own workspace):** a non-guest member can forge authorship
("Added by \<victim\>") and misdirect the `task_completed` notification to the spoofed creator. **No**
cross-tenant reach (`is_workspace_member` is ANDed), **no** confidentiality gain (workspace tasks are
already member-readable), **no** privilege change.
**Rolled-back PoC (NOT yet live-executed — needs MCP):**
```sql
BEGIN;
select set_config('request.jwt.claims',
  json_build_object('sub','<MEMBER_UID>','role','authenticated')::text, true);
set local role authenticated;
insert into public.tasks (id,title,privacy,workspace_id,created_by)
values ('spoof-poc','x','workspace','<WORKSPACE_W>','<VICTIM_UID>');   -- EXPECT: succeeds today
select id, created_by from public.tasks where id='spoof-poc';         -- created_by = VICTIM_UID
ROLLBACK;
```
Or directly via PostgREST as a member: `POST /rest/v1/tasks` with `created_by:"<victim_uid>"`.
**Fix (flag, DB):** add `and created_by = (select auth.uid())` to the WITH CHECK of
`tasks_insert_role` (matching comments/messages), or stamp `created_by` server-side in a BEFORE
INSERT trigger and drop it from the client payload. After the PoC confirms the current-allow, apply
and re-run the same insert → EXPECT `42501`.

### V-3 — Local migrations don't reproduce base RLS-enable + grants for `tasks`/`projects`/`members`  *(low; repo-rebuild hygiene, not attacker-reachable)*
The three earliest tables were created in the two pre-ledger entries that have **no local file** (the
documented ledger quirk). The **live DB is correct** (proven live: all three return `42501` to anon),
but a repo-only rebuild (staging / dev / disaster-recovery) would create them with **RLS DISABLED +
default grant-all** — fully readable/writable — because the 33-file replay never re-asserts it.
**PoC (read-only, NOT yet live-executed):**
```sql
BEGIN;
select relname, relrowsecurity as rls_enabled
from pg_class where relname in ('tasks','projects','members') and relnamespace='public'::regnamespace;
-- EXPECT live: rls_enabled = true for all three (repo replay alone would yield false)
select grantee, table_name, privilege_type from information_schema.role_table_grants
where table_schema='public' and table_name in ('tasks','projects','members') and grantee in ('anon','public');
-- EXPECT: zero rows
ROLLBACK;
```
**Fix (flag, DB):** one idempotent `..._reassert_rls_and_grants.sql` re-asserting `enable row level
security` + the least-privilege grants for the three tables, so the migration set is a complete,
replayable source of truth. No behavior change on the (correct) live DB.

### V-4 — Voice-note hourly cap bypassable via delete-then-reupload  *(low; storage op-churn, not cost-DoS)*
`private.voice_note_upload_allowed()` counts **surviving** objects by `created_at`; deleting frees the
count, so a delete→reupload loop exceeds 30 write-ops/hour. Persistent-storage cost stays bounded by
the 1000-object / 10 GB cap; only operation/bandwidth churn is unbounded.
**Rolled-back PoC (NOT yet live-executed):** as the user, loop {upload `<uid>/<rand>.webm` (passes:
<30 surviving); immediately delete} >100× within an hour — `count(*)` of recent survivors never
reaches 30. **Fix (flag, DB, or accept):** count an append-only per-user upload-audit table (deletes
don't remove audit rows) instead of surviving objects, or rate-limit at the edge.

---

## (c) Known / accepted residuals (re-confirmed — includes the two downgraded mediums)

- **R-1 — Presence/typing/read-cursor channels are public Realtime broadcast (metadata only,
  spoofable).** *(finder medium → verified **low**)* The known M residual. Anyone with a workspace
  UUID (the flagship's is the fixed `11111111-…`; others leak via `?ws=`) can `setAuth(anonKey)` with
  no login and observe the live present/typing/recording roster + display names + auth UUIDs (+ DM
  `readAt`), and forge (`track`) a victim's indicator. **No message/task/comment content ever flows
  over these channels** — content is only on the RLS-gated `postgres_changes` subscriptions. Fix
  (flag): Realtime Authorization (private channels + RLS on `realtime.messages`). Accept until scale.
- **R-2 — `tasks` DELETE events broadcast a bare opaque PK cross-tenant.** *(info)* `tasks` is
  REPLICA IDENTITY DEFAULT (intentional, so DELETE events aren't dropped); a subscriber may see
  `{id:'<random-slug>'}` for deletes in other workspaces — **content-free and tenant-anonymous**
  (no title, workspace, user, or content). INSERT/UPDATE carry full rows and stay RLS-gated. By
  construction; optional hardening only.
- **R-3 — Voice-note upload needs only a global `members` row, not workspace membership.** *(info,
  L3)* Any signed-up user can fill their own capped folder (30/hr, 1000 obj, 10 MB, audio-MIME,
  ~10 GB ceiling); nobody else can read it. Bounded by the very rate-limit migration.
- **R-4 — Voice-note MIME allowlist checks the *declared* Content-Type, not sniffed bytes.** *(info)*
  Private bucket + signed URL served with the stored `audio/webm` type + `<audio>` sink + CSP →
  **no stored XSS**; a non-audio payload just fails to decode. Size cap applies regardless.
- **R-5 — `invitation_preview` + the idempotent accept early-return disclose workspace name / invited
  email to a token holder.** *(info)* Requires the 122-bit token (no enumeration — unknown tokens
  return zero rows); returns only name/email/status/expiry (preview) or the public `workspaces` row
  (post-accept re-call) — **no membership, no data, no write.** By-design for the `/invite/:token`
  screen. Optional least-disclosure tweak noted in the finding.

---

## (d) Pre-billing requirements (entitlements are client-only today — correct under all-access `founding`, must be server-enforced before real paid plans)

None of these are exploitable now: `resolvePlanId()` hard-returns the all-access `founding` plan and
there is **no DB plan column**, so there is no `free`/`pro` state to bypass. The moment real plans
ship, each becomes a business-logic/revenue bypass (never a tenant-isolation break). Landing spots are
in `SERVER_SIDE_ENTITLEMENTS_DESIGN.md` (design-only; no migration applied).

| Gate | Today | Required server enforcement before billing |
|---|---|---|
| **Seats** (members/workspace) | client-only | seat count guard in `_create_invitation` (soft) + `_accept_invitation` (hard, at the membership write) vs plan max |
| **Workspace count** | client-only | plan cap in `private._create_workspace` |
| **Voice notes (Pro)** | client-only | BEFORE INSERT trigger on `messages` + `dm_messages` rejecting `audio_path` when plan excludes voice (first point `workspace_id` is known) |
| **History retention** (`historyDays`) | **no enforcement at all** (display value only) | `and created_at >= private.workspace_history_cutoff(workspace_id)` conjunct on the message/DM SELECT policies (reversible RLS window, not a destructive prune) |
| **Recurring tasks / Bulk import** | client-only (Free-tier today) | enforce only if moved behind a paid tier |
| **prioritySupport** | plan flag, no code path | support SLA — no technical enforcement point |
| **`resolvePlanId` seam + usage inputs** | returns constant | must read a DB `plan` column and derive usage server-side before any of the above means anything |

---

## Hardening (optional, low-value, flagged — not applied)

- **H-1 — `task.links` had no URL-scheme allowlist.** *(latent; no render site)* — **FIXED**
  frontend-side this session (see below); the DB side needs nothing.
- **H-4 — `public.handle_new_user()` DEFINER doesn't revoke EXECUTE from public/anon.** *(info,
  not exploitable — Postgres rejects direct trigger-fn invocation `0A000`; no client DDL surface)*
  Consistency-only. Fix (flag): `revoke execute on function public.handle_new_user() from public,
  anon, authenticated;`.

---

## Applied fix (trivial, frontend-safe)

**`src/lib/sanitize.js` — URL-scheme allowlist on `task.links`.** Added `safeLinkUrl()` +
`normalizeLinks()` (allowlist `http:`/`https:`/`mailto:`) and applied it in both `fromDbTask` (read
path) and `sanitizeTask` (create/import path). `task.links` has no clickable render site today, so
this is defense-in-depth: a `javascript:`/`data:`/`vbscript:` URL can never be stored on a link and
reach a future render. Legitimate links pass through unchanged; other link-object fields are
preserved. **No behavior change on current data** (no producer sets a link `url`/`href` today).
Verified: `npm run build` exit 0; `eslint .` at the **31 errors / 2 warnings** baseline (unchanged).

## Blocked pending an in-repo relaunch (turnkey — run after `/mcp` → supabase → Authenticate)

Launch Claude from `C:\Users\bdstd\Documents\projects\command-center` so `.mcp.json` loads, then:
1. **45/45 isolation + 35/35 role regression** — re-run the rolled-back service-role impersonation
   proofs (as an outsider AND a guest) to reconfirm 0 cross-tenant reads + 0 escalation on live data.
2. **Security advisor re-list** — expect only the standing accepted `auth_leaked_password_protection`
   WARN (Free-plan limitation; accepted).
3. **V-2 / V-3 / V-4 PoCs above** — execute the rolled-back proofs to confirm current behavior, then,
   on approval, apply the flagged fixes and re-run to confirm the close.
4. **Live storage + realtime runtime tests** — signed-URL scoping, rate-limit trip, cross-tenant
   subscription content check.
5. **Confirm-email dashboard setting (V-1)** — verify **Auth → Confirm email = ON** with working
   SMTP. *Not SQL-readable — this is a manual dashboard check the owner must confirm.*
