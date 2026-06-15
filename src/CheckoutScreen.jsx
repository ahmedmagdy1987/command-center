import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Sparkles, Check, ArrowRight, Lock, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import {
  PLANS, BILLING_CYCLE, monthlyEquivalent, priceFor, annualSavings, formatMoney,
} from './lib/plans';
import { billing } from './lib/billing';

/**
 * Checkout-ready screen (/checkout?plan=pro&cycle=monthly). The path from any
 * upgrade CTA. The PAYMENT step is a clearly-labeled stub: it captures intent
 * via billing.startCheckout() (lib/billing.js) and never charges. Connecting a
 * real provider later is a contained change to that ONE function — this screen
 * doesn't change. Reachable signed-in or signed-out (signed-out users are asked
 * to sign in first, since a plan upgrades a workspace).
 */
export default function CheckoutScreen({ session }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const planId = params.get('plan') || 'pro';
  const cycleParam = params.get('cycle') === BILLING_CYCLE.annual ? BILLING_CYCLE.annual : BILLING_CYCLE.monthly;
  const [cycle, setCycle] = useState(cycleParam);
  const annual = cycle === BILLING_CYCLE.annual;

  const plan = PLANS[planId];
  // Best-effort: which workspace is being upgraded (the per-user active-workspace key AppProvider
  // persists). Strengthens the captured intent; the live billing impl can also resolve it
  // server-side from the authenticated session.
  const activeWorkspaceId = (() => {
    try { return session?.user?.id ? localStorage.getItem(`cc:currentWorkspace:${session.user.id}`) : null; }
    catch { return null; }
  })();
  const [email, setEmail] = useState(session?.user?.email || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const setCycleAndUrl = (c) => {
    setCycle(c);
    const next = new URLSearchParams(params);
    next.set('cycle', c);
    setParams(next, { replace: true });
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim()) { setError('Enter an email so we can reach you.'); return; }
    setError(null); setBusy(true);
    try {
      await billing.startCheckout({ planId, cycle, email: email.trim(), workspaceId: activeWorkspaceId || undefined });
      setDone(true);
    } catch (err) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  return (
    <Shell>
      {!plan || !plan.paid ? (
        <Card>
          <Centered title="Pick a plan first" body="That plan isn’t available to upgrade to.">
            <Link to="/pricing" className="primary-cta">See plans <ArrowRight className="w-4 h-4" /></Link>
          </Centered>
        </Card>
      ) : !session ? (
        <Card>
          <Centered title={`Sign in to upgrade to ${plan.name}`} body="A plan upgrades your workspace, so sign in (or create an account) to continue.">
            <div className="flex flex-col gap-2 w-full">
              <button onClick={() => navigate('/login')} className="primary-cta">Sign in <ArrowRight className="w-4 h-4" /></button>
              <Link to="/signup" className="text-[12px] text-white/50 hover:text-white/80 transition-colors">Create an account</Link>
            </div>
          </Centered>
        </Card>
      ) : (
        <div className="grid lg:grid-cols-[1.1fr_1fr] gap-5 items-start">
          {/* Plan summary */}
          <Card>
            <div className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-2">You’re upgrading to</div>
            <div className="flex items-center justify-between gap-3 mb-1">
              <h2 className="text-2xl font-semibold font-display tracking-tight">{plan.name}</h2>
              <Link to="/pricing" className="text-[11px] text-white/45 hover:text-white/80 transition-colors shrink-0">Change plan</Link>
            </div>
            <p className="text-[13px] text-white/50 mb-5">{plan.tagline}</p>

            <div className="inline-flex items-center p-1 rounded-full border border-white/10 bg-white/[0.03] mb-5">
              <button onClick={() => setCycleAndUrl(BILLING_CYCLE.monthly)} className={cycleBtn(!annual)}>Monthly</button>
              <button onClick={() => setCycleAndUrl(BILLING_CYCLE.annual)} className={cycleBtn(annual)}>
                Annual<span className="ml-1.5 text-[10px] font-semibold text-emerald-300">save ~2 mo</span>
              </button>
            </div>

            <div className="flex items-end gap-1.5 mb-1">
              <span className="text-4xl font-semibold font-display tabular-nums">{formatMoney(monthlyEquivalent(plan, cycle))}</span>
              <span className="text-sm text-white/45 mb-1.5">/mo</span>
            </div>
            <div className="text-[11px] text-white/40 mb-5">
              {annual
                ? `${formatMoney(priceFor(plan, BILLING_CYCLE.annual))} billed yearly${annualSavings(plan) > 0 ? ` · save ${formatMoney(annualSavings(plan))}` : ''}`
                : 'Billed monthly'}
            </div>

            <div className="border-t border-white/5 pt-4">
              {plan.inherits && <div className="text-[11px] text-white/40 mb-2">Everything in {plan.inherits}, plus:</div>}
              <ul className="space-y-2">
                {plan.highlights.map(h => (
                  <li key={h} className="flex items-start gap-2 text-[13px] text-white/70">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /><span>{h}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>

          {/* Payment seam (stub) */}
          <Card>
            {done ? (
              <Centered tone="ok" title="You’re on the list" body={`Thanks — we’ll email ${email} the moment ${plan.name} billing goes live. No charge was made.`}>
                <button onClick={() => navigate('/')} className="primary-cta">Back to Command Center <ArrowRight className="w-4 h-4" /></button>
              </Centered>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <Lock className="w-4 h-4 text-violet-300" />
                  <h3 className="text-base font-semibold text-white">Payment</h3>
                  <span className="ml-auto text-[10px] font-semibold uppercase tracking-widest text-amber-300/90 bg-amber-500/10 border border-amber-400/20 rounded-full px-2 h-5 flex items-center">Coming soon</span>
                </div>
                <p className="text-[12px] text-white/50 leading-relaxed mb-4">
                  Card payments aren’t switched on yet. Leave your email and we’ll let you know the moment {plan.name} is ready to buy — you won’t be charged now.
                </p>
                <form onSubmit={submit} className="space-y-3">
                  <div>
                    <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">Email</label>
                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com"
                      className="w-full bg-black/30 border border-white/10 rounded-xl px-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50 focus:bg-black/40 transition-colors" />
                  </div>
                  {error && (
                    <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                      <AlertCircle className="w-4 h-4 shrink-0 mt-px" /><span>{error}</span>
                    </div>
                  )}
                  <button type="submit" disabled={busy}
                    className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : (<>Notify me when billing is live <ArrowRight className="w-4 h-4" /></>)}
                  </button>
                </form>
                <p className="mt-3 text-[11px] text-white/30 text-center">
                  Founding members keep every feature free while we’re in early access.
                </p>
              </>
            )}
          </Card>
        </div>
      )}
    </Shell>
  );
}

/* ── Local layout primitives ───────────────────────────────────────────────── */
const cx = (...xs) => xs.filter(Boolean).join(' ');
const cycleBtn = (active) =>
  cx('inline-flex items-center h-8 px-3.5 rounded-full text-xs font-semibold transition-colors',
    active ? 'bg-white text-[#0a0b11]' : 'text-white/60 hover:text-white');

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-[#070810] text-white relative overflow-hidden px-5 lg:px-8 py-6">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Outfit:wght@300..700&display=swap');
        body { font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif; background: #070810; }
        .font-display { font-family: 'Fraunces', ui-serif, serif; font-optical-sizing: auto; font-weight: 500; }
        .primary-cta { height: 2.75rem; padding: 0 1.25rem; border-radius: 0.75rem; display:inline-flex; align-items:center; justify-content:center; gap:0.5rem; font-size:0.875rem; font-weight:600; color:#fff; background-image:linear-gradient(to right,#8b5cf6,#d946ef); transition:all .2s; }
        .primary-cta:hover { box-shadow: 0 10px 25px -5px rgba(217,70,239,0.3); }
        @keyframes float { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-20px); } }
      `}</style>
      <div className="absolute top-[-6rem] left-1/4 w-[26rem] h-[26rem] rounded-full bg-violet-500/10 blur-3xl pointer-events-none" style={{ animation: 'float 9s ease-in-out infinite' }} />
      <div className="absolute bottom-0 -right-32 w-[24rem] h-[24rem] rounded-full bg-fuchsia-500/10 blur-3xl pointer-events-none" style={{ animation: 'float 9s ease-in-out infinite reverse' }} />
      <div className="relative max-w-4xl mx-auto">
        <header className="flex items-center justify-between h-12 mb-6">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-lg shadow-fuchsia-500/20">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="text-[15px] font-semibold font-display tracking-tight">Command Center</span>
          </Link>
          <Link to="/pricing" className="text-[12px] text-white/50 hover:text-white/80 transition-colors">All plans</Link>
        </header>
        {children}
      </div>
    </div>
  );
}

function Card({ children }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0f1017]/80 backdrop-blur p-6 shadow-2xl">{children}</div>
  );
}

function Centered({ title, body, children, tone }) {
  return (
    <div className="text-center py-4">
      {tone === 'ok' && (
        <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center mx-auto mb-3">
          <CheckCircle2 className="w-6 h-6 text-emerald-400" />
        </div>
      )}
      <h2 className="text-lg font-semibold text-white mb-1">{title}</h2>
      <p className="text-[13px] text-white/50 max-w-sm mx-auto mb-5">{body}</p>
      <div className="flex justify-center">{children}</div>
    </div>
  );
}
