import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  KanbanSquare, Grid3x3, CalendarDays, UserCog, Zap, UserPlus, ArrowRight, Check, MousePointer2,
} from 'lucide-react';
import { SiteHeader, SiteFooter, Magnetic, Hairline } from './SiteChrome';
import { pointerMotionOK, useRevealOnScroll } from './lib/motion';

/**
 * Public marketing landing page (logged-out `/`). Honest to what the product actually does: a
 * visual team task command center, with no invented stats, logos, or testimonials. Copy is
 * placeholder positioning meant to be refined. Matches the app's visual language (dark, the
 * violet/fuchsia/rose gradient, Outfit + Fraunces).
 *
 * Motion system (all decorative, all GPU-composited — transform/opacity only, no layout writes):
 *  - Hero entrance: a single ~1.3s choreography (badge → headline line-reveals → subhead → CTAs →
 *    trust row, mockup perspective-settles in parallel). Keyframes use `both` fill so every
 *    element's STATIC style is its final visible state — under prefers-reduced-motion the whole
 *    page renders complete with `animation: none`.
 *  - Living mockup: one shared 12s loop across seven synced keyframe timelines (drag travel, card
 *    visual, lift glow, cursor, drop hint, landed card, toast). The "drag" is sleight of hand: the
 *    static top card fades out while an overlay clone travels `translate(calc(100% + 12px))` (one
 *    column + the fixed gap-3) and fades away over a pre-rendered landed card. No layout ever moves.
 *  - Ambient: radial-gradient aurora blobs (no blur() filters — the gradient IS the softness) on
 *    slow drift loops, a static masked grid, static SVG-noise grain, and an rAF mouse parallax
 *    (desktop fine-pointer only) that transforms the blobs' WRAPPERS so it can't fight the drift
 *    animation on the blob itself.
 */
const FEATURES = [
  { icon: KanbanSquare, title: 'Kanban board', body: 'Drag tasks across stages and see your whole pipeline at a glance.' },
  { icon: Grid3x3, title: 'Priority matrix', body: 'Sort by urgent vs. important so the right work rises to the top.' },
  { icon: CalendarDays, title: 'Schedule', body: 'Plan tasks on a timeline and keep due dates in view.' },
  { icon: UserCog, title: 'Assign to your team', body: 'Give every task an assignee so everyone sees who owns what.' },
  { icon: Zap, title: 'Real-time sync', body: 'Edits, comments, and new tasks appear instantly for the whole workspace.' },
  { icon: UserPlus, title: 'Workspaces & invites', body: 'Spin up a workspace and invite teammates by email to join.' },
];

const STEPS = [
  { n: '1', title: 'Create your workspace', body: 'Sign up and name your workspace. You’re its owner.' },
  { n: '2', title: 'Add work and assign it', body: 'Capture tasks, set priority and due dates, assign teammates.' },
  { n: '3', title: 'Track it your way', body: 'Kanban, priority matrix, or schedule, all live and in sync.' },
];

/* Grain: tiny inline SVG turbulence tile, painted once and repeated. Static — never animated. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

/** Cursor-following glow for feature cards: positions a radial-gradient blob via CSS vars that a
 *  transform consumes (translate-only — the gradient itself is never repainted). */
function glowTrack(e) {
  if (!pointerMotionOK()) return;
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--gx', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--gy', `${e.clientY - r.top}px`);
}

const Divider = () => <Hairline className="absolute top-0 inset-x-0" />;

/** Skeleton task card for the decorative board. Fixed height so the drag overlay, the card it
 *  replaces, and the slot it lands on all align without any layout math. */
function GhostCard({ w1, w2, color, dot, avatar, progress, solid, className = '', style }) {
  return (
    <div
      className={`h-[52px] rounded-lg border p-2.5 ${solid ? 'border-brand-hover/25 bg-surface-raised' : 'border-line-subtle bg-fill-subtle'} ${className}`}
      style={style}
    >
      <div className="h-1.5 rounded-full mb-2" style={{ width: w1, background: color, opacity: 0.55 }} />
      {progress ? (
        <div className="h-1 rounded-full bg-fill-strong overflow-hidden relative">
          <span className="absolute inset-y-0 left-0 w-[55%] rounded-full bg-brand-hover/50 overflow-hidden">
            <span className="lp-sheen absolute inset-y-0 w-2/5 bg-gradient-to-r from-transparent via-fill-strong to-transparent" style={{ opacity: 0 }} />
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {avatar && <span className="w-3 h-3 rounded-full shrink-0" style={{ background: avatar }} />}
          <div className="h-1 rounded-full bg-fill-strong" style={{ width: w2 }} />
          {dot && <span className="w-1.5 h-1.5 rounded-full ml-auto shrink-0" style={{ background: dot }} />}
        </div>
      )}
    </div>
  );
}

/** The living product mockup: a stylized board where a cursor drags a card Inbox → Must Do on a
 *  gentle 12s loop, presence dots pulse, and a completion toast slides through. Not real data,
 *  but the column names are the product's real statuses. */
function LiveBoard() {
  return (
    // Solid surface on purpose: backdrop-blur here would force an uncacheable per-frame blur
    // pass, since both this card and the aurora behind it are continuously transform-animated.
    <div className="rounded-2xl border border-line bg-surface-raised p-4 shadow-2xl relative">
      {/* Window chrome + presence cluster */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-danger-hover/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-warning-hover/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-success-hover/70" />
        </div>
        <div className="flex items-center -space-x-1.5">
          {[
            ['linear-gradient(135deg,#5b67f1,#747bff)', 'lp-ping'],
            ['linear-gradient(135deg,#3dd6b3,#5b67f1)', 'lp-ping lp-ping-2'],
            ['linear-gradient(135deg,#f59e0b,#f43f5e)', null],
          ].map(([bg, ping], i) => (
            <span key={i} className="relative w-5 h-5 rounded-full border-2 border-surface-raised" style={{ background: bg }}>
              {ping && <span className={`${ping} absolute -bottom-px -right-px w-2 h-2 rounded-full bg-success-hover`} style={{ opacity: 0 }} />}
              {ping && <span className="absolute -bottom-px -right-px w-2 h-2 rounded-full bg-success-hover border border-surface-raised" />}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {/* To do */}
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-micro uppercase tracking-widest text-faint">
            <span className="w-1.5 h-1.5 rounded-full bg-[#7c8cff]" />Inbox
          </div>
          <div className="relative space-y-2">
            {/* Card A — the one that gets "picked up" (its opacity hands off to the overlay) */}
            <GhostCard w1="72%" w2="44%" color="#7c8cff" avatar="linear-gradient(135deg,#5b67f1,#747bff)" dot="#fbbf24" className="lp-cardA" />
            <GhostCard w1="58%" w2="36%" color="#7c8cff" dot="#f43f5e" />
            <GhostCard w1="66%" w2="52%" color="#7c8cff" avatar="linear-gradient(135deg,#3dd6b3,#5b67f1)" />

            {/* Drag overlay: travels exactly one column + gap right. Invisible at rest. */}
            <div className="lp-drag absolute inset-x-0 top-0 z-10 !mt-0">
              <div className="relative">
                <div className="lp-dragGlow absolute -inset-1 rounded-xl bg-brand/25" style={{ opacity: 0 }} />
                <GhostCard w1="72%" w2="44%" color="#7c8cff" avatar="linear-gradient(135deg,#5b67f1,#747bff)" dot="#fbbf24" solid className="lp-dragCard relative shadow-xl shadow-lg" style={{ opacity: 0 }} />
                <MousePointer2 className="lp-cursor absolute left-[58%] top-[46%] w-4 h-4 text-primary drop-shadow-md" fill="white" style={{ opacity: 0 }} />
              </div>
            </div>
          </div>
        </div>

        {/* Doing */}
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-micro uppercase tracking-widest text-faint">
            <span className="w-1.5 h-1.5 rounded-full bg-[#38bdf8]" />Must Do
          </div>
          <div className="relative space-y-2">
            {/* Landing slot: dashed hint during the drag; the landed card fades in beneath the overlay */}
            <div className="relative">
              <div className="lp-dropHint absolute inset-0 rounded-lg border border-dashed border-brand-hover/40" style={{ opacity: 0 }} />
              <GhostCard w1="72%" w2="44%" color="#38bdf8" avatar="linear-gradient(135deg,#5b67f1,#747bff)" dot="#fbbf24" className="lp-cardB" />
            </div>
            <GhostCard w1="62%" color="#38bdf8" progress />
          </div>
        </div>

        {/* Done */}
        <div>
          <div className="flex items-center gap-1.5 mb-2 text-micro uppercase tracking-widest text-faint">
            <span className="w-1.5 h-1.5 rounded-full bg-[#34d399]" />Done
          </div>
          <div className="space-y-2">
            <GhostCard w1="54%" w2="40%" color="#34d399" avatar="linear-gradient(135deg,#f59e0b,#f43f5e)" />
            <GhostCard w1="68%" w2="30%" color="#34d399" />
          </div>
        </div>
      </div>

      {/* Completion toast, sliding through mid-loop */}
      <div className="lp-toast absolute bottom-3 right-3 flex items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 py-2 shadow-xl shadow-lg" style={{ opacity: 0 }}>
        <span className="w-5 h-5 rounded-full bg-success/20 border border-success-hover/40 flex items-center justify-center">
          <Check className="w-3 h-3 text-success-text" strokeWidth={3} />
        </span>
        <span className="space-y-1">
          <span className="block h-1.5 w-20 rounded-full bg-fill-strong" />
          <span className="block h-1 w-12 rounded-full bg-fill-strong" />
        </span>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const rootRef = useRef(null);

  /* Mouse parallax over the ambient layers — desktop fine-pointer + motion-OK only. Writes
     transforms straight to the [data-lp-depth] WRAPPERS via rAF (no React state, no re-render);
     the drifting blob is a child, so the CSS drift animation and the parallax never fight. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const layers = Array.from(root.querySelectorAll('[data-lp-depth]'));
    if (!layers.length) return;
    let raf = 0, mx = 0, my = 0;
    const apply = () => {
      raf = 0;
      for (const el of layers) {
        const d = Number(el.dataset.lpDepth) || 0;
        el.style.transform = `translate3d(${(mx * d).toFixed(1)}px, ${(my * d).toFixed(1)}px, 0)`;
      }
    };
    const onMove = (e) => {
      if (!pointerMotionOK()) return; // re-check per event so a mid-session reduce toggle freezes it
      mx = (e.clientX / window.innerWidth - 0.5) * 2;
      my = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* Scroll storytelling: shared reveal observer (see SiteChrome.useRevealOnScroll). */
  useRevealOnScroll(rootRef);

  return (
    <div ref={rootRef} data-surface="dark" className="lp-root min-h-screen bg-canvas text-primary relative">
      <style>{`

        /* ---------- Hero entrance choreography (fill: both; static styles = final state) ---------- */
        @keyframes lpFadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes lpRise { from { transform: translateY(112%); } to { transform: translateY(0); } }
        @keyframes lpSettle {
          from { opacity: 0; transform: perspective(1200px) rotateX(9deg) rotateY(-6deg) scale(.93) translateY(26px); }
          to   { opacity: 1; transform: perspective(1200px) rotateX(0deg) rotateY(0deg) scale(1) translateY(0); }
        }
        .lp-in { animation: lpFadeUp .7s cubic-bezier(.22,1,.36,1) both; }
        /* Clip-reveal lines: outer clips, inner rises. Padding absorbs Fraunces descenders. */
        .lp-line { display: block; overflow: hidden; padding-bottom: .12em; margin-bottom: -.12em; }
        .lp-line-inner { display: block; animation: lpRise .85s cubic-bezier(.22,1,.36,1) both; }

        /* ---------- Ambient drift (wrappers get JS parallax; blobs get these) ---------- */
        @keyframes lpDrift1 { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(56px,36px,0) scale(1.14); } }
        @keyframes lpDrift2 { from { transform: translate3d(0,0,0) scale(1.08); } to { transform: translate3d(-64px,28px,0) scale(.94); } }
        @keyframes lpDrift3 { from { transform: translate3d(0,0,0) scale(1); } to { transform: translate3d(38px,-30px,0) scale(1.1); } }

        /* ---------- The living board: seven timelines sharing one 12s clock ---------- */
        @keyframes lpFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
        @keyframes lpDragMove {
          0%, 27% { transform: translate(0,0); }
          33%     { transform: translate(calc(52% + 6px), -7px); }
          39%, 95% { transform: translate(calc(100% + 12px), 0); }
          100%    { transform: translate(0,0); }
        }
        @keyframes lpDragCard {
          0%, 22% { opacity: 0; transform: scale(1) rotate(0deg); }
          25%     { opacity: 1; transform: scale(1) rotate(0deg); }
          28%, 38% { opacity: 1; transform: scale(1.05) rotate(-1.5deg); }
          41%, 88% { opacity: 1; transform: scale(1) rotate(0deg); }
          93%, 100% { opacity: 0; transform: scale(1) rotate(0deg); }
        }
        @keyframes lpDragGlow { 0%,24% { opacity: 0; } 28%,38% { opacity: 1; } 42%,100% { opacity: 0; } }
        @keyframes lpCardA { 0%,23% { opacity: 1; } 26%,90% { opacity: 0; } 96%,100% { opacity: 1; } }
        @keyframes lpCardB { 0%,41% { opacity: 0; } 45%,94% { opacity: 1; } 98%,100% { opacity: 0; } }
        @keyframes lpDropHint { 0%,26% { opacity: 0; } 30%,37% { opacity: .9; } 41%,100% { opacity: 0; } }
        @keyframes lpCursor {
          0%, 8%  { opacity: 0; transform: translate(72px,84px) scale(1); }
          14%     { opacity: 1; }
          22%, 26% { opacity: 1; transform: translate(0,0) scale(1); }
          28%, 40% { opacity: 1; transform: translate(0,0) scale(.9); }
          44%     { opacity: 1; transform: translate(0,0) scale(1); }
          54%, 100% { opacity: 0; transform: translate(40px,56px) scale(1); }
        }
        @keyframes lpToast {
          0%, 56% { opacity: 0; transform: translateY(12px) scale(.97); }
          61%, 78% { opacity: 1; transform: translateY(0) scale(1); }
          84%, 100% { opacity: 0; transform: translateY(-6px) scale(.98); }
        }
        @keyframes lpPing { 0% { opacity: .7; transform: scale(1); } 70%, 100% { opacity: 0; transform: scale(2.2); } }
        @keyframes lpSheenMove { 0% { transform: translateX(-110%); opacity: 0; } 8% { opacity: 1; } 50% { opacity: 1; } 60%, 100% { transform: translateX(260%); opacity: 0; } }

        .lp-float    { animation: lpFloat 7s ease-in-out infinite; }
        .lp-drag     { animation: lpDragMove 12s cubic-bezier(.45,.05,.35,1) infinite; }
        .lp-dragCard { animation: lpDragCard 12s ease infinite; }
        .lp-dragGlow { animation: lpDragGlow 12s ease infinite; }
        .lp-cardA    { animation: lpCardA 12s ease infinite; }
        .lp-cardB    { animation: lpCardB 12s ease infinite; }
        .lp-dropHint { animation: lpDropHint 12s ease infinite; }
        .lp-cursor   { animation: lpCursor 12s cubic-bezier(.45,.05,.35,1) infinite; }
        .lp-toast    { animation: lpToast 12s ease infinite; }
        .lp-ping     { animation: lpPing 3.2s cubic-bezier(0,0,.2,1) infinite; }
        .lp-ping-2   { animation-delay: 1.6s; }
        .lp-sheen    { animation: lpSheenMove 3.6s ease-in-out infinite; }

        /* ---------- Scroll reveals (hidden state exists ONLY when motion is allowed) ---------- */
        @media (prefers-reduced-motion: no-preference) {
          [data-lp-reveal] {
            opacity: 0;
            transform: translateY(22px);
            transition: opacity .65s ease var(--lp-d,0s), transform .65s cubic-bezier(.22,1,.36,1) var(--lp-d,0s);
          }
          [data-lp-reveal].lp-seen { opacity: 1; transform: translateY(0); }
        }

        /* ---------- Micro-interactions ---------- */
        .lp-cardGlow {
          position: absolute; top: 0; left: 0; width: 15rem; height: 15rem; border-radius: 9999px;
          background: radial-gradient(closest-side, rgba(91,103,241,.14), transparent 70%);
          transform: translate(calc(var(--gx, -999px) - 7.5rem), calc(var(--gy, -999px) - 7.5rem));
          pointer-events: none;
        }
        @keyframes lpComet { 0% { transform: translateX(-240px); opacity: 0; } 10% { opacity: 1; } 55%, 100% { transform: translateX(110vw); opacity: 0; } }
        .lp-comet { animation: lpComet 5.5s cubic-bezier(.4,0,.4,1) infinite; }

        /* ---------- Reduced motion: kill ALL decoration; static styles are the complete page ---------- */
        @media (prefers-reduced-motion: reduce) {
          .lp-root *, .lp-root { animation: none !important; transition: none !important; }
        }
      `}</style>

      {/* Ambient depth: aurora blobs (parallax wrappers → drifting radial gradients), masked grid,
          static grain. All clipped so the page never scrolls sideways. */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div data-lp-depth="18" className="absolute -top-40 left-[6%] w-[36rem] h-[36rem]">
          <div className="w-full h-full rounded-full" style={{ background: 'radial-gradient(closest-side, rgba(91,103,241,.17), transparent 72%)', animation: 'lpDrift1 26s ease-in-out infinite alternate' }} />
        </div>
        <div data-lp-depth="-14" className="absolute top-[4rem] -right-48 w-[34rem] h-[34rem]">
          <div className="w-full h-full rounded-full" style={{ background: 'radial-gradient(closest-side, rgba(61,214,179,.10), transparent 72%)', animation: 'lpDrift2 32s ease-in-out infinite alternate' }} />
        </div>
        <div data-lp-depth="10" className="absolute top-[22rem] left-[38%] w-[30rem] h-[30rem]">
          <div className="w-full h-full rounded-full" style={{ background: 'radial-gradient(closest-side, rgba(99,102,241,.12), transparent 72%)', animation: 'lpDrift3 40s ease-in-out infinite alternate' }} />
        </div>
        <div
          className="absolute inset-x-0 top-0 h-[44rem]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px)',
            backgroundSize: '54px 54px',
            maskImage: 'radial-gradient(ellipse 85% 65% at 50% 0%, black 25%, transparent 72%)',
            WebkitMaskImage: 'radial-gradient(ellipse 85% 65% at 50% 0%, black 25%, transparent 72%)',
          }}
        />
        <div className="absolute inset-0 opacity-[0.022]" style={{ backgroundImage: GRAIN }} />
      </div>

      <SiteHeader />

      <main className="relative max-w-6xl mx-auto px-5 lg:px-8">
        {/* Hero (compact: fits above the fold on a typical laptop) */}
        <section className="pt-8 lg:pt-12 pb-10 grid lg:grid-cols-2 gap-8 lg:gap-10 items-center">
          <div>
            <div className="lp-in inline-flex items-center gap-1.5 text-meta font-medium uppercase tracking-widest text-brand-text/80 bg-brand/10 border border-brand-hover/20 rounded-full px-3 h-7 mb-4" style={{ animationDelay: '.05s' }}>
              Visual task management for teams
            </div>
            <h1 className="text-3xl lg:text-4xl xl:text-5xl font-semibold font-display tracking-tight leading-[1.05]">
              <span className="lp-line"><span className="lp-line-inner" style={{ animationDelay: '.12s' }}>Stop losing track of</span></span>
              <span className="lp-line"><span className="lp-line-inner bg-gradient-to-r from-brand-text via-brand-alt-text to-danger-text bg-clip-text text-transparent" style={{ animationDelay: '.24s' }}>who’s doing what.</span></span>
            </h1>
            <p className="lp-in mt-4 text-sm lg:text-base text-muted max-w-xl leading-relaxed" style={{ animationDelay: '.4s' }}>
              Pull every task, owner, and due date into one visual workspace. Track it on a kanban board,
              a priority matrix, or a schedule, live for the whole team.
            </p>
            <div className="lp-in mt-6 flex flex-wrap items-center gap-3" style={{ animationDelay: '.52s' }}>
              <Magnetic>
                <Link to="/signup" className="h-11 px-6 rounded-xl bg-brand-gradient-cta text-brand-fg font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-brand/20 hover:brightness-110 active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                  Get organized free <ArrowRight className="w-4 h-4" />
                </Link>
              </Magnetic>
              <Link to="/login" className="h-11 px-6 rounded-xl border border-line bg-fill-subtle text-secondary font-medium text-sm flex items-center hover:bg-fill active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                Log in
              </Link>
            </div>
            <div className="lp-in mt-5 flex flex-wrap gap-x-5 gap-y-1.5 text-note text-faint" style={{ animationDelay: '.66s' }}>
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-success-text" /> Real-time sync</span>
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-success-text" /> Private &amp; shared tasks</span>
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-success-text" /> Team chat &amp; direct messages</span>
            </div>
          </div>

          {/* Decorative living board (not real data; a visual hint of the UI). Shown on mobile too —
              it sits below the hero copy there and the loop is identical, minus parallax. */}
          <div aria-hidden="true" data-lp-depth="-6">
            <div style={{ animation: 'lpSettle 1s cubic-bezier(.22,1,.36,1) .3s both' }}>
              <div className="lp-float">
                <LiveBoard />
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="relative py-14">
          <Divider />
          <div data-lp-reveal>
            <h2 className="text-2xl lg:text-3xl font-semibold font-display tracking-tight">Everything your team needs to stay on track</h2>
            <p className="mt-2 text-faint max-w-2xl">One workspace for the work, the people, and the plan.</p>
          </div>
          <div className="mt-9 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Reveal lives on a WRAPPER div so its transition rule can never collide with the
                card's own transition-all hover treatment (same-specificity cascade tie). */}
            {FEATURES.map((f, i) => (
              <div key={f.title} data-lp-reveal style={{ '--lp-d': `${(i % 3) * 90}ms` }}>
                <div
                  onMouseMove={glowTrack}
                  className="group relative h-full overflow-hidden rounded-2xl border border-line-subtle bg-gradient-to-br from-fill-subtle to-transparent p-5 transition-all duration-300 hover:-translate-y-1 hover:border-brand-hover/25 hover:shadow-xl hover:shadow-brand/20"
                >
                  <span className="lp-cardGlow opacity-0 group-hover:opacity-100 transition-opacity duration-300" aria-hidden="true" />
                  <div className="relative w-10 h-10 rounded-xl bg-brand/10 border border-brand-hover/20 flex items-center justify-center mb-3 transition-colors duration-300 group-hover:bg-brand/20 group-hover:border-brand-hover/40">
                    <f.icon className="w-5 h-5 text-brand-text transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6" />
                  </div>
                  <h3 className="relative text-base font-semibold text-primary">{f.title}</h3>
                  <p className="relative mt-1 text-compact text-muted leading-relaxed">{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="relative py-14">
          <Divider />
          <h2 data-lp-reveal className="text-2xl lg:text-3xl font-semibold font-display tracking-tight">How it works</h2>
          <div className="mt-9 grid md:grid-cols-3 gap-4">
            {STEPS.map((s, i) => (
              <div key={s.n} data-lp-reveal style={{ '--lp-d': `${i * 110}ms` }}>
                <div className="group h-full rounded-2xl border border-line-subtle bg-fill-subtle p-5 transition-all duration-300 hover:-translate-y-1 hover:border-line">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand to-brand-alt flex items-center justify-center text-sm font-bold mb-3 shadow-lg shadow-brand/25 transition-transform duration-300 group-hover:scale-110">{s.n}</div>
                  <h3 className="text-base font-semibold text-primary">{s.title}</h3>
                  <p className="mt-1 text-compact text-muted leading-relaxed">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* CTA band */}
        <section className="relative py-14">
          <Divider />
          <div data-lp-reveal className="relative overflow-hidden rounded-2xl border border-brand-hover/20 bg-surface p-8 lg:p-12 text-center">
            {/* Inner atmosphere: brand wash + a slow-drifting glow + a comet along the top hairline */}
            <div className="absolute inset-0 bg-gradient-to-br from-brand/15 via-brand-alt/[0.07] to-transparent" aria-hidden="true" />
            <div className="absolute -top-24 left-1/2 -ml-48 w-96 h-96 rounded-full" aria-hidden="true" style={{ background: 'radial-gradient(closest-side, rgba(124,140,255,.18), transparent 70%)', animation: 'lpDrift3 18s ease-in-out infinite alternate' }} />
            <div className="absolute top-0 inset-x-0 h-px overflow-hidden" aria-hidden="true">
              <span className="lp-comet absolute top-0 h-px w-60 bg-gradient-to-r from-transparent via-brand-alt-text/80 to-transparent" style={{ opacity: 0 }} />
            </div>
            <h2 className="relative text-2xl lg:text-3xl font-semibold font-display tracking-tight">Ready to organize your team’s work?</h2>
            <p className="relative mt-2 text-muted">Create a workspace in seconds. It’s free to get started.</p>
            <div className="relative mt-6 flex justify-center gap-3">
              <Magnetic>
                <Link to="/signup" className="h-12 px-6 rounded-xl bg-brand-gradient-cta text-brand-fg font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-brand/20 hover:brightness-110 active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                  Get organized free <ArrowRight className="w-4 h-4" />
                </Link>
              </Magnetic>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
