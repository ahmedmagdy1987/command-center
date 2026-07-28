import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Magnetic } from './SiteChrome';
import { CorlyvoMark } from './brand/Logo';

/**
 * Shared shell + primitives for the pre-app auth screens (/login, /forgot-password,
 * /reset-password, /invite/:token). Brings them up to the marketing pages' visual level:
 * the same dark cinematic base (drifting radial-gradient aurora — no blur() filters — plus
 * static SVG grain), the brand lockup, the card frame, and a quick staged entrance
 * (~700ms: lockup → card → fields → CTA → footnote, via .au-in + per-element delays).
 *
 * Presentation only — screens own their forms, state, and logic. All motion is
 * transform/opacity with fill:both (static styles = final state), so the single .au-root
 * override renders the complete screen under prefers-reduced-motion. Entrance animations
 * live on WRAPPER elements only, never on buttons themselves, so fill:both can never pin
 * a transform against active:scale press feedback or the Magnetic lean.
 */

/* Grain: tiny inline SVG turbulence tile, painted once and repeated. Static — never animated. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

export default function AuthShell({
  // No icon supplied => this is a brand surface (sign-in, reset) and gets the real
  // mark. InviteScreen / OnboardingScreen pass a CONTEXTUAL icon and keep the tile.
  icon: Icon = null,
  heading = 'Corlyvo',
  tagline = 'Visual task management',
  footnote = 'Your private tasks stay yours. Workspace tasks sync with your team.',
  beforeCard = null,
  footer = null,
  children,
}) {
  return (
    <div data-surface="dark" className="au-root min-h-screen bg-canvas text-primary flex items-center justify-center p-6 relative overflow-hidden">
      <style>{`

        /* Entrance (fill: both; static styles = final state) */
        @keyframes auFadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .au-in { animation: auFadeUp .55s cubic-bezier(.22,1,.36,1) both; }
        /* Banners popping in on state changes */
        @keyframes auPop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .au-pop { animation: auPop .3s ease both; }

        /* Ambient drift (radial gradients — the gradient IS the softness, no blur() filters) */
        @keyframes auDrift1 { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(44px,30px,0) scale(1.12); } }
        @keyframes auDrift2 { from { transform: translate3d(0,0,0) scale(1.06); } to { transform: translate3d(-52px,22px,0) scale(.94); } }

        /* Reduced motion: kill ALL decoration; static styles are the complete screen */
        @media (prefers-reduced-motion: reduce) {
          .au-root *, .au-root { animation: none !important; transition: none !important; }
        }
      `}</style>

      {/* Ambient depth, clipped so the screen never scrolls sideways */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="absolute top-1/4 -left-40 w-[28rem] h-[28rem] rounded-full" style={{ background: 'radial-gradient(closest-side, rgba(91,103,241,.14), transparent 72%)', animation: 'auDrift1 22s ease-in-out infinite alternate' }} />
        <div className="absolute bottom-1/4 -right-40 w-[28rem] h-[28rem] rounded-full" style={{ background: 'radial-gradient(closest-side, rgba(61,214,179,.09), transparent 72%)', animation: 'auDrift2 28s ease-in-out infinite alternate' }} />
        <div className="absolute inset-0 opacity-[0.022]" style={{ backgroundImage: GRAIN }} />
      </div>

      <div className="relative w-full max-w-md">
        {/* Brand lockup */}
        <div className="au-in flex flex-col items-center mb-8">
          {Icon ? (
            <div className="w-14 h-14 rounded-2xl bg-brand-gradient flex items-center justify-center shadow-2xl shadow-brand/15 mb-4">
              <Icon className="w-7 h-7 text-brand-fg" />
            </div>
          ) : (
            <CorlyvoMark size={56} className="mb-4" title="Corlyvo" />
          )}
          <h1 className="text-2xl font-semibold text-primary font-brand tracking-tight">{heading}</h1>
          {tagline && <p className="text-sm text-faint mt-1 text-center">{tagline}</p>}
        </div>

        {beforeCard && (
          <div className="au-in" style={{ animationDelay: '.08s' }}>
            {beforeCard}
          </div>
        )}

        {/* Card. Solid surface on purpose: backdrop-blur over the continuously-drifting aurora
            would force an uncacheable per-frame blur pass. */}
        <div className="au-in rounded-2xl border border-line bg-surface-raised p-6 shadow-2xl" style={{ animationDelay: '.08s' }}>
          {children}
        </div>

        {footnote && (
          <p className="au-in mt-6 text-center text-meta text-faint" style={{ animationDelay: '.36s' }}>
            {footnote}
          </p>
        )}
        {footer && (
          <div className="au-in mt-6" style={{ animationDelay: '.36s' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Icon-prefixed input with the shared focus treatment (ring + border, state-toggle only). */
export function AuthField({ icon: Icon, ...props }) {
  return (
    <div className="relative">
      <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none" />
      <input
        {...props}
        className="w-full bg-input border border-line rounded-xl pl-10 pr-3 h-11 text-sm text-primary placeholder-faint outline-none focus:border-brand-hover/60 focus:bg-input-focus focus:ring-2 focus:ring-brand/20 transition-colors"
      />
    </div>
  );
}

/** Error / success banner. role=alert so screen readers announce state changes. */
export function AuthBanner({ tone = 'error', children }) {
  const ok = tone === 'ok';
  const Icon = ok ? CheckCircle2 : AlertCircle;
  return (
    <div
      role="alert"
      className={`au-pop flex items-start gap-2 px-3 py-2.5 rounded-lg border text-xs text-left ${ok ? 'bg-success/10 border-success/20 text-success-text' : 'bg-danger/10 border-danger/20 text-danger-text'}`}
    >
      <Icon className="w-4 h-4 shrink-0 mt-px" />
      <span>{children}</span>
    </div>
  );
}

/** The primary auth CTA: full-width gradient button with the marketing button recipe
 *  (magnetic lean, press feedback, focus ring) and a spinner + label while busy. */
export function AuthCTA({ children, busy = false, busyLabel = 'Working…', disabled = false, type = 'submit', onClick }) {
  return (
    <Magnetic className="w-full">
      <button
        type={type}
        onClick={onClick}
        disabled={disabled}
        className="w-full h-11 rounded-xl bg-brand hover:bg-brand-hover text-brand-fg font-semibold text-sm flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-brand/20 hover:brightness-110 active:scale-[.97] disabled:opacity-50 disabled:cursor-not-allowed transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text"
      >
        {busy ? (<><Loader2 className="w-4 h-4 animate-spin" /> {busyLabel}</>) : children}
      </button>
    </Magnetic>
  );
}
