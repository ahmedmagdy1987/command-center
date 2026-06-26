import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, ArrowRight, Minus, Users, MessagesSquare, Globe } from 'lucide-react';
import {
  PLANS, PUBLIC_PLAN_IDS, MAIN_PLAN_IDS, SECONDARY_PLAN_IDS, FEATURE_TABLE, PRICING_COPY, BILLING_CYCLE,
  monthlyEquivalent, priceFor, annualSavings, formatMoney, formatLimit, formatHistory,
} from './lib/plans';
import { SiteHeader, SiteFooter } from './SiteChrome';

/**
 * Public pricing page (/pricing). Reachable from the landing nav and from in-app upgrade prompts.
 * Built to the PRODUCT_AUDIT design direction (dark "ops console", Outfit + Fraunces, violet to
 * fuchsia brand) and the audit glossary (Workspace = tenant, Members = seats, Messages).
 * Everything reads from lib/plans.js. Positioned BROADLY via benefits, never branded narrowly.
 * No invented stats, logos, or testimonials.
 */
const BENEFIT_ICONS = [Users, MessagesSquare, Globe];

export default function PricingPage({ session }) {
  const navigate = useNavigate();
  const [cycle, setCycle] = useState(BILLING_CYCLE.monthly);
  const annual = cycle === BILLING_CYCLE.annual;
  const plans = PUBLIC_PLAN_IDS.map(id => PLANS[id]);       // all public tiers — the comparison table
  const mainPlans = MAIN_PLAN_IDS.map(id => PLANS[id]);     // Free + Pro — the primary choice
  const secondaryPlans = SECONDARY_PLAN_IDS.map(id => PLANS[id]); // Business — de-emphasized strip

  const onChoose = (plan) => {
    if (!plan.paid) { navigate(session ? '/' : (plan.ctaTo || '/signup')); return; }
    navigate(`/checkout?plan=${plan.id}&cycle=${cycle}`);
  };

  return (
    <div className="min-h-screen bg-[#070810] text-white relative">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Outfit:wght@300..700&display=swap');
        body { font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif; background: #070810; }
        .font-display { font-family: 'Fraunces', ui-serif, serif; font-optical-sizing: auto; font-weight: 500; }
        @keyframes float { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-20px); } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {/* Background glows, clipped in their own layer so the page never scrolls sideways */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-6rem] left-1/4 w-[28rem] h-[28rem] rounded-full bg-violet-500/10 blur-3xl" style={{ animation: 'float 9s ease-in-out infinite' }} />
        <div className="absolute top-1/3 -right-32 w-[26rem] h-[26rem] rounded-full bg-fuchsia-500/10 blur-3xl" style={{ animation: 'float 9s ease-in-out infinite reverse' }} />
      </div>

      <SiteHeader session={session} />

      <div className="relative max-w-6xl mx-auto px-5 lg:px-8">
        {/* Hero (compact: the three plan cards fit above the fold on a typical laptop) */}
        <section className="pt-6 lg:pt-8 pb-5 text-center" style={{ animation: 'fadeUp .5s ease' }}>
          <div className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-violet-300/80 bg-violet-500/10 border border-violet-400/20 rounded-full px-3 h-7 mb-3">
            {PRICING_COPY.eyebrow}
          </div>
          <h1 className="text-2xl lg:text-3xl font-semibold font-display tracking-tight leading-[1.12] max-w-2xl mx-auto">
            {PRICING_COPY.headline}
          </h1>
          <p className="mt-2.5 text-sm lg:text-base text-white/55 max-w-xl mx-auto leading-relaxed">
            {PRICING_COPY.sub}
          </p>
          <div className="mt-3.5 flex flex-wrap justify-center gap-x-6 gap-y-1.5 text-[12px] text-white/60">
            {PRICING_COPY.benefits.map((b, i) => {
              const Icon = BENEFIT_ICONS[i] || Check;
              return (
                <span key={b} className="inline-flex items-center gap-2">
                  <Icon className="w-4 h-4 text-violet-300" />{b}
                </span>
              );
            })}
          </div>
        </section>

        {/* Billing-cycle toggle */}
        <div className="flex items-center justify-center gap-3 mb-5">
          <div className="inline-flex items-center p-1 rounded-full border border-white/10 bg-white/[0.03]">
            <button onClick={() => setCycle(BILLING_CYCLE.monthly)}
              className={cycleBtn(!annual)}>Monthly</button>
            <button onClick={() => setCycle(BILLING_CYCLE.annual)}
              className={cycleBtn(annual)}>
              Annual
              <span className="ml-1.5 text-[10px] font-semibold text-emerald-300">{PRICING_COPY.annualBadge}</span>
            </button>
          </div>
        </div>

        {/* Primary choice: Free + Pro, two-up and centered */}
        <section className="grid md:grid-cols-2 gap-5 items-stretch max-w-3xl mx-auto">
          {mainPlans.map(plan => (
            <PlanCard key={plan.id} plan={plan} annual={annual} onChoose={() => onChoose(plan)} />
          ))}
        </section>

        {/* Secondary: Business, de-emphasized — full details live in the comparison table below */}
        {secondaryPlans.map(plan => (
          <div key={plan.id} className="mt-5 max-w-3xl mx-auto rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-base font-semibold font-display">{plan.name}</span>
                <span className="text-[12px] text-white/45">{plan.tagline}</span>
              </div>
              <div className="mt-0.5 text-[12px] text-white/55">
                <span className="text-white/75 font-medium">{formatMoney(monthlyEquivalent(plan, annual ? BILLING_CYCLE.annual : BILLING_CYCLE.monthly))}/mo</span>
                {' · '}{plan.highlights.join(' · ')}
              </div>
            </div>
            <button onClick={() => onChoose(plan)}
              className="shrink-0 h-9 px-4 rounded-xl border border-white/[0.12] bg-white/[0.04] text-xs font-semibold text-white/85 hover:bg-white/[0.08] transition-colors inline-flex items-center justify-center gap-1.5">
              {plan.cta}<ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}

        {/* Early-access honesty note */}
        <p className="mt-6 text-center text-[12px] text-white/40 max-w-2xl mx-auto">
          {PRICING_COPY.earlyAccessNote}
        </p>

        {/* Comparison table */}
        <section className="py-16">
          <h2 className="text-2xl lg:text-3xl font-semibold font-display tracking-tight text-center mb-8">Compare plans</h2>
          <div className="overflow-x-auto rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.025] to-transparent">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left font-medium text-white/50 px-5 py-4 w-[40%]">Features</th>
                  {plans.map(p => (
                    <th key={p.id} className="px-4 py-4 text-center">
                      <div className={cx('font-semibold font-display', p.popular ? 'text-violet-200' : 'text-white/90')}>{p.name}</div>
                      <div className="text-[11px] font-normal text-white/40 mt-0.5">
                        {p.paid ? `${formatMoney(monthlyEquivalent(p, annual ? BILLING_CYCLE.annual : BILLING_CYCLE.monthly))}/mo` : 'Free'}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FEATURE_TABLE.map((row, i) => (
                  <tr key={row.label} className={cx('border-b border-white/5 last:border-b-0', i % 2 === 1 && 'bg-white/[0.012]')}>
                    <td className="px-5 py-3 text-white/70">{row.label}</td>
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
        <section className="pb-16">
          <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-violet-500/15 via-fuchsia-500/10 to-transparent p-8 lg:p-12 text-center">
            <h2 className="text-2xl lg:text-3xl font-semibold font-display tracking-tight">Get your team in one place</h2>
            <p className="mt-2 text-white/55">Start free in seconds. Bring in your people, inside or outside your company.</p>
            <div className="mt-6 flex justify-center gap-3">
              {session ? (
                <Link to="/" className="h-12 px-6 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 transition-all">
                  Back to Command Center <ArrowRight className="w-4 h-4" />
                </Link>
              ) : (
                <>
                  <Link to="/signup" className="h-12 px-6 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 transition-all">
                    Get started free <ArrowRight className="w-4 h-4" />
                  </Link>
                  <Link to="/login" className="h-12 px-6 rounded-xl border border-white/10 bg-white/[0.03] text-white/80 font-medium text-sm flex items-center hover:bg-white/[0.06] transition-colors">
                    Log in
                  </Link>
                </>
              )}
            </div>
          </div>
        </section>
      </div>

      <SiteFooter />
    </div>
  );
}

/* ── Local helpers + subcomponents ─────────────────────────────────────────── */
const cx = (...xs) => xs.filter(Boolean).join(' ');
const cycleBtn = (active) =>
  cx('inline-flex items-center h-9 px-4 rounded-full text-xs font-semibold transition-colors',
    active ? 'bg-white text-[#0a0b11]' : 'text-white/60 hover:text-white');

function cellFor(row, plan) {
  if (row.type === 'always') return <Check className="w-4 h-4 text-emerald-400 mx-auto" />;
  if (row.type === 'limit') return <span className="text-white/80 font-medium tabular-nums">{formatLimit(plan.limits[row.key])}</span>;
  if (row.type === 'history') return <span className="text-white/80 font-medium">{formatHistory(plan.limits[row.key])}</span>;
  // feature
  return plan.features?.[row.key]
    ? <Check className="w-4 h-4 text-emerald-400 mx-auto" />
    : <Minus className="w-4 h-4 text-white/20 mx-auto" />;
}

function PlanCard({ plan, annual, onChoose }) {
  const cycle = annual ? BILLING_CYCLE.annual : BILLING_CYCLE.monthly;
  const perMonth = monthlyEquivalent(plan, cycle);
  const savings = annualSavings(plan);
  return (
    <div className={cx(
      'relative rounded-2xl border p-5 flex flex-col',
      plan.popular && 'mt-3 md:mt-0',
      plan.popular
        ? 'border-violet-400/40 bg-gradient-to-b from-violet-500/[0.10] to-white/[0.01] shadow-2xl shadow-violet-500/10'
        : 'border-white/[0.08] bg-gradient-to-br from-white/[0.03] to-transparent',
    )}>
      {plan.popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 h-6 rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-[10px] font-bold uppercase tracking-widest flex items-center shadow-lg shadow-fuchsia-500/30">
          Most popular
        </div>
      )}

      <div className="mb-1 text-lg font-semibold font-display tracking-tight">{plan.name}</div>
      <p className="text-[12px] text-white/45 leading-relaxed min-h-[2rem]">{plan.tagline}</p>

      <div className="mt-3 mb-1 flex items-end gap-1.5">
        <span className="text-3xl lg:text-4xl font-semibold font-display tabular-nums">{formatMoney(plan.paid ? perMonth : 0)}</span>
        <span className="text-sm text-white/45 mb-1.5">{plan.paid ? '/mo' : 'forever'}</span>
      </div>
      <div className="text-[11px] text-white/40 h-4">
        {plan.paid
          ? (annual ? `${formatMoney(priceFor(plan, BILLING_CYCLE.annual))} billed yearly${savings > 0 ? ` · save ${formatMoney(savings)}` : ''}` : 'Billed monthly')
          : 'No card required'}
      </div>

      <button onClick={onChoose}
        className={cx('mt-4 h-10 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all',
          plan.popular
            ? 'bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:shadow-lg hover:shadow-fuchsia-500/30'
            : plan.paid
              ? 'bg-white text-[#0a0b11] hover:bg-white/90'
              : 'border border-white/15 bg-white/[0.04] text-white/90 hover:bg-white/[0.08]')}>
        {plan.cta} <ArrowRight className="w-4 h-4" />
      </button>

      <ul className="mt-4 space-y-2">
        {plan.inherits && <li className="text-[12px] font-medium text-white/55">Everything in {plan.inherits}, plus:</li>}
        {plan.highlights.map(h => (
          <li key={h} className="flex items-start gap-2 text-[13px] text-white/70">
            <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>{h}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
