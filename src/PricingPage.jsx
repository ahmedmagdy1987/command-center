import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, ArrowRight, Minus, Users, MessagesSquare, Globe } from 'lucide-react';
import {
  PLANS, PUBLIC_PLAN_IDS, MAIN_PLAN_IDS, SECONDARY_PLAN_IDS, FEATURE_TABLE, PRICING_COPY, BILLING_CYCLE,
  monthlyEquivalent, priceFor, annualSavings, formatMoney, formatLimit, formatHistory,
} from './lib/plans';
import { SiteHeader, SiteFooter, Magnetic, Hairline } from './SiteChrome';
import { useRevealOnScroll } from './lib/motion';

/**
 * Public pricing page (/pricing). Reachable from the landing nav and from in-app upgrade prompts.
 * Built to the Corlyvo design direction (dark "ops console", Geist + Manrope, Corlyvo Blue to
 * fuchsia brand) and the audit glossary (Workspace = tenant, Members = seats, Messages).
 * Everything reads from lib/plans.js. Positioned BROADLY via benefits, never branded narrowly.
 * No invented stats, logos, or testimonials.
 *
 * Motion mirrors the landing page's system (transform/opacity only, zero dependencies): a staged
 * entrance for the header + plan cards (keyframes with fill:both, static styles = final state),
 * drifting radial-gradient glows (no blur() filters), scroll reveals for the below-fold sections
 * via the shared useRevealOnScroll, and the shared Magnetic primary-CTA treatment. One
 * `.pp-root` reduced-motion override kills every decoration; the page renders complete without it.
 */
const BENEFIT_ICONS = [Users, MessagesSquare, Globe];

export default function PricingPage({ session }) {
  const navigate = useNavigate();
  const rootRef = useRef(null);
  const [cycle, setCycle] = useState(BILLING_CYCLE.monthly);
  const annual = cycle === BILLING_CYCLE.annual;
  const plans = PUBLIC_PLAN_IDS.map(id => PLANS[id]);       // all public tiers — the comparison table
  const mainPlans = MAIN_PLAN_IDS.map(id => PLANS[id]);     // Free + Pro — the primary choice
  const secondaryPlans = SECONDARY_PLAN_IDS.map(id => PLANS[id]); // Business — de-emphasized strip

  useRevealOnScroll(rootRef);

  const onChoose = (plan) => {
    if (!plan.paid) { navigate(session ? '/' : (plan.ctaTo || '/signup')); return; }
    navigate(`/checkout?plan=${plan.id}&cycle=${cycle}`);
  };

  return (
    <div ref={rootRef} data-surface="dark" className="pp-root min-h-screen bg-canvas text-primary relative">
      <style>{`

        /* Entrance (fill: both; static styles = final state, so reduce shows the complete page) */
        @keyframes ppFadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .pp-in { animation: ppFadeUp .65s cubic-bezier(.22,1,.36,1) both; }

        /* Ambient drift (radial gradients — the gradient IS the softness, no blur() filters) */
        @keyframes ppDrift1 { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(48px,32px,0) scale(1.12); } }
        @keyframes ppDrift2 { from { transform: translate3d(0,0,0) scale(1.06); } to { transform: translate3d(-56px,24px,0) scale(.95); } }
        @keyframes ppComet { 0% { transform: translateX(-240px); opacity: 0; } 10% { opacity: 1; } 55%, 100% { transform: translateX(110vw); opacity: 0; } }
        .pp-comet { animation: ppComet 5.5s cubic-bezier(.4,0,.4,1) infinite; }

        /* Scroll reveals (hidden state exists ONLY when motion is allowed) */
        @media (prefers-reduced-motion: no-preference) {
          [data-lp-reveal] {
            opacity: 0;
            transform: translateY(22px);
            transition: opacity .65s ease var(--lp-d,0s), transform .65s cubic-bezier(.22,1,.36,1) var(--lp-d,0s);
          }
          [data-lp-reveal].lp-seen { opacity: 1; transform: translateY(0); }
        }

        /* Reduced motion: kill ALL decoration; static styles are the complete page */
        @media (prefers-reduced-motion: reduce) {
          .pp-root *, .pp-root { animation: none !important; transition: none !important; }
        }
      `}</style>

      {/* Background glows, clipped in their own layer so the page never scrolls sideways */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute top-[-8rem] left-1/4 w-[32rem] h-[32rem] rounded-full" style={{ background: 'radial-gradient(closest-side, rgba(91,103,241,.14), transparent 72%)', animation: 'ppDrift1 26s ease-in-out infinite alternate' }} />
        <div className="absolute top-1/3 -right-40 w-[30rem] h-[30rem] rounded-full" style={{ background: 'radial-gradient(closest-side, rgba(61,214,179,.10), transparent 72%)', animation: 'ppDrift2 32s ease-in-out infinite alternate' }} />
      </div>

      <SiteHeader session={session} />

      <main className="relative max-w-6xl mx-auto px-5 lg:px-8">
        {/* Hero (compact: the three plan cards fit above the fold on a typical laptop) */}
        <section className="pt-6 lg:pt-8 pb-5 text-center">
          <div className="pp-in inline-flex items-center gap-1.5 text-meta font-medium uppercase tracking-widest text-brand-text/80 bg-brand/10 border border-brand-hover/20 rounded-full px-3 h-7 mb-3" style={{ animationDelay: '.05s' }}>
            {PRICING_COPY.eyebrow}
          </div>
          <h1 className="pp-in text-2xl lg:text-3xl font-semibold font-brand tracking-tight leading-[1.12] max-w-2xl mx-auto" style={{ animationDelay: '.12s' }}>
            {PRICING_COPY.headline}
          </h1>
          <p className="pp-in mt-2.5 text-sm lg:text-base text-muted max-w-xl mx-auto leading-relaxed" style={{ animationDelay: '.22s' }}>
            {PRICING_COPY.sub}
          </p>
          <div className="pp-in mt-3.5 flex flex-wrap justify-center gap-x-6 gap-y-1.5 text-note text-muted" style={{ animationDelay: '.32s' }}>
            {PRICING_COPY.benefits.map((b, i) => {
              const Icon = BENEFIT_ICONS[i] || Check;
              return (
                <span key={b} className="inline-flex items-center gap-2">
                  <Icon className="w-4 h-4 text-brand-text" />{b}
                </span>
              );
            })}
          </div>
        </section>

        {/* Billing-cycle toggle */}
        <div className="pp-in flex items-center justify-center gap-3 mb-5" style={{ animationDelay: '.42s' }}>
          <div className="inline-flex items-center p-1 rounded-full border border-line bg-fill-subtle">
            <button onClick={() => setCycle(BILLING_CYCLE.monthly)}
              className={cycleBtn(!annual)}>Monthly</button>
            <button onClick={() => setCycle(BILLING_CYCLE.annual)}
              className={cycleBtn(annual)}>
              Annual
              <span className="ml-1.5 text-micro font-semibold text-success-text">{PRICING_COPY.annualBadge}</span>
            </button>
          </div>
        </div>

        {/* Primary choice: Free + Pro, two-up and centered. Entrance lives on WRAPPER divs so the
            fill:both animation can never pin the card's transform against its hover lift. */}
        <section className="grid md:grid-cols-2 gap-5 items-stretch max-w-3xl mx-auto">
          {mainPlans.map((plan, i) => (
            <div key={plan.id} className="pp-in" style={{ animationDelay: `${0.52 + i * 0.12}s` }}>
              <PlanCard plan={plan} annual={annual} onChoose={() => onChoose(plan)} />
            </div>
          ))}
        </section>

        {/* Secondary: Business, de-emphasized — full details live in the comparison table below */}
        {secondaryPlans.map(plan => (
          <div key={plan.id} className="pp-in mt-5 max-w-3xl mx-auto rounded-2xl border border-line-subtle bg-fill-subtle px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3" style={{ animationDelay: '.78s' }}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-base font-semibold font-brand">{plan.name}</span>
                <span className="text-note text-faint">{plan.tagline}</span>
              </div>
              <div className="mt-0.5 text-note text-muted">
                <span className="text-secondary font-medium">{formatMoney(monthlyEquivalent(plan, annual ? BILLING_CYCLE.annual : BILLING_CYCLE.monthly))}/mo</span>
                {' · '}{plan.highlights.join(' · ')}
              </div>
            </div>
            <button onClick={() => onChoose(plan)}
              className="shrink-0 h-9 px-4 rounded-xl border border-line bg-fill text-xs font-semibold text-primary hover:bg-fill-strong active:scale-[.97] transition-all inline-flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
              {plan.cta}<ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}

        {/* Early-access honesty note */}
        <p className="pp-in mt-6 text-center text-note text-faint max-w-2xl mx-auto" style={{ animationDelay: '.9s' }}>
          {PRICING_COPY.earlyAccessNote}
        </p>

        {/* Comparison table */}
        <section className="relative mt-10 py-16">
          <Hairline className="absolute top-0 inset-x-0" />
          <h2 data-lp-reveal className="text-2xl lg:text-3xl font-semibold font-brand tracking-tight text-center mb-8">Compare plans</h2>
          <div data-lp-reveal style={{ '--lp-d': '120ms' }} className="overflow-x-auto rounded-2xl border border-line-subtle bg-gradient-to-br from-fill-subtle to-transparent">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className="text-left font-medium text-muted px-5 py-4 w-[40%]">Features</th>
                  {plans.map(p => (
                    <th key={p.id} className="px-4 py-4 text-center">
                      <div className={cx('font-semibold font-brand', p.popular ? 'text-brand-text' : 'text-primary')}>{p.name}</div>
                      <div className="text-meta font-normal text-faint mt-0.5">
                        {p.paid ? `${formatMoney(monthlyEquivalent(p, annual ? BILLING_CYCLE.annual : BILLING_CYCLE.monthly))}/mo` : 'Free'}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FEATURE_TABLE.map((row, i) => (
                  <tr key={row.label} className={cx('border-b border-line-subtle last:border-b-0', i % 2 === 1 && 'bg-fill-subtle')}>
                    <td className="px-5 py-3 text-secondary">{row.label}</td>
                    {plans.map(p => (
                      <td key={p.id} className="px-4 py-3 text-center">{cellFor(row, p)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* CTA band */}
        <section className="relative pb-16">
          <Hairline className="absolute top-0 inset-x-0" />
          <div data-lp-reveal className="relative overflow-hidden rounded-2xl border border-brand-hover/20 bg-surface p-8 lg:p-12 text-center mt-16">
            <div className="absolute inset-0 bg-gradient-to-br from-brand/15 via-brand-alt/[0.07] to-transparent" aria-hidden="true" />
            <div className="absolute -top-24 left-1/2 -ml-48 w-96 h-96 rounded-full" aria-hidden="true" style={{ background: 'radial-gradient(closest-side, rgba(124,140,255,.18), transparent 70%)', animation: 'ppDrift1 18s ease-in-out infinite alternate' }} />
            <div className="absolute top-0 inset-x-0 h-px overflow-hidden" aria-hidden="true">
              <span className="pp-comet absolute top-0 h-px w-60 bg-gradient-to-r from-transparent via-brand-alt-text/80 to-transparent" style={{ opacity: 0 }} />
            </div>
            <h2 className="relative text-2xl lg:text-3xl font-semibold font-brand tracking-tight">Get your team in one place</h2>
            <p className="relative mt-2 text-muted">Start free in seconds. Bring in your people, inside or outside your company.</p>
            <div className="relative mt-6 flex justify-center gap-3">
              {session ? (
                <Magnetic>
                  <Link to="/" className="h-12 px-6 rounded-xl bg-brand hover:bg-brand-hover text-brand-fg font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-brand/20 hover:brightness-110 active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                    Back to Corlyvo <ArrowRight className="w-4 h-4" />
                  </Link>
                </Magnetic>
              ) : (
                <>
                  <Magnetic>
                    <Link to="/signup" className="h-12 px-6 rounded-xl bg-brand hover:bg-brand-hover text-brand-fg font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-brand/20 hover:brightness-110 active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                      Get started free <ArrowRight className="w-4 h-4" />
                    </Link>
                  </Magnetic>
                  <Link to="/login" className="h-12 px-6 rounded-xl border border-line bg-fill-subtle text-secondary font-medium text-sm flex items-center hover:bg-fill active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                    Log in
                  </Link>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

/* ── Local helpers + subcomponents ─────────────────────────────────────────── */
const cx = (...xs) => xs.filter(Boolean).join(' ');
const cycleBtn = (active) =>
  cx('inline-flex items-center h-9 px-4 rounded-full text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text',
    active ? 'bg-inverse text-inverse-fg' : 'text-muted hover:text-primary');

function cellFor(row, plan) {
  if (row.type === 'always') return <Check className="w-4 h-4 text-success-text mx-auto" />;
  if (row.type === 'limit') return <span className="text-secondary font-medium tabular-nums">{formatLimit(plan.limits[row.key])}</span>;
  if (row.type === 'history') return <span className="text-secondary font-medium">{formatHistory(plan.limits[row.key])}</span>;
  // feature
  return plan.features?.[row.key]
    ? <Check className="w-4 h-4 text-success-text mx-auto" />
    : <Minus className="w-4 h-4 text-faint mx-auto" />;
}

function PlanCard({ plan, annual, onChoose }) {
  const cycle = annual ? BILLING_CYCLE.annual : BILLING_CYCLE.monthly;
  const perMonth = monthlyEquivalent(plan, cycle);
  const savings = annualSavings(plan);
  const ctaCls = cx('h-10 w-full rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all active:scale-[.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text',
    plan.popular
      ? 'bg-brand-gradient-cta text-brand-fg hover:shadow-lg hover:shadow-brand/20 hover:brightness-110'
      : plan.paid
        ? 'bg-inverse text-inverse-fg hover:bg-inverse/90'
        : 'border border-line bg-fill text-primary hover:bg-fill-strong');
  const ctaBtn = (
    <button onClick={onChoose} className={ctaCls}>
      {plan.cta} <ArrowRight className="w-4 h-4" />
    </button>
  );
  return (
    <div className={cx(
      'relative h-full rounded-2xl border p-5 flex flex-col transition-all duration-300 hover:-translate-y-1',
      plan.popular && 'mt-3 md:mt-0',
      plan.popular
        ? 'border-brand-hover/40 bg-gradient-to-b from-brand/[0.10] to-fill-subtle shadow-2xl shadow-brand/10 hover:shadow-brand/15'
        : 'border-line-subtle bg-gradient-to-br from-fill-subtle to-transparent hover:border-brand-hover/25 hover:shadow-xl hover:shadow-brand/20',
    )}>
      {plan.popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 h-6 rounded-full bg-brand-gradient-cta text-brand-fg text-micro font-bold uppercase tracking-widest flex items-center shadow-lg shadow-brand/15">
          Most popular
        </div>
      )}

      <div className="mb-1 text-lg font-semibold font-brand tracking-tight">{plan.name}</div>
      <p className="text-note text-faint leading-relaxed min-h-[2rem]">{plan.tagline}</p>

      <div className="mt-3 mb-1 flex items-end gap-1.5">
        <span className="text-3xl lg:text-4xl font-semibold font-brand tabular-nums">{formatMoney(plan.paid ? perMonth : 0)}</span>
        <span className="text-sm text-faint mb-1.5">{plan.paid ? '/mo' : 'forever'}</span>
      </div>
      <div className="text-meta text-faint h-4">
        {plan.paid
          ? (annual ? `${formatMoney(priceFor(plan, BILLING_CYCLE.annual))} billed yearly${savings > 0 ? ` · save ${formatMoney(savings)}` : ''}` : 'Billed monthly')
          : 'No card required'}
      </div>

      {plan.popular
        ? <Magnetic className="mt-4 w-full">{ctaBtn}</Magnetic>
        : <div className="mt-4">{ctaBtn}</div>}

      <ul className="mt-4 space-y-2">
        {plan.inherits && <li className="text-note font-medium text-muted">Everything in {plan.inherits}, plus:</li>}
        {plan.highlights.map(h => (
          <li key={h} className="flex items-start gap-2 text-compact text-secondary">
            <Check className="w-4 h-4 text-success-text shrink-0 mt-0.5" />
            <span>{h}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
