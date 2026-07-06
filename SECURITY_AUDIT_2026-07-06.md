# Command Center — Red-Team Security Audit (2026-07-06)

> Deep adversarial pass **beyond** the standing 45/45 isolation and 35/35 role proofs, ahead of real
> public traffic. Method: enumerate the whole surface (RLS matrix, every `SECURITY DEFINER` body,
> grants, storage, realtime, git history, client), then attack it as a **valid low-privilege actor**
> — `qassemmenna14` (owner of workspace *amego* only, a total outsider to *Command Center*) and a
> throwaway **guest** — with rolled-back (`BEGIN … ROLLBACK`) proofs impersonating real users via
> `set local role authenticated` + `request.jwt.claims`. **No database or RLS change was applied**;
> every DB-side fix is flagged below with its proof for approval. Only documentation was written.

Actors used: `qassemmenna14` `71fd22c4-…eb34` (amego owner) · Tony `1745dca1-…d22c5` (CC owner) ·
Ahmed Magdy `cdbcc2e5-…b98f909` (CC owner) · VA/Ahmed `0598a0bc-…d42a12d` (CC member).

---

## Executive verdict

**Tenant isolation and privilege separation are solid — safe to expose the data plane to public
traffic.** Across 12 base tables + storage + 29 SECURITY DEFINER functions + all RPCs, the red-team
found **zero cross-tenant data access, zero privilege escalation, zero RPC IDOR, zero SQL injection,
zero secrets in git history, and zero XSS sinks.** Every cross-tenant and cross-rank action attempted
was blocked at the database.

**However, do not lean on public signup until the operational blockers are closed.** These are
configuration/coverage gaps, not code holes:

1. **[BLOCKER — verify now] Email confirmation must be ON.** The invitation email-binding (proven
   below) — and account integrity generally — rests entirely on *a user being unable to obtain a
   session for an email they don't control*. That is only true if Supabase Auth **Confirm email** is
   enabled with working SMTP. This setting is **not readable from SQL**; it must be verified in the
   dashboard. All 4 existing users are confirmed, but that does not prove new-signup behavior. If
   autoconfirm is on, an attacker can register `victim@corp.com` and accept an invite meant for the
   real victim → **High**.
2. **[BLOCKER — before billing] Entitlements are client-side only** (confirmed). Four gates must move
   server-side before the paywall flips (enumerated in §9).
3. **[hardening] Auth dashboard** — leaked-password protection (Pro plan), password policy, captcha,
   rate limits, redirect allowlist. (Standing item; still open.)

Two real code/config findings to fix (both **flagged, not applied**): a **guest member-email-roster
leak (Low)** and the known **presence-metadata realtime residual (Medium)**.

**Regression line held.** I re-established the isolation baseline with an equivalent condensed matrix
(the outsider sees **0** rows across all 12 surfaces) plus the role-gate PoCs (§2), reproducing the
45/45 isolation and 35/35 role invariants rather than replaying the original scripts verbatim.

---

## (a) Confirmed-secure surfaces

### 1. RLS matrix — no permissive/disabled policy, no anon data access
- **RLS enabled on every one of the 12 public tables** (`tasks, projects, comments, messages,
  notifications, members, workspaces, workspace_members, invitations, dm_conversations, dm_messages,
  dm_reads`) and on `storage.objects`. The other `storage.*` tables have RLS on with **0 policies**
  (deny-all). No table has been added since the last audit — the count still matches 12.
- **No `USING(true)` / `WITH CHECK(true)` / over-broad predicate anywhere.** Every policy is gated on
  `private.is_workspace_member(...)`, `workspace_role(_rank)(...)`, `is_dm_participant(...)`, or
  `x = auth.uid()`. The only membership-free SELECT — `comments_select_visible` — inherits `tasks`
  RLS via `EXISTS(SELECT 1 FROM tasks t WHERE t.id = comments.task_id)` and is proven safe in §2.
- **anon has no data access:** on every public table anon holds only `REFERENCES,TRIGGER,TRUNCATE`
  (no SELECT/INSERT/UPDATE/DELETE), and RLS denies those anyway. anon cannot execute any RPC
  (`invitation_preview`, `create_workspace`, `accept_invitation`, `set_member_role` all
  `has_function_privilege(anon,…)=false`) and lacks `USAGE` on the `private` schema.

### 2. DEFINER RPCs — no IDOR (every rolled-back attempt blocked)
Every privileged RPC validates the caller's rank **in the target object's own workspace**, not merely
"member of some workspace." Read of all bodies + live PoCs as the outsider `qassemmenna14`:

| Attempt (as amego-only outsider, against Command Center) | Result |
|---|---|
| `create_invitation(CC, …)` | **BLOCKED** `42501 only an owner or admin can invite` |
| `set_member_role(CC, VA, admin)` | **BLOCKED** `42501 only an owner or admin can change roles` |
| `remove_member(CC, VA)` | **BLOCKED** `42501 only an owner or admin can remove members` |
| `project_task_count(social, CC)` | **BLOCKED** `42501 not authorized` |
| `get_or_create_dm_conversation(CC, Tony)` | **BLOCKED** `42501 Not a member of this workspace.` |
| `workspace_members_list(CC)` | **0 rows** (membership gate) |
| task insert with a **colliding PK** (`id` of Tony's private task) | **BLOCKED** `23505 tasks_pkey` |
| read a comment planted on Tony's **private** task | **0 rows** (`comments_select_visible` inherits tasks RLS) |

`_set_member_role` / `_remove_member` also enforce last-owner protection, no self-escalation, and the
admin-can't-touch-owner/admin boundary (35/35 invariants). `tasks.id` is a **global primary key**, so
the comment-inheritance policy cannot be tricked by a cross-workspace id collision — the single
theoretical IDOR path, proven closed.

### 3. No dynamic-SQL injection under elevated privilege
Only one DEFINER function uses `format()`/`EXECUTE`: `public.rls_auto_enable` (an **event trigger**,
`service_role`/`postgres` only, not client-reachable) runs
`EXECUTE format('alter table … %s enable row level security', cmd.object_identity)` where
`object_identity` is the **system-supplied, already-quoted** catalog identity of a newly created
table — not user input. `_run_due_reminders` and the `notify_*` triggers concatenate task titles /
member names into notification **message values** (inserted as data, React-escaped on render), never
into executed SQL. No user-supplied string reaches an executed statement anywhere.

### 4. Invitation & auth-token security
- **Token entropy:** `invitations.token uuid DEFAULT gen_random_uuid()` (122-bit CSPRNG), `UNIQUE` —
  non-enumerable.
- **Expiry/revocation enforced server-side:** `_accept_invitation` locks the row `FOR UPDATE`
  (race-safe) and rejects `revoked` / `expired` (`expires_at <= now()`, default now()+14d); an
  already-`accepted` token is idempotent (returns the workspace, inserts nothing new).
- **Email-binding proven** (rolled-back PoC): with the **real token**, a wrong-email attacker is
  **BLOCKED** (`this invitation is for a different email`) while the rightful-email account is
  **ALLOWED** — the `auth.users.email = inv.email` check is the gate (see the §Executive blocker on
  email confirmation, which is what makes "control of the email" real).
- **No self-issue / escalation:** `invitations` has no client INSERT/UPDATE grant — the only write
  path is `_create_invitation`, which requires caller rank ≥ 2 in the target workspace and restricts
  `p_role` to `member|guest` (owner/admin can never be granted via invite). `_invitation_preview`
  requires authentication (anon cannot call it).

### 5. Realtime — postgres_changes is RLS-safe (content does not leak)
`supabase.realtime.setAuth(token)` is wired on session bootstrap **and every** `onAuthChange`
(including refresh/logout). All six `postgres_changes` subscriptions deliver per-subscriber under the
subscriber's own JWT + RLS, so joining a channel by its (UUID-bearing) name yields nothing you
couldn't already read — a **just-removed member stops receiving changes on their next evaluation**.
No `broadcast` subscriptions exist. (The presence residual is the one exception — see §M1.)

### 6. Storage (voice-notes bucket) — isolation intact
Private bucket, 10 MB cap, audio-mime allowlist. **INSERT** and **DELETE** are gated to the caller's
own `<auth.uid()>/` folder; **SELECT** allows the own folder OR an object referenced by a
`messages`/`dm_messages` row in a workspace/DM the caller belongs to; there is **no UPDATE policy**
(no overwrite), uploads use `upsert:false`, and `storage.foldername(name)[1] = auth.uid()` blocks
path-traversal keys. Signed URLs are **single-object, 1-hour** bearer links minted only after passing
the SELECT policy. No cross-workspace upload, overwrite, or key-guessing path. (One quota caveat in
§L3.)

### 7. Authz source — role, never `owner_id`
`is_workspace_member/owner`, `workspace_role(_rank)`, and `shares_workspace` all read
`workspace_members` keyed on `auth.uid()`. **No policy or RPC uses `workspaces.owner_id` for
authorization.** `workspaces` has **no INSERT/UPDATE/DELETE policy or grant at all** — there is no
client path to delete or rename a workspace by any actor; deletion is service-role-only.

### 8. Git history — clean
Full history (104 commits, all refs) shows **no** service_role key, `sb_secret_`/`sbp_` token, JWT,
`.env` (never tracked), Stripe/AWS/GitHub/Slack/Google key, or private key. `.mcp.json` is token-free
(endpoint + public project ref only). `eyJ…` matches were `package-lock.json` integrity-hash false
positives. Only the anon/publishable key ships client-side (by design).

### 10. XSS / unsafe rendering — clean
Zero `dangerouslySetInnerHTML`/`innerHTML`/`eval`/`document.write`/`window.open`. All user content
(message/DM/comment bodies, task title/description, mention pills, notification bodies, workspace/
project/member names, invite preview) renders via React text interpolation. `MentionText`
regex-escapes display names. No markdown/linkify. Only static/`mailto:` hrefs; `<audio src>` is a
Supabase-signed URL. Inline `<style>` blocks interpolate nothing.

---

## (b) Real vulnerabilities found — flagged for approval, NOT applied

### M1 — [Medium] Presence/typing/read-cursor channels leak spoofable metadata (known residual)
`chat-presence-<workspaceId>` and `dm-presence-<conversationId>` are **public** Realtime channels
(no `private:true`, no RLS on `realtime.messages`). Any client holding the (bundle-shipped) project
URL + anon key that joins the exact channel name receives presence syncs exposing, per present user:
**auth user id, display name, live typing, live recording, and (on DM channels) the peer's `readAt`
read-receipt cursor.** Channel names are tenant UUIDs — the primary workspace id is the fixed constant
`11111111-…-111111111111` and workspace ids also travel in `?ws=` links; **removed/ex-members retain
knowledge of the UUID and nothing revokes their ability to rejoin the presence channel.** Presence
`key`/`name` are client-supplied, so a joiner can **forge** another member's typing/recording/read
state. **Message and task content do NOT leak** (that flows through RLS-gated postgres_changes) — this
is metadata only. *Fix (roadmap item 3, DB/infra):* adopt Realtime Authorization — mark these channels
private and add RLS on `realtime.messages` keyed to workspace/DM membership.

### L1 — [Low] A guest can read the full member email roster
`members_select_self_or_shared` = `id = auth.uid() OR private.shares_workspace(id)`, and
`shares_workspace` matches **any** co-member. A **guest** — designed to be walled off from team chat,
projects, and others' tasks — therefore reads every co-member's `email` + `display_name`. **Proven**
(rolled-back): a throwaway guest in Command Center saw team_msgs=0, projects=0, tasks=0 (correctly
walled) **but** read `ahmedkassim17777@…, ciorciaritony@…, ahmedkassim157@…`. Cross-tenant-safe (only
co-members), but a guest external collaborator harvesting the internal email list is a privacy gap
inconsistent with the guest model. *Fix (DB/RLS, flagged):* scope the members SELECT so a **guest**
sees only themselves plus users they share a task or DM with, not the whole roster (members/admins
unchanged). Proposed predicate to review:
```sql
-- replace members_select_self_or_shared with a guest-aware version:
using (
  id = (select auth.uid())
  or (
    private.shares_workspace(id)
    and not exists (                    -- if the CALLER is a guest in every shared workspace, restrict
      select 1 from public.workspace_members me
      join public.workspace_members them on them.workspace_id = me.workspace_id
      where me.user_id = (select auth.uid()) and them.user_id = members.id
        and me.role <> 'guest'
    ) is not true
  )
)
```
*(Exact predicate to be finalized against the guest UX before applying — do not apply yet.)*

### L2 — [Low] `TRUNCATE`/`REFERENCES`/`TRIGGER` granted to anon & authenticated (defense-in-depth)
Every public table grants `TRUNCATE,REFERENCES,TRIGGER` to both `anon` and `authenticated` (Postgres
`GRANT ALL` default residue; SELECT/INSERT/UPDATE/DELETE were correctly revoked per the
least-privilege convention, but these three were not). **Not currently exploitable** — PostgREST
exposes no TRUNCATE verb and Realtime can't invoke it, so there is no reachable path from the anon/
authenticated API. Still a least-privilege violation worth closing. *Fix (DB, flagged):*
`revoke truncate, references, trigger on all tables in schema public from anon, authenticated;`
(safe — clients never need them).

### L3 — [Low] Voice-note upload requires only a `members` row, not workspace membership (quota/DoS)
`voice_notes_insert_member`'s check is `folder = auth.uid() AND EXISTS(members WHERE id=auth.uid())`
— any signed-up user can upload 10 MB objects to their own folder without belonging to any workspace,
and there is **no per-user/per-workspace storage quota**. Cross-tenant-safe (own folder only), but a
storage-cost abuse vector under public signup. Overlaps §11. *Fix (DB/infra, flagged):* add a
per-account storage quota and/or require workspace membership on the INSERT policy.

---

## (c) Known-accepted residuals

- **M1 presence metadata** — already on the roadmap (item 3) as the accepted realtime residual; this
  audit characterizes it precisely (metadata only, spoofable, ex-member-reachable). Accept until scale.
- **Leaked-password protection OFF** — accepted: it is a Supabase **Pro-plan** feature; the project is
  on Free. Revisit at the Pro upgrade (planned pre-launch for daily backups).
- Signed-URL 1h (industry-typical; could tighten to ~10 min — hygiene, not a hole). Voice-note object
  filename uses a non-crypto client random (harmless — path secrecy is not the access control; the
  CLAUDE.md wording "`<uid>/<uuid>`" is corrected to "`<uid>/<client-random>`").

---

## (d) Pre-billing requirements (client-only entitlements — point 9, CONFIRMED)

Default plan resolves to `founding` (all-access); **no plan column, cap, or feature flag is enforced
anywhere server-side** (RLS/RPC/DB grep clean, no Edge Functions). Every gate is bundled JS,
bypassable by direct supabase-js calls the moment real plans exist. Four enforcement points must move
server-side **before** the paywall flips:
1. **seats** — count `workspace_members` against the owner's plan inside **both** `_create_invitation`
   **and** `_accept_invitation` (accept is the real membership write; a pending invite can be accepted
   after a downgrade).
2. **workspaces** — count `workspaces WHERE owner_id = auth.uid()` inside `_create_workspace`.
3. **voiceNotes** — plan predicate in the voice-notes INSERT policy and/or a `messages`/`dm_messages`
   trigger rejecting audio when the owner's plan lacks it.
4. **historyDays** — an age predicate in the message SELECT policies keyed to the owner's plan, or a
   pg_cron retention job (pg_cron is already enabled).

Keep the `?plan=` preview strictly cosmetic; land a per-account plan column + Stripe-webhook updates;
point `resolvePlanId` at it. Client gates then remain UX with RLS/RPCs as the wall.

---

## (e) Abuse / DoS (point 11 — report only)

No server-side rate limits exist on authenticated creation of workspaces, tasks, messages, comments,
projects, or invitations, on the expensive RPCs, or on voice-note uploads; no per-workspace/per-user
storage quota. Highest-ROI mitigations for a public-signup product, in priority order:
1. **Auth rate limits + captcha** on signup/login/reset (public signup is a bot magnet) — dashboard.
   Pairs with the email-confirmation blocker.
2. **Unbounded `create_workspace`** — cap owned workspaces (doubles as the entitlement fix #2 above).
3. **Storage quota + workspace-membership check** on voice-note upload (§L3).
4. **Volume caps** on task/message/comment creation (a per-actor sliding-window count in the write
   path, or edge rate-limiting) to blunt spam/enumeration.

---

## Method note / reproducibility

All PoCs ran through the Supabase MCP `execute_sql` as `BEGIN; set local role authenticated;
set local request.jwt.claims '{…}'; <probe>; ROLLBACK;` (reads) or a rolled-back `DO` block with a
temp table (mutations/multi-actor), impersonating the real actors above. Nothing was committed to the
live database. Static surfaces (git history, XSS, entitlements, realtime/storage client) were covered
by a parallel adversarial workflow with skeptic verification. No security advisor regressed (only the
standing accepted `auth_leaked_password_protection` WARN).
