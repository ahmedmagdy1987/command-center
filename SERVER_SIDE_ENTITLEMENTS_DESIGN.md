# Server-side entitlement enforcement — design + rolled-back proof (2026-07-06)

> **Status: DESIGN + PROOF ONLY. Nothing applied to the live DB. Awaiting approval.**
> Closes the pre-billing blocker from the red-team audit (SECURITY_AUDIT_2026-07-06.md §d): today
> every plan/feature/limit gate is client-side only and trivially bypassable via direct supabase-js
> calls. This moves all four gates (seats, workspaces, voiceNotes, historyDays) server-side.
>
> **⚠️ SCHEMA CHANGE REQUIRED** — two new tables in the `private` schema (`plan_limits`,
> `workspace_subscriptions`), plus helper functions, three RPC bodies rewritten, two triggers, and
> two SELECT policies amended. All flagged below; none applied.

---

## 1. How the server will authoritatively know a workspace's plan

**Source of truth: `private.workspace_subscriptions`** — a per-workspace row written only by the
Stripe webhook (service-role). This aligns with the **billing design doc**
(`docs/stripe-sandbox-billing-recon.md`), which mandates **per-workspace** subscriptions
(`private.workspace_subscriptions(workspace_id)`, `internal_plan_id`, `subscription_status`,
canceled→free) as the Supabase read model — Stripe webhooks are authoritative, the browser never is.

### Reconciling a real conflict (surfaced in recon)
`src/lib/plans.js` (lines 133-136) describes billing as **per-account** (one subscription per owner).
The Stripe doc (lines 152, 158) **explicitly overrides** this: "the required billing design is one
subscription per workspace." I aligned enforcement with the **Stripe doc** (the authoritative billing
design) rather than inventing a competing per-account table. The one gate that is inherently
per-account — the *workspaces-owned cap* — is derived from the owner's workspaces (see §3.2), which is
the honest reconciliation and is called out there as a decision point.

### Effective plan + grandfathering
`private.workspace_effective_plan(ws_id)`:
- **No subscription row → `'founding'`** (all-access). Every existing workspace has no row, so
  enforcement is a **no-op** for all of them — grandfathering by construction.
- Row with `internal_plan_id='founding'` → `founding` (explicit grandfather, any status).
- Row `active`/`trialing` → `internal_plan_id` (`free`/`pro`/`business`).
- Row otherwise (canceled/none/past_due…) → `'free'` (matches the Stripe doc state machine).

**Proven (rolled back):** CC (no row) → `founding`; after a `free` row → `free`; `pro`+active → `pro`;
`pro`+canceled → `free`.

### Plan limits mirror plans.js (documented sync point)
`private.plan_limits(plan_id, max_seats, max_workspaces, history_days, voice_notes)` — a reference
table seeded to **exactly match `src/lib/plans.js`** (`Infinity → NULL` = unlimited). Postgres can't
read the JS file, so this is the sanctioned mirror; **the sync point is this migration's seed vs.
`PLANS` in plans.js.** Proven equal:

| plan | max_seats | max_workspaces | history_days | voice_notes | (plans.js) |
|------|-----------|----------------|--------------|-------------|------------|
| founding | NULL (∞) | NULL (∞) | NULL (∞) | true | ∞/∞/∞, all features |
| free | 3 | 1 | 30 | false | 3/1/30, no voice |
| pro | 15 | 3 | NULL (∞) | true | 15/3/∞, voice |
| business | 50 | 10 | NULL (∞) | true | 50/10/∞, voice |

### Proposed schema (all in `private`; **no** anon/authenticated grants on the tables)
```sql
create table private.plan_limits (
  plan_id text primary key,
  max_seats int, max_workspaces int, history_days int,   -- NULL = unlimited
  voice_notes boolean not null
);
-- seed = mirror of src/lib/plans.js (see table above)

create table private.workspace_subscriptions (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  internal_plan_id text not null default 'founding' references private.plan_limits(plan_id),
  subscription_status text not null default 'none',
  updated_at timestamptz not null default now()
  -- Stripe columns (customer_id, subscription_id, price_id, billing_interval, current_period_end)
  -- get added when the Stripe integration lands, per docs/stripe-sandbox-billing-recon.md.
);
```
Helpers (all `SECURITY DEFINER`, `search_path=''`, EXECUTE revoked from public/anon + granted to
`authenticated` since RLS/RPCs call them): `workspace_effective_plan(ws)`, `plan_max_seats(plan)`,
`plan_max_workspaces(plan)`, `plan_history_days(plan)`, `plan_includes_voice(plan)`,
`account_max_workspaces(uid)`, `workspace_history_cutoff(ws)`.

---

## 2. Layering — plan enforcement composes WITH, not INTO, the role checks

Every existing role/rank/tenancy check stays exactly as-is; the plan check is an **additional
conjunct/guard** evaluated **after** the role check. So the 35/35 role boundaries are untouched.

**Proven (rolled back):** a member (VA) and an outsider (qassem) calling `create_invitation` are both
still blocked by **`only an owner or admin can invite`** (the role check) under *both* founding and
free — never reaching the plan check. The plan gate only bites a caller who has already passed the
role gate.

---

## 3. Exact enforcement in each of the four points

### 3.1 Seats — `_create_invitation` + `_accept_invitation`
After the existing rank/role/email/duplicate checks, add (no-op when `max_seats` is NULL/founding):
```sql
v_max := private.plan_max_seats(private.workspace_effective_plan(<ws>));
if v_max is not null
   and (select count(*) from public.workspace_members where workspace_id=<ws>) >= v_max then
  raise exception 'this workspace has reached its plan seat limit (%)', v_max using errcode='P0001';
end if;
```
- `_create_invitation`: soft gate (can't invite into an already-full workspace).
- `_accept_invitation`: **hard gate** at the real membership write (a pending invite can be accepted
  after a downgrade — this is where the seat is actually taken).

**Proven:** under `free` (CC at 3/3) both `create_invitation` and `accept_invitation` are **BLOCKED**
(`…seat limit (3)` / `…full for its plan (3 seats)`); under `founding` both **ALLOWED**.

### 3.2 Workspaces — `_create_workspace`
After the auth+name checks, before the insert (no-op when unlimited/founding):
```sql
v_max := private.account_max_workspaces(v_uid);
if v_max is not null
   and (select count(*) from public.workspaces where owner_id=v_uid) >= v_max then
  raise exception 'you have reached your plan workspace limit (%)', v_max using errcode='P0001';
end if;
```
**`account_max_workspaces(uid)`** (the per-account reconciliation): unlimited (NULL) if the user owns
**no** workspaces or owns **any** whose effective plan is unlimited (founding); otherwise the max
`max_workspaces` across their owned workspaces. So existing users (own a founding workspace) → **NULL
→ never blocked**. A user whose workspace is on `free` → cap 1.

**Proven:** with CC set to `free`, Tony (owns 1) is **BLOCKED** (`…workspace limit (1)`); under
`founding` **ALLOWED**.

> **Decision point for you:** under per-workspace billing there is no single "account plan," so the
> workspaces-owned cap is derived as above. Consequence: a brand-new user with 0 workspaces is
> *unlimited until their first plan is assigned* (consistent with "only bite once real plans are
> assigned"). At go-live, if new signups should start on `free` (cap 1), either flip the resolver's
> default from `founding`→`free` or seed a `free` subscription row on signup. Flagged, not decided.

### 3.3 voiceNotes — trigger on `messages` + `dm_messages` (NOT the upload policy)
```sql
create function public.enforce_voice_notes_plan() returns trigger ... security definer, search_path='' as $$
begin
  if new.audio_path is not null
     and not private.plan_includes_voice(private.workspace_effective_plan(new.workspace_id)) then
    raise exception 'voice notes are not included in this workspace''s plan' using errcode='P0001';
  end if;
  return new;
end $$;
create trigger enforce_voice_notes_plan    before insert on public.messages    for each row execute function public.enforce_voice_notes_plan();
create trigger enforce_voice_notes_plan_dm before insert on public.dm_messages for each row execute function public.enforce_voice_notes_plan();
```
**Why the message-insert trigger, not the storage upload policy:** the upload path is `<uid>/…` and
carries **no workspace context**, and the feature belongs to the **workspace-owner's** plan, not the
uploader's (a Free-plan member of a Pro workspace *should* be able to send voice notes). The message
row is the first point where `workspace_id` is known, so it is the correct, workspace-aware gate. The
L3 upload policy (rate limit + own-folder) stays as the anti-abuse layer; an orphaned uploaded object
whose message insert is rejected is unreferenced, unreadable by others, and rate-limited (a later
pg_cron sweep can prune orphans).

**Proven:** under `free`, an audio message is **BLOCKED** (`voice notes are not included…`) while a
**text** message is **ALLOWED**; under `founding`, audio is **ALLOWED**.

### 3.4 historyDays — RLS window on `messages_select_member` (+ `dm_messages` select)
Add a single conjunct (no-op when unlimited/founding → cutoff `-infinity`):
```sql
... using (
  private.is_workspace_member(workspace_id)
  and (private.workspace_role(workspace_id) <> 'guest')
  and created_at >= private.workspace_history_cutoff(workspace_id)   -- NEW
)
```
`workspace_history_cutoff(ws)` = `now() - history_days*'1 day'` (or `-infinity` when unlimited).

**Chosen: RLS window (hide) over pg_cron prune (delete)** — reversible (upgrade re-reveals history),
no data loss, grandfathering trivial, and no destructive job on a live DB. (A pg_cron *storage-reclaim*
prune can be added later as an optimization, well behind the retention window.)

**Proven:** under `founding` a 40-day-old message is **visible**; under `free` (30 days) it is
**hidden** while a 1-day-old message stays visible.

---

## 4. Grandfathering + isolation/roles regression (all rolled back, all green)

| Guarantee | Result |
|-----------|--------|
| **Grandfathering** — existing workspaces (no subscription row) resolve to `founding` | effplan=founding, account cap=UNLIMITED, history cutoff=`-infinity`, voice=true; **all 4 gates no-op** |
| Seats: free 3/3 vs founding | create+accept **BLOCKED** on free, **ALLOWED** on founding |
| Workspaces: free 1/1 vs founding | create_workspace **BLOCKED** on free, **ALLOWED** on founding |
| voiceNotes: free vs founding | audio **BLOCKED** on free (text ok), **ALLOWED** on founding |
| historyDays: free 30d vs founding | old msg **hidden** on free, **visible** on founding |
| **45/45 isolation** — outsider under the amended message policy | qassem sees **0** CC messages / 0 total (added AND-conjunct only narrows) |
| **35/35 roles** — plan layer composes after role layer | member + outsider still **BLOCKED by the role check**, not the plan check, under founding and free |

Values verified equal to `src/lib/plans.js` (§1 table). Security advisors were clean throughout the
prior applied fixes; this design adds no SECURITY-advisor surface (private DEFINER helpers,
search_path='', least-privilege grants) but advisors will be re-run at apply time.

---

## 5. If approved — apply plan (one migration, or split per concern)

1. Create `private.plan_limits` (+ seed) and `private.workspace_subscriptions`; grants: no
   anon/authenticated table grants; EXECUTE on helpers to `authenticated` only.
2. Create the seven helper functions (DEFINER, `search_path=''`).
3. `create or replace` the three RPC impls (`_create_invitation`, `_accept_invitation`,
   `_create_workspace`) with the plan guards composed in.
4. Add the `enforce_voice_notes_plan` trigger to `messages` + `dm_messages` (EXECUTE revoked).
5. Amend `messages_select_member` and `dm_messages_select_participant` with the history conjunct.
6. Re-run: security advisors, the 45/45 isolation line, the 35/35 role line, the per-user baseline
   (must be unchanged — every existing workspace is founding).

## 6. Still client-side / follow-ups (out of scope for this enforcement pass)
- **Stripe webhook write path** (`apply_stripe_subscription_event`) that populates
  `workspace_subscriptions` — the actual billing integration (its own design doc exists).
- **Client read model:** an owner-facing view/RPC to read a workspace's `effective_plan_id`, and
  pointing `resolvePlanId` at it (today it returns `founding`). Client gates remain as UX; RLS/RPCs
  become the wall.
- **Go-live default** (`founding`→`free` for new accounts) — §3.2 decision point.
- Optional: count pending invites in the create-time seat gate (over-provisioning refinement);
  pg_cron orphaned-voice-object sweep; pg_cron history storage-reclaim.

---
*No app code changed in this pass (design doc only) → build/lint stays 31/2. No DB change applied.*
