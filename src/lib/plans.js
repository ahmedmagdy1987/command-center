/* =============================================================================
   PLANS — the single source of truth for Command Center's freemium packaging.

   Everything about monetization strategy lives here: tier names, the
   free-vs-paid feature map, all limits, prices (monthly + annual), and the
   pricing/upgrade copy. Tune strategy by editing THIS file; the entitlements
   layer, the gates, the pricing page, and the checkout screen all read from it.

   ⚠️  PRICES ARE A HYPOTHESIS. There is no market data behind these numbers —
       they are starting points for Tony to validate with real prospects, NOT
       market rates. Mark them as such anywhere they're discussed. See
       PRICING_IS_HYPOTHESIS below.

   This pass adds NO payment SDK and NO DB plan column:
     • Plan resolution seam  → lib/entitlements.js (resolvePlanId)
     • Payment seam          → lib/billing.js (billing.startCheckout)
============================================================================= */

// ── Gateable feature keys (the power-feature levers actually enforced in the UI) ──
export const FEATURE = {
  voiceNotes: 'voiceNotes',
  recurringTasks: 'recurringTasks',
  bulkImport: 'bulkImport',
  prioritySupport: 'prioritySupport',
};

// ── Limit keys (the "grows with success" levers) ──
export const LIMIT = {
  seats: 'seats',           // members per workspace
  workspaces: 'workspaces', // workspaces a user can own/create
  historyDays: 'historyDays', // message history retention (displayed now; backend-enforced later)
};

export const BILLING_CYCLE = { monthly: 'monthly', annual: 'annual' };
export const CURRENCY = 'USD';
export const CURRENCY_SYMBOL = '$';

// Prices below are unvalidated guesses. Keep this true until real validation.
export const PRICING_IS_HYPOTHESIS = true;

/* -----------------------------------------------------------------------------
   The plans.

   `founding` is the all-access, grandfathered plan that EVERY workspace
   resolves to in this pass (see lib/entitlements.js → DEFAULT_PLAN_ID). It is
   hidden from the pricing page. Defaulting to it guarantees the explicit
   constraint "nothing currently free for existing users suddenly breaks": every
   existing user keeps every feature. The Free/Pro/Business machinery is fully
   wired and testable (via the ?plan= preview override in entitlements.js) but
   does not bite anyone until a real per-workspace plan is read from the DB.
----------------------------------------------------------------------------- */
export const PLANS = {
  founding: {
    id: 'founding',
    name: 'Founding',
    hidden: true,        // never shown on the pricing page
    paid: false,
    grandfathered: true,
    tagline: 'Early access, every feature unlocked.',
    price: { monthly: 0, annual: 0 },
    limits: { seats: Infinity, workspaces: Infinity, historyDays: Infinity },
    features: { voiceNotes: true, recurringTasks: true, bulkImport: true, prioritySupport: true },
  },

  free: {
    id: 'free',
    name: 'Free',
    paid: false,
    tagline: 'Get your first team coordinated.',
    price: { monthly: 0, annual: 0 },
    limits: { seats: 3, workspaces: 1, historyDays: 30 },
    // Core task management + onboarding stay FREE so adoption isn't gated: recurring tasks and bulk
    // import are part of getting set up, not a power-team perk. Voice notes are the Pro upgrade.
    features: { voiceNotes: false, recurringTasks: true, bulkImport: true, prioritySupport: false },
    cta: 'Start free',
    ctaTo: '/signup',
    highlights: [
      'Up to 3 members',
      '1 workspace',
      'Unlimited tasks across board, priority matrix & schedule',
      'Recurring tasks & bulk import',
      'Team chat & direct messages',
      '30-day message history',
      'Export your data anytime',
    ],
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    paid: true,
    popular: true,
    tagline: 'Coordinate a growing, distributed team.',
    price: { monthly: 19, annual: 190 }, // HYPOTHESIS — annual ≈ 2 months free
    limits: { seats: 15, workspaces: 3, historyDays: Infinity },
    features: { voiceNotes: true, recurringTasks: true, bulkImport: true, prioritySupport: false },
    cta: 'Choose Pro',
    inherits: 'Free',
    highlights: [
      'Up to 15 members',
      '3 workspaces',
      'Voice notes in chat & DMs',
      'Unlimited message history',
    ],
  },

  business: {
    id: 'business',
    name: 'Business',
    paid: true,
    tagline: 'Run several teams from one hub.',
    price: { monthly: 49, annual: 490 }, // HYPOTHESIS — annual ≈ 2 months free
    limits: { seats: 50, workspaces: 10, historyDays: Infinity },
    features: { voiceNotes: true, recurringTasks: true, bulkImport: true, prioritySupport: true },
    cta: 'Choose Business',
    inherits: 'Pro',
    highlights: [
      'Up to 50 members',
      '10 workspaces',
      'Priority support',
    ],
  },
};

// Order + visibility on the pricing page (excludes the hidden `founding` plan).
export const PUBLIC_PLAN_IDS = ['free', 'pro', 'business'];

// The pricing page leads with Free + Pro as the primary choice; Business is still fully defined
// (and present in the comparison table) but de-emphasized into a secondary "larger teams" mention.
export const MAIN_PLAN_IDS = ['free', 'pro'];
export const SECONDARY_PLAN_IDS = ['business'];

// Billing model: ONE subscription per ACCOUNT (the owner), which covers ALL the workspaces that
// account owns — NOT a separate plan per workspace. The `workspaces` limit caps how many workspaces
// one account may own; `seats` caps members within each of those workspaces. (No DB plan column yet;
// every account resolves to `founding` — see entitlements.js → resolvePlanId.)

// The plan every workspace resolves to right now (see entitlements.js seam).
export const DEFAULT_PLAN_ID = 'founding';

/* -----------------------------------------------------------------------------
   Per-feature copy for the in-app "upgrade to unlock X" prompts. Each gateable
   lever names the cheapest tier that unlocks it so the modal can route there.
----------------------------------------------------------------------------- */
export const FEATURE_META = {
  // Voice notes are the only power FEATURE behind Pro now (recurring tasks + bulk import moved to
  // Free). seats/workspaces are the "grows with success" LIMITS that also route here.
  voiceNotes: {
    label: 'Voice notes',
    blurb: 'Record and send voice messages in team chat and direct messages. Great for briefing distributed teammates async.',
    tier: 'pro',
  },
  seats: {
    label: 'More members',
    blurb: 'Invite more people into this workspace: staff, freelancers, or outside collaborators.',
    tier: 'pro',
    isLimit: true,
  },
  workspaces: {
    label: 'More workspaces',
    blurb: 'Spin up a separate workspace for another team or client, each with its own tasks, members, and chat.',
    tier: 'pro',
    isLimit: true,
  },
};

/* -----------------------------------------------------------------------------
   The feature-comparison matrix for the pricing page. Driven from PLANS so the
   table can never drift from the plans themselves.
     type 'always'   → included on every tier (✓)
     type 'limit'    → shows the numeric limit (or "Unlimited")
     type 'history'  → shows the retention window
     type 'feature'  → shows ✓ / — based on plan.features[key]
----------------------------------------------------------------------------- */
export const FEATURE_TABLE = [
  { label: 'Members (seats)', type: 'limit', key: 'seats' },
  { label: 'Workspaces', type: 'limit', key: 'workspaces' },
  { label: 'Tasks, board, priority matrix & schedule', type: 'always' },
  { label: 'Recurring tasks', type: 'always' },
  { label: 'Bulk import', type: 'always' },
  { label: 'Team chat & direct messages', type: 'always' },
  { label: 'Message history', type: 'history', key: 'historyDays' },
  { label: 'Real-time sync & notifications', type: 'always' },
  { label: 'Export your data (JSON)', type: 'always' },
  // The only Free→Pro feature levers (✓ / —): keep these last so the upgrade reason stands out.
  { label: 'Voice notes', type: 'feature', key: 'voiceNotes' },
  { label: 'Priority support', type: 'feature', key: 'prioritySupport' },
];

/* -----------------------------------------------------------------------------
   Pricing-page positioning copy. Broad on purpose: "your whole team in one
   place, even the people who aren't in your company." The external/distributed
   angle is expressed through benefits — never branded narrowly as a freelancer
   or agency tool. Honest: no invented stats, logos, or testimonials.
----------------------------------------------------------------------------- */
export const PRICING_COPY = {
  eyebrow: 'Plans & pricing',
  headline: 'Your whole team in one place, even the people who aren’t in your company.',
  sub: 'Coordinate tasks and who’s-doing-what, and talk to your whole team in one shared hub: staff, freelancers, contractors, and outside collaborators. Start free, and upgrade as your team grows.',
  benefits: [
    'One shared place for who’s doing what',
    'Built-in team chat & direct messages',
    'Bring in anyone, inside or outside your company',
  ],
  // Honest early-access framing. Doubles as the reason existing users keep everything.
  earlyAccessNote:
    'Command Center is in early access, and founding members get every feature free for now. These are the plans we’re validating; pricing isn’t final.',
  annualLabel: 'Billed annually',
  monthlyLabel: 'Billed monthly',
  annualBadge: 'Save ~2 months',
};

/* ── Display helpers (pure; safe to import anywhere) ───────────────────────── */
export const formatLimit = (n) => (n === Infinity ? 'Unlimited' : `${n}`);
export const formatHistory = (days) => (days === Infinity ? 'Unlimited' : `${days} days`);
export const priceFor = (plan, cycle) => plan?.price?.[cycle] ?? 0;
/** Per-month figure to show, whichever cycle is selected (annual ÷ 12, rounded). */
export const monthlyEquivalent = (plan, cycle) =>
  cycle === BILLING_CYCLE.annual
    ? Math.round(priceFor(plan, BILLING_CYCLE.annual) / 12)   // whole dollars for a clean headline; exact annual total shown alongside
    : priceFor(plan, BILLING_CYCLE.monthly);
/** Dollars saved per year by paying annually vs 12× monthly. */
export const annualSavings = (plan) =>
  Math.max(0, priceFor(plan, BILLING_CYCLE.monthly) * 12 - priceFor(plan, BILLING_CYCLE.annual));
export const formatMoney = (amount) => {
  const n = Number(amount) || 0;
  const whole = Number.isInteger(n);
  return `${CURRENCY_SYMBOL}${whole ? n : n.toFixed(2)}`;
};
