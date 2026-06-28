# Stripe Sandbox Billing Phase 1 Recon

Status: Phase 1 only. No production integration was implemented, no paywall was activated, no Edge Functions were deployed, no permanent Supabase database change was applied, and no Stripe sandbox or live object was created.

Supabase project: `nqlzjuxqgajeoypyzlnv`

Production app: `https://tasks.opscommandcenter.com`

Repository HEAD before Phase 1 work: `12104daca91f`

## Scope Guardrails

- Use Stripe sandbox terminology only.
- Do not use or request a live Stripe key.
- Do not modify the WebsitesToLove live Stripe account.
- Do not create live Stripe products, prices, customers, webhooks, or subscriptions.
- Do not create permanent Stripe sandbox objects in Phase 1.
- Do not make permanent Supabase database changes in Phase 1.
- Stop after recon, architecture, and rolled-back proof.

Supabase MCP note: `.mcp.json` points to the Supabase MCP endpoint for project `nqlzjuxqgajeoypyzlnv`, but this Codex session exposed only Google Drive MCP tools. Remote schema/RLS execution through MCP could not be performed from this tool session. Local migrations and code were inspected, and the proof script is written for execution through Supabase MCP `execute_sql` or the Supabase SQL editor.

## Current Billing Implementation Findings

Relevant files inspected:

- `src/lib/plans.js`
- `src/lib/entitlements.js`
- `src/lib/billing.js`
- `src/PricingPage.jsx`
- `src/CheckoutScreen.jsx`
- `src/App.jsx`
- `src/VisualTaskCommandCenter.jsx`
- `src/lib/api.js`
- `supabase/migrations/*`
- `CLAUDE.md`
- `ROLES_AND_PERMISSIONS.md`

### Internal Plan IDs

| Internal plan ID | Displayed | Paid | Current behavior |
| --- | --- | --- | --- |
| `founding` | No | No | Hidden all-access default for every user/workspace today. |
| `free` | Yes | No | Public Free plan, currently only reachable through preview or pricing copy. |
| `pro` | Yes | Yes | Public paid plan, Checkout intent stub only. |
| `business` | Yes | Yes | Public paid plan, de-emphasized in pricing UI, Checkout intent stub only. |

### Plans Displayed On Pricing Page

The pricing page displays:

- Free and Pro as the primary plan cards.
- Business as a secondary strip.
- Free, Pro, and Business in the comparison table.
- Founding is hidden.

### Current Price Copy

Prices are explicitly marked as hypotheses in code.

| Plan | Monthly copy | Annual copy | Annual savings shown |
| --- | ---: | ---: | ---: |
| Free | `$0 forever` | `$0 forever` | None |
| Pro | `$19/mo`, billed monthly | `$16/mo` monthly equivalent, `$190 billed yearly` | `$38`, about 2 months |
| Business | `$49/mo`, billed monthly | `$41/mo` monthly equivalent, `$490 billed yearly` | `$98`, about 2 months |

Stripe sandbox Phase 2 price amounts should be:

- Pro monthly: `1900` USD cents, recurring monthly.
- Pro yearly: `19000` USD cents, recurring yearly.
- Business monthly: `4900` USD cents, recurring monthly.
- Business yearly: `49000` USD cents, recurring yearly.

### Current Entitlement Matrix

| Capability / Limit | Founding | Free | Pro | Business |
| --- | --- | --- | --- | --- |
| Seats per workspace | Unlimited | 3 | 15 | 50 |
| Owned workspaces | Unlimited | 1 | 3 | 10 |
| Message history | Unlimited | 30 days | Unlimited | Unlimited |
| Tasks, board, priority matrix, schedule | Yes | Yes | Yes | Yes |
| Recurring tasks | Yes | Yes | Yes | Yes |
| Bulk import | Yes | Yes | Yes | Yes |
| Team chat and direct messages | Yes | Yes | Yes | Yes |
| Realtime sync and notifications | Yes | Yes | Yes | Yes |
| JSON export | Yes | Yes | Yes | Yes |
| Voice notes | Yes | No | Yes | Yes |
| Priority support | Yes | No | No | Yes |

Gateable feature keys:

- `voiceNotes`
- `recurringTasks`
- `bulkImport`
- `prioritySupport`

Limit keys:

- `seats`
- `workspaces`
- `historyDays`

### Current `resolvePlanId()` Implementation

Exact behavior:

- Reads `?plan=free|pro|business|founding`.
- If valid, stores it in `sessionStorage` as `cc:previewPlan`.
- If no URL plan exists, reads `cc:previewPlan`.
- If a preview plan exists, returns it.
- Otherwise returns `DEFAULT_PLAN_ID`.
- `DEFAULT_PLAN_ID` is `founding`.
- The `workspaceId` argument is currently ignored.

Current function:

```js
export function resolvePlanId(/* workspaceId - reserved for the future per-workspace DB plan lookup */) {
  const preview = getPreviewPlanId();
  if (preview) return preview;
  // FUTURE: return workspace?.planId ?? 'free';
  return DEFAULT_PLAN_ID;
}
```

### One-Line Paywall Activation Seam

The activation seam is either:

- `src/lib/plans.js`: change `DEFAULT_PLAN_ID` from `founding` to `free`, or
- `src/lib/entitlements.js`: change the final return in `resolvePlanId()` from `DEFAULT_PLAN_ID` to `free` or a DB-backed plan.

Changing it today would only activate a client-side paywall:

- Voice-note buttons would lock for Free.
- Seat/workspace limit UI would start showing upgrade prompts.
- Plan display would change from Founding to Free.
- The database would still allow direct API calls wherever RLS permits them.
- No subscription state would be verified server-side.
- No Stripe payment state would be authoritative.

Do not flip this seam until server-side billing and entitlement enforcement exist.

### Current Entitlement Scope

The current entitlement layer is globally mocked with some workspace/account usage inputs:

- Plan resolution is not DB-backed.
- `resolvePlanId(currentWorkspaceId)` receives a workspace ID but ignores it.
- `seatCount` is current workspace member count.
- `ownedWorkspaceCount` is the count of workspaces where the current user has role `owner`.
- The code comments currently describe a per-account subscription model, but this Phase 1 design must use workspace-level subscriptions per the current objective.

### Pricing And Entitlement Mismatches

Confirmed mismatches and launch blockers:

- `plans.js` and `entitlements.js` comments describe one subscription per account/owner, while the required billing design is one subscription per workspace.
- `CheckoutScreen.jsx` says a plan upgrades a workspace, which matches the new requirement but conflicts with the older comments.
- `?plan=` preview can spoof Pro, Business, or Founding in the browser and unlock client-side gated UI.
- Voice notes, workspace creation limits, seat limits, and bulk import are not server-enforced by plan.
- Existing users are Founding by default; there is no DB concept for grandfathered workspaces yet.
- There is no permanent billing table, subscription table, customer mapping, webhook table, plan column, or entitlement read model in Supabase.

### Dormant Billing UI And Helpers

`src/lib/billing.js` exposes `billing.startCheckout()`.

Current behavior:

- `billing.isLive` is `false`.
- Paid plan validation is local only.
- It writes `cc:billingIntent` to `localStorage`.
- It logs a non-sensitive checkout-intent message.
- It returns `{ status: 'pending_provider', planId, cycle }`.
- It never charges, never calls Stripe, and never writes Supabase.

`src/CheckoutScreen.jsx` is also a stub:

- Signed-out users are sent to sign in.
- Signed-in users enter an email.
- Submit calls `billing.startCheckout()`.
- Success says no charge was made.

### Workspace Ownership And Role Checks

Current authority:

- `workspace_members.role` is the per-workspace authority.
- Role ladder: `owner > admin > member > guest`.
- `members.role` is vestigial profile data, not authorization.
- Owner/admin/member/guest are resolved in `AppProvider` from `workspaceMembers.listMine()`.
- `private.workspace_role()` and `private.workspace_role_rank()` enforce DB role logic.
- `private.is_workspace_owner()` gates owner-only DB logic.
- Role changes happen only through RPCs.

Billing requirement:

- Only `owner` can manage billing.
- Admin/member/guest cannot manage billing, assign plans, or write Stripe-controlled state.

### Current Routes Suitable For Billing

Existing public/auth routes:

- `/pricing`: pricing page.
- `/checkout`: dormant checkout-intent page.
- `/login`, `/signup`: auth entry.
- `/`: authenticated app shell or public landing.

Existing app routes:

- `/members`: owner/admin member management.
- No `/settings`, `/account`, `/billing`, or workspace settings route currently exists.

Phase 2 recommendation:

- Reuse `/pricing` for plan selection.
- Replace or extend `/checkout` as the Checkout return route for success/cancel/sync states.
- Add a small owner-only in-app billing settings route, for example `/billing`, because no current settings route is suitable.

### Existing Edge Functions And Env Conventions

Existing Supabase Edge Functions:

- None found. There is no `supabase/functions/` directory.

Existing tracked client environment names:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

`.env` is gitignored. No local `.env` file existed in this checkout.

### Current Supabase Objects That Could Conflict

No existing local migration or source file defines:

- `workspace_subscriptions`
- `stripe_webhook_events`
- Stripe customer columns
- Stripe subscription columns
- Stripe price columns
- Billing tables
- Plan columns
- Entitlement tables

Potential naming conflicts to avoid:

- `public.invitations` already uses `status`, `role`, and `token` patterns.
- `private` schema already exists and is the correct place for private helper functions.
- `public.create_workspace`, `public.create_invitation`, and role RPCs already define the sanctioned write-path style.

### Security Issue: Client-Side Plan Spoofing

Today, any authenticated browser user can append `?plan=pro`, `?plan=business`, or `?plan=founding` and the UI will compute those entitlements for the session. This is intentional for preview/demo but is not secure for paid plans.

Impact after paywall activation if not fixed:

- A user could unlock client-side voice-note UI.
- A user could bypass client-side seat/workspace limits.
- Direct Supabase API calls could create rows wherever RLS allows, regardless of plan.

Server-side entitlement enforcement is a launch blocker before paid access is real.

## Proposed Workspace-Level Billing Architecture

### Principle

Stripe is the payment processor. Stripe webhooks are the authoritative billing event source. Supabase is the application read model for effective workspace plan and subscription state. The browser is never authoritative.

### Recommended Storage Model

Use private tables for sensitive Stripe identifiers, plus a safe public RPC for app reads.

Recommended tables:

- `private.workspace_subscriptions`
- `private.stripe_webhook_events`

Reason:

- Stripe identifiers should not be exposed directly to authenticated clients.
- The app only needs effective plan, status, interval, renewal/cancellation date, and `can_manage_billing`.
- Edge Functions can write through service-role-only RPCs.
- Browser reads can go through a least-data `public.get_workspace_billing_summary(workspace_id)` RPC.

### Proposed `private.workspace_subscriptions`

Minimum fields:

| Column | Purpose |
| --- | --- |
| `id uuid primary key` | Internal row ID. |
| `workspace_id uuid not null references public.workspaces(id) on delete cascade` | Tenant boundary. |
| `stripe_customer_id text` | Trusted Stripe sandbox customer mapping. Private. |
| `stripe_subscription_id text` | Trusted Stripe sandbox subscription mapping. Private. |
| `stripe_price_id text` | Last trusted recurring price. Private. |
| `internal_plan_id text not null` | `free`, `pro`, `business`, or `founding` if explicitly grandfathered. |
| `billing_interval text` | `monthly`, `annual`, or null for free/no subscription. |
| `subscription_status text not null` | Stripe subscription status or `none`. |
| `current_period_start timestamptz` | Stripe period start. |
| `current_period_end timestamptz` | Stripe period end / renewal date. |
| `cancel_at_period_end boolean not null default false` | Stripe cancellation flag. |
| `trial_end timestamptz` | Trial end, if any. |
| `last_stripe_event_id text` | Last applied event ID. |
| `last_stripe_event_created timestamptz` | Last applied Stripe event creation timestamp. |
| `created_at timestamptz not null default now()` | Audit. |
| `updated_at timestamptz not null default now()` | Audit. |

Additional recommended fields:

- `stripe_checkout_session_id text` only if operational support needs it. Not required for entitlement.
- `stripe_product_id text` not required if price ID maps to plan/interval server-side.
- Customer email/name should not be stored unless a support workflow requires it.

Do not store:

- Card numbers
- Bank details
- Payment method secrets
- Full payment method data
- Unnecessary customer personal data

### Proposed `private.stripe_webhook_events`

Fields:

| Column | Purpose |
| --- | --- |
| `event_id text primary key` | Stripe event ID for idempotency. |
| `event_type text not null` | Stripe event type. |
| `stripe_created timestamptz not null` | Stripe event created timestamp. |
| `workspace_id uuid references public.workspaces(id)` | Resolved workspace, when known. |
| `stripe_customer_id text` | Resolved customer, private. |
| `stripe_subscription_id text` | Resolved subscription, private. |
| `processed_at timestamptz not null default now()` | Processing audit. |
| `processing_error text` | Optional support/debug field. |

The event table should be written before state application in the same transaction. Duplicate event IDs no-op.

## Proposed Constraints And Indexes

Recommended constraints:

- `workspace_id` is not null and references `public.workspaces(id)` with `on delete cascade`.
- `internal_plan_id in ('free','pro','business','founding')`.
- `billing_interval is null or in ('monthly','annual')`.
- `subscription_status in ('none','incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')`.
- `current_period_end >= current_period_start` when both are present.
- `stripe_customer_id` unique where not null.
- `stripe_subscription_id` unique where not null.
- `workspace_id` unique for the active/current workspace billing record.

Recommended indexes:

- Unique: `private.workspace_subscriptions(workspace_id)`.
- Unique partial: `private.workspace_subscriptions(stripe_customer_id) where stripe_customer_id is not null`.
- Unique partial: `private.workspace_subscriptions(stripe_subscription_id) where stripe_subscription_id is not null`.
- Index: `(subscription_status, internal_plan_id)`.
- Primary key: `private.stripe_webhook_events(event_id)`.
- Index: `private.stripe_webhook_events(stripe_subscription_id)`.
- Index: `private.stripe_webhook_events(workspace_id, stripe_created desc)`.

These prevent:

- One workspace being linked to conflicting subscription rows.
- One Stripe customer being linked to multiple unrelated workspaces.
- One Stripe subscription being linked to multiple workspaces.
- Invalid plan IDs, intervals, and statuses.
- Missing workspace references.
- Cross-tenant billing records without a workspace.

## Subscription Status State Machine

Effective paid entitlements should be granted only when all are true:

- `internal_plan_id in ('pro','business')`
- `subscription_status in ('trialing','active')`
- `current_period_end is null or current_period_end > now()`

Safe fallback to Free:

- `none`
- `incomplete`
- `incomplete_expired`
- `past_due`
- `canceled`
- `unpaid`
- `paused`
- Any unknown status
- Expired `current_period_end`
- Missing or invalid plan/interval mapping

Cancellation behavior:

- If Stripe status remains `active` or `trialing` and `cancel_at_period_end = true`, paid access continues until `current_period_end`.
- When Stripe sends `customer.subscription.deleted` or status becomes `canceled`, effective plan falls back to `free`.

`past_due` and `unpaid` policy:

- Phase 2 should use the safe policy: no paid entitlements while `past_due` or `unpaid`.
- Tony can later approve a grace period, but that should be explicit and server-side.

## Proposed RLS And Grants

Recommended direct table access:

- `private.workspace_subscriptions`: no direct grants to `anon` or `authenticated`.
- `private.stripe_webhook_events`: no direct grants to `anon` or `authenticated`.
- RLS enabled with no client write policy.
- Service-role-only RPCs write private billing tables.

Safe client read:

- `public.get_workspace_billing_summary(p_workspace_id uuid)` returns safe, non-sensitive fields.
- Grant execute only to `authenticated`.
- Revoke from `public` and `anon`.

Suggested summary fields:

- `workspace_id`
- `effective_plan_id`
- `internal_plan_id` if needed, otherwise omit for non-owners
- `subscription_status` for Owner only
- `billing_interval` for Owner only
- `current_period_end` for Owner only
- `cancel_at_period_end` for Owner only
- `trial_end` for Owner only
- `can_manage_billing`

Role behavior:

| Caller | Read behavior | Write/manage behavior |
| --- | --- | --- |
| Owner | Can read safe complete billing summary for own workspace. Cannot directly write Stripe-controlled fields from browser. Can manage billing only through Edge Functions. |
| Admin | Can read minimum effective plan state if app needs it. Cannot manage billing or write billing rows. |
| Member | Can read minimum effective plan state if app needs it. Cannot manage billing or write billing rows. |
| Guest | Can read only effective plan if UI needs it. Cannot manage billing or write billing rows. |
| Outsider | Gets zero summary rows. Cannot insert, update, or delete billing records. |

All SECURITY DEFINER functions must:

- `SET search_path = ''`
- Fully qualify object names.
- Validate `auth.uid()`.
- Validate workspace membership.
- Validate Owner role where billing management is requested.
- Avoid user-controlled dynamic SQL.
- Revoke `EXECUTE` from `PUBLIC`.
- Revoke `EXECUTE` from `anon`.
- Revoke `EXECUTE` from `authenticated` unless intentionally client-callable.

Client-callable functions must not accept trusted Stripe identifiers from the browser.

## Proposed RPCs

### `public.get_workspace_billing_summary(workspace_id)`

Client-callable.

Responsibilities:

- Validate `auth.uid()` is present.
- Validate the caller is a member of the workspace.
- Return zero rows for outsiders.
- Return no Stripe IDs.
- Return `can_manage_billing = true` only for `owner`.
- Compute `effective_plan_id` server-side.

### Service-role-only billing write RPC

Suggested name:

- `public.apply_stripe_subscription_event(...)`

or keep the implementation private and expose a public service-role-only wrapper.

Responsibilities:

- Validate event ID idempotency.
- Validate workspace/customer/subscription mappings.
- Apply updates transactionally.
- Ignore stale out-of-order events.
- Never trust browser input.

Grant:

- `service_role` only.
- Revoke from `public`, `anon`, and `authenticated`.

## Proposed Edge Functions

Do not deploy in Phase 1.

### `create-checkout-session`

Input:

- `workspace_id`
- internal `plan_id` only: `pro` or `business`
- internal `billing_interval` only: `monthly` or `annual`

Must not accept:

- Arbitrary Stripe Price ID
- Stripe customer ID
- Stripe subscription ID
- Subscription dates
- Subscription status

Responsibilities:

- Require a valid Supabase user JWT.
- Verify the caller is workspace Owner.
- Resolve the sandbox Stripe Price ID from server-side env allowlist.
- Load trusted workspace/customer mapping server-side.
- Safely reuse or create a Stripe sandbox customer.
- Store or update the trusted customer mapping only through service-role/server path.
- Refuse if the workspace already has a conflicting active/trialing subscription.
- Create Stripe Checkout Session with `mode=subscription`.
- Set trusted metadata, for example:
  - `workspace_id`
  - `owner_user_id`
  - `internal_plan_id`
  - `billing_interval`
  - `app_environment=sandbox`
- Use server-controlled success and cancel URLs.
- Return only the Checkout URL, or only a Session ID if the frontend redirects through Stripe.js later.
- Use idempotency key such as `checkout:{workspace_id}:{plan_id}:{billing_interval}:{owner_user_id}` for retries.

### `create-customer-portal-session`

Input:

- `workspace_id` only

Must not accept:

- `stripe_customer_id`

Responsibilities:

- Require a valid Supabase user JWT.
- Verify caller is workspace Owner.
- Load trusted Stripe customer mapping server-side.
- Create a Stripe Customer Portal Session in sandbox.
- Use server-controlled `return_url`.
- Return only the portal URL.

### `stripe-webhook`

Input:

- Raw Stripe webhook request body.

Responsibilities:

- Be publicly reachable for Stripe.
- Do not require a Supabase user JWT.
- Verify `Stripe-Signature` against the raw request body.
- Use `STRIPE_WEBHOOK_SECRET` from Supabase secrets.
- Use `STRIPE_SECRET_KEY` from Supabase secrets.
- Reject invalid signatures.
- Insert/check Stripe event ID before applying state.
- Be safe under duplicate delivery.
- Ignore stale out-of-order state updates.
- Resolve workspace mapping from trusted stored mapping and trusted Checkout metadata.
- Reject ambiguous customer/subscription mappings.
- Write billing state transactionally through a service-role-only RPC.
- Never trust browser data.
- Never log secrets.
- Return quickly with correct HTTP status codes.

Recommended event handling:

| Stripe event | Phase 2 handling |
| --- | --- |
| `checkout.session.completed` | Use to validate Checkout completion, resolve workspace metadata, and fetch/store trusted customer/subscription mapping. Not final entitlement authority if subscription event follows. |
| `customer.subscription.created` | Authoritative subscription state. |
| `customer.subscription.updated` | Authoritative subscription state. |
| `customer.subscription.deleted` | Authoritative cancellation/fallback state. |
| `invoice.paid` | Not required for v1 entitlement transitions if subscription events are handled. Can be logged later. |
| `invoice.payment_failed` | Not required for v1 entitlement transitions if subscription status updates to `past_due`/`unpaid` are handled. Can be logged later. |

### `get-billing-summary`

Probably not needed as an Edge Function if `public.get_workspace_billing_summary()` exists. Prefer the safe RPC for app reads. An Edge Function can be added only if the UI needs additional server orchestration.

## Idempotency And Event Ordering Strategy

Smallest correct strategy:

1. In `stripe-webhook`, verify signature first.
2. Start a DB transaction through a service-role-only RPC.
3. Insert `event.id` into `private.stripe_webhook_events`.
4. If insert conflicts, return success without reprocessing.
5. Resolve the workspace by trusted stored mappings:
   - Prefer existing `stripe_subscription_id`.
   - Else use existing `stripe_customer_id`.
   - Else for `checkout.session.completed`, validate session metadata and create mapping.
6. Reject if subscription/customer maps to a different workspace.
7. Apply subscription status only if `event.created >= last_stripe_event_created`.
8. Store `last_stripe_event_id` and `last_stripe_event_created`.

This handles:

- Duplicate webhook deliveries.
- Delayed events.
- Out-of-order events.
- Webhook retries.
- Conflicting customer mappings.
- Conflicting subscription mappings.
- Replay attempts.

## Stripe Sandbox Product And Price Plan

Do not create these in Phase 1.

Create these in Stripe sandbox in Phase 2 only after approval:

| Product | Description | Price | Interval | Currency | Internal plan | Env var |
| --- | --- | ---: | --- | --- | --- | --- |
| Command Center Pro | Coordinate a growing, distributed team. | 1900 | month | USD | `pro` | `STRIPE_PRO_MONTHLY_PRICE_ID` |
| Command Center Pro | Coordinate a growing, distributed team. | 19000 | year | USD | `pro` | `STRIPE_PRO_YEARLY_PRICE_ID` |
| Command Center Business | Run several teams from one hub. | 4900 | month | USD | `business` | `STRIPE_BUSINESS_MONTHLY_PRICE_ID` |
| Command Center Business | Run several teams from one hub. | 49000 | year | USD | `business` | `STRIPE_BUSINESS_YEARLY_PRICE_ID` |

Recommended Stripe metadata on Products:

- `app=command-center`
- `environment=sandbox`
- `internal_plan_id=pro` or `business`

Recommended Stripe metadata on Prices:

- `app=command-center`
- `environment=sandbox`
- `internal_plan_id=pro` or `business`
- `billing_interval=monthly` or `annual`

## Required Secrets And Env Vars

Supabase Edge Function secrets:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_REDACTED --project-ref nqlzjuxqgajeoypyzlnv
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_REDACTED --project-ref nqlzjuxqgajeoypyzlnv
supabase secrets set STRIPE_PRO_MONTHLY_PRICE_ID=price_REDACTED --project-ref nqlzjuxqgajeoypyzlnv
supabase secrets set STRIPE_PRO_YEARLY_PRICE_ID=price_REDACTED --project-ref nqlzjuxqgajeoypyzlnv
supabase secrets set STRIPE_BUSINESS_MONTHLY_PRICE_ID=price_REDACTED --project-ref nqlzjuxqgajeoypyzlnv
supabase secrets set STRIPE_BUSINESS_YEARLY_PRICE_ID=price_REDACTED --project-ref nqlzjuxqgajeoypyzlnv
supabase secrets set SITE_URL=https://tasks.opscommandcenter.com --project-ref nqlzjuxqgajeoypyzlnv
```

Do not put real values in tracked files.

No Stripe publishable key is required for a server-created Checkout URL redirect.

## Exact Stripe Dashboard Steps For Ahmed In Phase 2

All steps must be done in Stripe sandbox, not live mode.

1. Open Stripe Dashboard.
2. Switch to sandbox.
3. Confirm the account is the Stripe sandbox created for Command Center.
4. Create Product: `Command Center Pro`.
5. Add monthly recurring price:
   - USD `19.00`
   - Recurring monthly
   - Metadata: `app=command-center`, `environment=sandbox`, `internal_plan_id=pro`, `billing_interval=monthly`
6. Add yearly recurring price:
   - USD `190.00`
   - Recurring yearly
   - Same metadata with `billing_interval=annual`
7. Create Product: `Command Center Business`.
8. Add monthly recurring price:
   - USD `49.00`
   - Recurring monthly
   - Metadata: `app=command-center`, `environment=sandbox`, `internal_plan_id=business`, `billing_interval=monthly`
9. Add yearly recurring price:
   - USD `490.00`
   - Recurring yearly
   - Same metadata with `billing_interval=annual`
10. Copy sandbox Price IDs into Supabase secrets.
11. Configure Customer Portal in sandbox:
    - Enable subscription cancellation if Tony approves.
    - Enable subscription plan changes only between approved Pro/Business prices if Tony approves.
    - Set business name/branding for sandbox.
    - Do not enable payment methods or options not intended for launch.
12. Create a sandbox webhook endpoint after Edge Function deployment:
    - Endpoint: `https://nqlzjuxqgajeoypyzlnv.functions.supabase.co/stripe-webhook`
    - Events:
      - `checkout.session.completed`
      - `customer.subscription.created`
      - `customer.subscription.updated`
      - `customer.subscription.deleted`
13. Copy sandbox webhook signing secret into Supabase secrets.

## Phase 2 Edge Function Deployment Commands

Do not run in Phase 1.

```bash
supabase functions deploy create-checkout-session --project-ref nqlzjuxqgajeoypyzlnv
supabase functions deploy create-customer-portal-session --project-ref nqlzjuxqgajeoypyzlnv
supabase functions deploy stripe-webhook --project-ref nqlzjuxqgajeoypyzlnv
```

Webhook endpoint format:

```text
https://nqlzjuxqgajeoypyzlnv.functions.supabase.co/stripe-webhook
```

## Phase 2 Frontend Plan

Do not implement in Phase 1.

Pricing page:

- Use existing monthly/yearly toggle.
- Paid buttons call `create-checkout-session`.
- Free button keeps existing signup/app routing.
- Show loading/error states.
- Signed-out users authenticate before Checkout.

Workspace billing settings:

- Add owner-only `/billing` route or workspace settings panel.
- Show current plan.
- Show billing interval.
- Show subscription status.
- Show renewal or cancellation date.
- Show Manage Billing button.
- Show Upgrade button when appropriate.
- Show clear past-due/canceled messaging.

Non-owner behavior:

- Show effective plan only if needed.
- Hide billing management actions.

Checkout return:

- Use `/checkout?result=success` and `/checkout?result=cancel` or add `/billing/return`.
- Never grant paid access from redirect alone.
- Show synchronization state while waiting for webhook-updated Supabase state.
- Add refresh/polling against safe summary RPC if webhook processing is not immediate.

## Test Card Scenarios For Sandbox

Use Stripe sandbox test cards only.

- Basic successful payment: `4242 4242 4242 4242`, any future expiry, any three-digit CVC.
- Generic decline: `4000 0000 0000 0002`.
- Insufficient funds decline: `4000 0000 0000 9995`.
- Authentication required for on-session payments: `4000 0027 6000 3184`.
- Authentication required unless set up: `4000 0025 0000 3155`.
- Subscription update/cancel: use Customer Portal in sandbox and verify webhook updates Supabase.
- Duplicate webhook: resend an event from Stripe sandbox and confirm event ID is processed once.
- Out-of-order event: replay an older subscription event and confirm it cannot overwrite newer state.

Use Stripe's current official sandbox testing docs when running Phase 2 tests.

Reference links:

- Stripe sandbox testing: `https://docs.stripe.com/testing`
- Stripe webhook signature verification: `https://docs.stripe.com/webhooks/signature`
- Stripe subscription overview: `https://docs.stripe.com/billing/subscriptions/overview`
- Stripe Customer Portal setup: `https://docs.stripe.com/customer-management/activate-no-code-customer-portal`

## Test-Mode Acceptance Checklist

- Checkout Session can be created only by workspace Owner.
- Admin/member/guest cannot create Checkout Session.
- Customer Portal can be opened only by workspace Owner.
- Browser never sends Stripe Price ID.
- Browser never sends Stripe customer/subscription IDs.
- Webhook rejects invalid signatures.
- Duplicate webhook event ID is ignored.
- Subscription status comes from webhook, not redirect.
- `active` and `trialing` grant paid entitlements.
- `past_due`, `unpaid`, `canceled`, `paused`, `incomplete`, and `incomplete_expired` fall back to Free.
- Cross-workspace reads return zero.
- Direct billing table writes from authenticated users are denied.
- No Stripe IDs are exposed in app summary responses.

## Production Migration Checklist

Do not start until sandbox is green and Tony approves.

- Reconfirm plan/pricing with Tony.
- Reconfirm workspace-level billing vs any per-account exception.
- Create production Stripe products/prices only after explicit approval.
- Set production Supabase secrets with live keys only outside chat.
- Create production webhook endpoint after deployment.
- Run production webhook smoke test with Stripe CLI or Dashboard.
- Confirm no test key remains in production secrets.
- Confirm no live key is in repo.
- Activate server-side entitlement reads.
- Only then consider flipping the paywall seam.

## Rollback And Incident Recovery

Database:

- Keep billing migrations additive.
- If a billing migration must be rolled back, first disable Checkout creation.
- Keep existing task/workspace behavior independent of billing.
- Since entitlements should fall back to Free on missing/invalid state, a broken billing row should not grant paid access.

Stripe:

- Disable webhook endpoint if it is causing bad writes.
- Pause Checkout Session creation by disabling the Edge Function or feature flag.
- Use Customer Portal or Dashboard only in sandbox during testing.

Application:

- Revert the Phase 2 commit if production behavior regresses.
- Keep `resolvePlanId()` fallback conservative.
- Do not grant paid access based on Checkout return alone.

## Rolled-Back Proof

Proof script:

- `supabase/tests/stripe_sandbox_billing_rolled_back_proof.sql`

The proof creates proposed private billing tables, functions, policies, test workspaces, and assertions inside `BEGIN ... ROLLBACK`. It is designed to prove:

- Owner safe summary read.
- Cross-tenant zero reads.
- Admin/member/guest/outsider direct writes denied.
- Client-side plan and Stripe ID injection denied.
- Duplicate webhook event idempotency.
- Subscription/customer conflict detection.
- Trusted webhook update path.
- Cancellation and delinquent fallback policy.
- SECURITY DEFINER `search_path=''`.
- EXECUTE revocation.
- Rollback removes all proposed objects.

Post-rollback verification query:

```sql
select
  to_regclass('private.workspace_subscriptions') as workspace_subscriptions,
  to_regclass('private.stripe_webhook_events') as stripe_webhook_events,
  to_regprocedure('public.get_workspace_billing_summary(uuid)') as summary_rpc;
```

Expected after rollback:

- All three values are null.

## Unresolved Decisions Requiring Tony's Approval

1. Confirm workspace-level subscriptions replace the older per-account comments in code.
2. Confirm whether Founding remains all-access for existing workspaces after launch.
3. Confirm whether no billing row means `founding` during transition or `free` after paywall launch.
4. Confirm exact Pro and Business prices before creating Stripe sandbox Products/Prices.
5. Confirm whether `past_due` should fall back to Free immediately or get a grace period.
6. Confirm whether Customer Portal may allow cancellation, plan changes, and payment method updates.
7. Confirm whether Business should remain de-emphasized or become a full pricing card.
8. Confirm whether Phase 2 should add `/billing` as the owner billing settings route.
9. Confirm whether admins should see subscription status or only effective plan.
10. Confirm when server-side entitlement enforcement should be added for seats, workspace creation, and voice notes.

## Concise Phase 2 Implementation Plan

1. Add an approved Supabase migration for private billing tables, idempotency table, safe summary RPC, and service-role-only write RPC.
2. Re-run the rolled-back proof, then apply permanently only after green approval.
3. Create Stripe sandbox Products, Prices, Customer Portal config, and webhook endpoint.
4. Add Supabase Edge Functions:
   - `create-checkout-session`
   - `create-customer-portal-session`
   - `stripe-webhook`
5. Add app API helpers for Checkout, Portal, and billing summary.
6. Add owner-only billing settings UI.
7. Replace local checkout stub with server-created Checkout Session redirect.
8. Keep paywall inactive until webhook-backed entitlement state is proven.
9. Run sandbox test-card scenarios, duplicate webhook replay, and out-of-order event tests.
10. Stop again before production/live-mode work.
