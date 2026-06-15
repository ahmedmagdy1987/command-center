/* =============================================================================
   BILLING — the single payment seam.

   EVERYTHING about taking money lives behind billing.startCheckout(). Today it
   only captures intent (no charge, no card, no payment SDK). To go live, replace
   the body of startCheckout() with a real provider (e.g. create a Stripe Checkout
   Session server-side and redirect to it) and flip `isLive` — nothing else in the
   app needs to change. The pricing page and checkout screen call ONLY this object.
============================================================================= */
import { PLANS, BILLING_CYCLE } from './plans';

export const billing = {
  /** Flip to true once a real payment provider is wired into startCheckout(). */
  isLive: false,

  /**
   * Begin the upgrade for a plan. STUB: captures intent only — it never charges.
   *
   * @returns {Promise<{ status: 'pending_provider'|'live', planId: string, cycle: string }>}
   *
   * ── REPLACE-ME SEAM ──────────────────────────────────────────────────────
   * Live version (sketch):
   *   const { url } = await createCheckoutSession({ planId, cycle, workspaceId });
   *   window.location.assign(url);   // hand off to the provider
   *   return { status: 'live', planId, cycle };
   */
  async startCheckout({ planId, cycle = BILLING_CYCLE.monthly, email, workspaceId } = {}) {
    const plan = PLANS[planId];
    if (!plan || !plan.paid) throw new Error('That plan is not purchasable.');

    // Capture intent locally so it isn't lost (useful as an early demand signal).
    try {
      const intent = { planId, cycle, email: email || null, workspaceId: workspaceId || null, at: new Date().toISOString() };
      localStorage.setItem('cc:billingIntent', JSON.stringify(intent));
    } catch { /* ignore storage failures */ }

    // No provider connected yet.
    console.info('[billing] checkout intent captured (no payment provider connected yet):', { planId, cycle });
    return { status: 'pending_provider', planId, cycle };
  },
};
