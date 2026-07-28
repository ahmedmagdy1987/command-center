import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  KanbanSquare, UserCog, Zap, UserPlus, ArrowRight, Check, MousePointer2, Lock, MessageSquare, Mic,
} from 'lucide-react';
import { SiteHeader, SiteFooter, Magnetic, Hairline } from './SiteChrome';
import { pointerMotionOK, useRevealOnScroll } from './lib/motion';
import LandingDemo from './LandingDemo';
import { PLANS, MAIN_PLAN_IDS, PRICING_COPY, monthlyEquivalent, formatMoney, BILLING_CYCLE } from './lib/plans';

/**
 * Public marketing landing page (logged-out `/`). A conversion page built around the
 * product's actual differentiator: one workspace for the whole team INCLUDING people
 * outside the company (freelancers, contractors, VAs — the product's guest role).
 *
 * Honest by rule: no invented stats, logos, testimonials, or review counts. The
 * social-proof section is deliberately ABSENT until there is real proof to show —
 * see the marked slot below the demo section.
 *
 * Structure: hero (cross-org headline + living board) → interactive demo (tabbed
 * Kanban/Matrix/Schedule/Chat preview, see LandingDemo.jsx) → features (cross-org
 * framing, each with a mini visual) → pricing teaser (driven from lib/plans.js so it
 * can never drift from the real plans) → final CTA → footer.
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
 *  - Demo panels: the `ld*` keyframes at the bottom of the style block; same rest-state rules.
 *  - Ambient: radial-gradient aurora blobs (no blur() filters — the gradient IS the softness) on
 *    slow drift loops, a static masked grid, static SVG-noise grain, and an rAF mouse parallax
 *    (desktop fine-pointer only) that transforms the blobs' WRAPPERS so it can't fight the drift
 *    animation on the blob itself.
 */

/* Feature cards: the cross-org story carried by the copy AND a mini visual per card. */
const FEATURES = [
  {
    icon: UserPlus,
    title: 'Bring in people outside your company',
    body: 'Invite freelancers, contractors, and VAs as guests. They work their tasks alongside your team — and see only what’s theirs.',
    viz: 'guests',
  },
  {
    icon: UserCog,
    title: 'Assign anyone, inside or out',
    body: 'Every task has one clear owner — an employee or an outside collaborator. No more “who was doing this?”',
    viz: 'assign',
  },
  {
    icon: Lock,
    title: 'Private & shared tasks',
    body: 'Keep a task between you and its assignee, or share it with the workspace. Privacy is per-task, not per-tool.',
    viz: 'private',
  },
  {
    icon: KanbanSquare,
    title: 'Kanban, matrix & schedule',
    body: 'The same tasks, three ways to steer them: pipeline board, urgent-vs-important matrix, weekly schedule.',
    viz: 'views',
  },
  {
    icon: MessageSquare,
    title: 'Chat where the work is',
    body: 'Team chat, direct messages, and voice notes in the same workspace as the tasks — no separate chat app.',
    viz: 'chat',
  },
  {
    icon: Zap,
    title: 'Live for everyone',
    body: 'Edits, comments, and new tasks sync in real time, with due-date reminders before things slip.',
    viz: 'sync',
  },
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

/* ── Mini visuals for the feature cards. Pure CSS/SVG-free, ~40px tall, decorative. ── */
function FeatureViz({ kind }) {
  const bar = (w, extra = '') => <span className={`block h-1.5 rounded-full bg-fill-strong ${extra}`} style={{ width: w }} />;
  const face = (hex, soft, letter, dashed = false) => (
    <span
      className={`w-6 h-6 rounded-full inline-flex items-center justify-center text-[10px] font-bold shrink-0 ${dashed ? 'border border-dashed' : 'border border-line-subtle'}`}
      style={{ background: soft, color: hex, borderColor: dashed ? hex : undefined }}
    >
      {letter}
    </span>
  );
  switch (kind) {
    case 'guests':
      return (
        <div className="flex items-center gap-1.5">
          <span className="flex -space-x-1.5">
            {face('#7c8cff', 'rgba(124,140,255,.14)', 'M')}
            {face('#34d399', 'rgba(52,211,153,.14)', 'J')}
            {face('#fb923c', 'rgba(251,146,60,.14)', 'S')}
          </span>
          <span className="text-faint text-micro">+</span>
          {face('#f472b6', 'rgba(244,114,182,.14)', 'P', true)}
          <span className="rounded-full border border-brand-alt/40 bg-brand-alt/10 text-brand-alt-text px-1.5 h-4 inline-flex items-center text-[9px] font-semibold uppercase tracking-wide">guest</span>
        </div>
      );
    case 'assign':
      return (
        <div className="flex items-center gap-2">
          {bar('34%')}
          <span className="lp-vizSlide inline-flex items-center gap-1 rounded-full bg-brand/15 border border-brand-hover/30 pl-0.5 pr-2 h-5">
            {face('#f472b6', 'rgba(244,114,182,.14)', 'P', true)}
            <span className="text-micro text-brand-text font-medium">assigned</span>
          </span>
        </div>
      );
    case 'private':
      return (
        <div className="space-y-1.5 w-full max-w-[180px]">
          <span className="flex items-center gap-1.5">{bar('62%')}<span className="text-[9px] text-faint uppercase">shared</span></span>
          <span className="flex items-center gap-1.5">{bar('44%')}<Lock className="w-3 h-3 text-brand-text shrink-0" /><span className="text-[9px] text-faint uppercase">you + assignee</span></span>
        </div>
      );
    case 'views':
      return (
        <div className="flex items-end gap-1.5 h-8" aria-hidden="true">
          {[['#7c8cff', 'h-8'], ['#38bdf8', 'h-6'], ['#34d399', 'h-7']].map(([c, h], i) => (
            <span key={i} className={`w-7 ${h} rounded-md border border-line-subtle bg-fill-subtle relative overflow-hidden`}>
              <span className="absolute top-1 left-1 right-1 h-1 rounded-full" style={{ background: c, opacity: 0.6 }} />
              <span className="absolute top-3 left-1 right-2 h-1 rounded-full bg-fill-strong" />
            </span>
          ))}
        </div>
      );
    case 'chat':
      return (
        <div className="flex items-center gap-2">
          <span className="rounded-xl rounded-bl-sm bg-fill border border-line-subtle px-2 py-1">{bar('34px')}</span>
          <span className="rounded-xl rounded-br-sm bg-brand/15 border border-brand-hover/25 px-2 py-1 inline-flex items-center gap-1">
            <Mic className="w-3 h-3 text-brand-text" />
            <span className="flex items-center gap-[2px]">
              {[4, 8, 5, 9, 6].map((h, i) => <span key={i} className="w-[2px] rounded-full bg-brand-text/60" style={{ height: h }} />)}
            </span>
          </span>
        </div>
      );
    case 'sync':
    default:
      return (
        <div className="flex items-center gap-2">
          <span className="relative w-2.5 h-2.5">
            <span className="lp-ping absolute inset-0 rounded-full bg-success-hover" style={{ opacity: 0 }} />
            <span className="absolute inset-0 rounded-full bg-success-hover" />
          </span>
          <span className="text-micro text-faint">Synced just now, for everyone</span>
        </div>
      );
  }
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

  const free = PLANS[MAIN_PLAN_IDS[0]];
  const pro = PLANS[MAIN_PLAN_IDS[1]];

  return (
    <div ref={rootRef} data-surface="dark" className="lp-root min-h-screen bg-canvas text-primary relative">
      <style>{`

        /* ---------- Hero entrance choreography (fill: both; static styles = final state) ---------- */
        @keyframes lpFadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes lpRise { from { transform: translateY(125%); } to { transform: translateY(0); } }
        @keyframes lpSettle {
          from { opacity: 0; transform: perspective(1200px) rotateX(9deg) rotateY(-6deg) scale(.93) translateY(26px); }
          to   { opacity: 1; transform: perspective(1200px) rotateX(0deg) rotateY(0deg) scale(1) translateY(0); }
        }
        .lp-in { animation: lpFadeUp .7s cubic-bezier(.22,1,.36,1) both; }
        /* Clip-reveal lines: outer clips, inner rises.
         *
         * BOTH elements need the padding/negative-margin pair, for DIFFERENT reasons, and
         * dropping either one clips the descenders of g/y/p/j in the hero headline:
         *
         *   .lp-line       "overflow: hidden" is what creates the reveal, so its padding box
         *                  is also the CLIP box. Without extra room at the bottom it slices
         *                  through any descender.
         *   .lp-line-inner the second line is "bg-clip-text" + "text-transparent", so the
         *                  gradient is painted only across this element's BACKGROUND box.
         *                  At "leading-[1.05]" that box stops above the descender, so the
         *                  tail of the "g" got no paint at all and vanished — while the part
         *                  inside the box still rendered, which is what read as a broken
         *                  glyph with a stray stroke under it.
         *
         * "padding-bottom: X" + "margin-bottom: -X" is exactly layout-neutral: the border box
         * grows by X, the margin box does not, so line spacing is unchanged no matter the
         * value. .28em clears Manrope's descender (~.24em below the baseline) with margin.
         * These were tuned at .12em for Fraunces, which Phase 3 replaced. */
        .lp-line { display: block; overflow: hidden; padding-bottom: .28em; margin-bottom: -.28em; }
        .lp-line-inner { display: block; padding-bottom: .28em; margin-bottom: -.28em; animation: lpRise .85s cubic-bezier(.22,1,.36,1) both; }

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

        /* ---------- Interactive demo (LandingDemo.jsx) — same rest-state discipline:
                     every static style is the complete page; reduced motion kills all. ---------- */
        @keyframes ldEnter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .ld-enter { animation: ldEnter .3s ease both; }
        @keyframes ldGo {
          0%, 22% { transform: translate(0,0); }
          30%     { transform: translate(calc(50% + 6px), -6px); }
          38%, 94% { transform: translate(calc(100% + 12px), 0); }
          100%    { transform: translate(0,0); }
        }
        @keyframes ldGoCard { 0%,18% { opacity: 0; } 24%,36% { opacity: 1; } 42%,100% { opacity: 0; } }
        @keyframes ldGoA { 0%,20% { opacity: 1; } 26%,90% { opacity: 0; } 97%,100% { opacity: 1; } }
        @keyframes ldLandB { 0%,40% { opacity: 0; } 46%,95% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes ldHint { 0%,24% { opacity: 0; } 29%,36% { opacity: .9; } 41%,100% { opacity: 0; } }
        .ld-go       { animation: ldGo 11s cubic-bezier(.45,.05,.35,1) infinite; }
        .ld-go > div { animation: ldGoCard 11s ease infinite; }
        .ld-goA      { animation: ldGoA 11s ease infinite; }
        .ld-landB    { animation: ldLandB 11s ease infinite; }
        .ld-hint     { animation: ldHint 11s ease infinite; }
        @keyframes ldPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.015); } }
        .ld-pulse { animation: ldPulse 2.8s ease-in-out infinite; }
        @keyframes ldMsg { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .ld-msg { animation: ldMsg .5s ease both; animation-delay: var(--ld-d, 0s); }
        @keyframes ldDot { 0%,100% { transform: translateY(0); opacity: .5; } 40% { transform: translateY(-3px); opacity: 1; } }
        .ld-dot { animation: ldDot 1.1s ease-in-out infinite; }
        @keyframes lpVizSlide { 0%,100% { transform: translateX(0); } 50% { transform: translateX(4px); } }
        .lp-vizSlide { animation: lpVizSlide 3.4s ease-in-out infinite; }

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
              One workspace, across company lines
            </div>
            <h1 className="text-3xl lg:text-4xl xl:text-5xl font-semibold font-brand tracking-tight leading-[1.05]">
              <span className="lp-line"><span className="lp-line-inner" style={{ animationDelay: '.12s' }}>Coordinate your whole team —</span></span>
              <span className="lp-line"><span className="lp-line-inner bg-gradient-to-r from-brand-text via-brand-alt-text to-danger-text bg-clip-text text-transparent" style={{ animationDelay: '.24s' }}>even people outside your company.</span></span>
            </h1>
            <p className="lp-in mt-4 text-sm lg:text-base text-muted max-w-xl leading-relaxed" style={{ animationDelay: '.4s' }}>
              Tasks, owners, due dates, and chat in one visual workspace — for staff <em>and</em> the
              freelancers, contractors, and VAs who work with them. Everyone sees who’s doing what.
              Outside collaborators see only what’s theirs.
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
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-success-text" /> No credit card required</span>
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-success-text" /> Real-time sync</span>
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-success-text" /> Guest access for outside collaborators</span>
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

        {/* Interactive demo — the centerpiece: click through the real views with sample data. */}
        <section className="relative py-14" id="demo">
          <Divider />
          <div data-lp-reveal className="text-center max-w-2xl mx-auto">
            <h2 className="text-2xl lg:text-3xl font-semibold font-brand tracking-tight">Try it right here — no account needed</h2>
            <p className="mt-2 text-faint">
              Click through the product’s actual views. Watch for <span className="text-brand-alt-text">Priya</span>, the
              outside collaborator: she’s on the board, in the matrix, and in chat — seeing only her own work.
            </p>
          </div>
          <div data-lp-reveal className="mt-8" style={{ '--lp-d': '120ms' }}>
            <LandingDemo />
          </div>
          <div data-lp-reveal className="mt-6 text-center" style={{ '--lp-d': '200ms' }}>
            <Link to="/signup" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-text hover:text-brand-text-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text rounded">
              Like what you see? Get organized free <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </section>

        {/*  SOCIAL PROOF — deliberately absent until there is real proof to show.
             House rule: never fabricate logos, testimonials, user counts, or stats.
             When real quotes/customers exist, they slot in here as a band between
             the demo and the features grid. */}

        {/* Features */}
        <section className="relative py-14">
          <Divider />
          <div data-lp-reveal>
            <h2 className="text-2xl lg:text-3xl font-semibold font-brand tracking-tight">Built for teams that don’t fit inside one org chart</h2>
            <p className="mt-2 text-faint max-w-2xl">
              Most tools assume everyone works at the same company. Corlyvo assumes some of your best people don’t.
            </p>
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
                  <div className="relative flex items-start justify-between gap-3 mb-3">
                    <div className="w-10 h-10 rounded-xl bg-brand/10 border border-brand-hover/20 flex items-center justify-center transition-colors duration-300 group-hover:bg-brand/20 group-hover:border-brand-hover/40">
                      <f.icon className="w-5 h-5 text-brand-text transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6" />
                    </div>
                  </div>
                  <div className="relative h-10 flex items-center mb-2" aria-hidden="true">
                    <FeatureViz kind={f.viz} />
                  </div>
                  <h3 className="relative text-base font-semibold text-primary">{f.title}</h3>
                  <p className="relative mt-1 text-compact text-muted leading-relaxed">{f.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Pricing teaser — driven from lib/plans.js (the single source of truth), so this
            section can never advertise something the plans don't contain. */}
        <section className="relative py-14">
          <Divider />
          <div data-lp-reveal className="text-center max-w-2xl mx-auto">
            <h2 className="text-2xl lg:text-3xl font-semibold font-brand tracking-tight">Simple plans, free to start</h2>
            <p className="mt-2 text-faint">{PRICING_COPY.earlyAccessNote}</p>
          </div>
          <div className="mt-9 grid sm:grid-cols-2 gap-4 max-w-3xl mx-auto items-stretch">
            {[free, pro].map((plan) => (
              <div key={plan.id} data-lp-reveal style={{ '--lp-d': plan.popular ? '120ms' : '0ms' }} className="h-full">
                <div className={`relative h-full rounded-2xl border p-6 flex flex-col ${plan.popular ? 'border-brand-hover/40 bg-brand/10' : 'border-line-subtle bg-fill-subtle'}`}>
                  {plan.popular && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 h-6 rounded-full bg-brand-gradient-cta text-brand-fg text-micro font-bold uppercase tracking-wider inline-flex items-center">
                      Most popular
                    </span>
                  )}
                  <div className="text-sm font-semibold text-primary">{plan.name}</div>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="text-3xl font-semibold font-brand tracking-tight text-primary">
                      {formatMoney(monthlyEquivalent(plan, BILLING_CYCLE.monthly))}
                    </span>
                    <span className="text-note text-faint">/ month</span>
                  </div>
                  <p className="mt-1 text-compact text-muted">{plan.tagline}</p>
                  <ul className="mt-4 space-y-2 flex-1">
                    {plan.highlights.slice(0, 4).map((h) => (
                      <li key={h} className="flex items-start gap-2 text-compact text-secondary">
                        <Check className="w-3.5 h-3.5 text-success-text mt-0.5 shrink-0" />{h}
                      </li>
                    ))}
                  </ul>
                  {plan.popular ? (
                    <Link to="/pricing" className="mt-5 h-10 rounded-xl bg-brand hover:bg-brand-hover text-brand-fg text-sm font-semibold flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                      See everything in Pro
                    </Link>
                  ) : (
                    <Link to="/signup" className="mt-5 h-10 rounded-xl border border-line bg-fill text-sm font-semibold text-primary hover:bg-fill-strong flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                      Start free
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p data-lp-reveal className="mt-5 text-center text-note text-faint">
            Running several teams?{' '}
            <Link to="/pricing" className="text-brand-text hover:text-brand-text-hover underline underline-offset-2 transition-colors">
              Compare all plans, including Business
            </Link>
          </p>
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
            <h2 className="relative text-2xl lg:text-3xl font-semibold font-brand tracking-tight">One team. One workspace. Inside and out.</h2>
            <p className="relative mt-2 text-muted">Create a workspace in seconds and invite anyone — staff or not.</p>
            <div className="relative mt-6 flex justify-center gap-3">
              <Magnetic>
                <Link to="/signup" className="h-12 px-6 rounded-xl bg-brand-gradient-cta text-brand-fg font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-brand/20 hover:brightness-110 active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                  Start free <ArrowRight className="w-4 h-4" />
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
