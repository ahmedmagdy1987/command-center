/* =============================================================================
   ENTITLEMENTS — "what can this workspace do, and is it under its limits?"

   Pure logic (no React) so it's trivial to reason about and test. The app wires
   it into AppProvider, which calls computeEntitlements() with the current
   workspace's usage and exposes the result on context as `entitlements`
   (read it with useEntitlements()).
============================================================================= */
import { PLANS, DEFAULT_PLAN_ID, FEATURE_META } from './plans';

const KNOWN_PLAN_IDS = new Set(Object.keys(PLANS));

/* -----------------------------------------------------------------------------
   PLAN-RESOLUTION SEAM  ← the one place that decides which plan applies.

   The billing model is PER-ACCOUNT: one subscription per account (the owner)
   covers ALL the workspaces that account owns — not a plan per workspace. The
   `workspaces` limit caps how many workspaces one account may own.

   TODAY: every account resolves to DEFAULT_PLAN_ID ('founding' — all-access),
   so nothing is gated for existing users.

   LATER (the next, backend pass): read the account/owner's plan from the DB, e.g.
       return account?.planId ?? 'free';
   There is NO DB column for this yet — adding one is explicitly out of scope for
   this pass. When it lands, this function is the ONLY thing that changes.

   PREVIEW OVERRIDE (testing/demo only — never the source of truth for billing):
   append ?plan=free|pro|business|founding to any URL to experience that plan's
   gated UI. It is SESSION-scoped (clears when the tab closes), and the app shows a
   visible "Previewing the <plan> plan — Exit" banner with one-click reset, so a
   real user can never get silently stuck on a downgraded preview.
----------------------------------------------------------------------------- */
/** The active preview plan id (from ?plan= or sessionStorage), or null if not previewing. */
export function getPreviewPlanId() {
  try {
    if (typeof window === 'undefined') return null;
    const fromUrl = new URLSearchParams(window.location.search).get('plan');
    if (fromUrl && KNOWN_PLAN_IDS.has(fromUrl)) {
      try { sessionStorage.setItem('cc:previewPlan', fromUrl); } catch { /* ignore */ }
      return fromUrl;
    }
    const stored = sessionStorage.getItem('cc:previewPlan');
    if (stored && KNOWN_PLAN_IDS.has(stored)) return stored;
  } catch { /* ignore */ }
  return null;
}

/** Exit plan preview (clears the session override; the caller also strips ?plan from the URL). */
export function clearPreviewPlan() {
  try { sessionStorage.removeItem('cc:previewPlan'); } catch { /* ignore */ }
}

export function resolvePlanId(/* workspaceId — reserved for the future per-workspace DB plan lookup */) {
  const preview = getPreviewPlanId();
  if (preview) return preview;
  // FUTURE: return workspace?.planId ?? 'free';
  return DEFAULT_PLAN_ID;
}

/* -----------------------------------------------------------------------------
   computeEntitlements — resolve a plan + the workspace's current usage into a
   small, friendly API the UI uses to gate features and limits.

   usage inputs:
     seatCount           — members in the current workspace
     ownedWorkspaceCount — workspaces this user owns (the create-workspace lever)
----------------------------------------------------------------------------- */
export function computeEntitlements({ planId, seatCount = 0, ownedWorkspaceCount = 0, isPreview = false } = {}) {
  const plan = PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
  const limits = plan.limits;
  const usage = { seats: seatCount, workspaces: ownedWorkspaceCount };

  const limitOf = (key) => limits[key];
  const usageOf = (key) => usage[key] ?? 0;
  const isUnlimited = (key) => limitOf(key) === Infinity;
  const isOver = (key) => !isUnlimited(key) && usageOf(key) >= limitOf(key);
  const remaining = (key) => (isUnlimited(key) ? Infinity : Math.max(0, limitOf(key) - usageOf(key)));

  return {
    planId: plan.id,
    plan,
    limits,
    usage,
    isPreview,
    isFounding: plan.id === 'founding',
    isFree: plan.id === 'free',
    isPaid: !!plan.paid,
    /** Feature gate: true if the plan includes this power feature. */
    can: (featureKey) => plan.features?.[featureKey] === true,
    /** Limit helpers. */
    limitOf,
    usageOf,
    isUnlimited,
    isOver,
    remaining,
    atSeatLimit: isOver('seats'),
    atWorkspaceLimit: isOver('workspaces'),
    /** Upgrade-prompt copy for a gated feature/limit key. */
    metaFor: (key) => FEATURE_META[key] || null,
  };
}
