import { useCallback, useRef, useState } from 'react';
import {
  KanbanSquare, Grid3x3, CalendarDays, MessageSquare, Check, Play, Lock, Mic,
} from 'lucide-react';

/**
 * Interactive product demo for the landing page — the conversion centerpiece.
 *
 * PRESENTATIONAL ONLY, by design and by rule: mock data, zero backend calls, zero
 * imports from api.js/supabase.js. The widgets deliberately mirror the REAL app's
 * anatomy (priority stripe on the card's left edge, assignee chips, guest badge,
 * matrix quadrants, chat read-receipts) so a visitor experiences the idea without
 * signing up — but nothing here is wired to anything.
 *
 * The tab strip is a real WAI-ARIA tablist (roving tabindex, arrow keys) because it
 * is the one genuinely interactive element on the page. Panels re-mount on switch
 * (React `key`) so the entrance animation replays.
 *
 * Motion: transform/opacity keyframes only, all named `ld*`, all killed by the
 * page-level prefers-reduced-motion rule (`.lp-root * { animation: none }`) — every
 * static style below is the complete resting state, so a reduced-motion visitor
 * sees a finished page, not a blank one.
 *
 * The cross-org story is told IN the data: "Priya · guest" appears on a card, in
 * the matrix, and in chat — the same external collaborator, everywhere, exactly
 * how the product's guest role works (guests see only their own/assigned tasks).
 */

/* Personas. Fictional names; hues from the app's categorical assignee palette. */
const PEOPLE = {
  maya:  { name: 'Maya',  hex: '#7c8cff', soft: 'rgba(124,140,255,0.14)' },
  jonas: { name: 'Jonas', hex: '#34d399', soft: 'rgba(52,211,153,0.14)' },
  priya: { name: 'Priya', hex: '#f472b6', soft: 'rgba(244,114,182,0.14)', guest: true },
  sam:   { name: 'Sam',   hex: '#fb923c', soft: 'rgba(251,146,60,0.14)' },
};

/* The app's real priority hues (categorical, deliberately not theme tokens). */
const PRIORITY = { critical: '#f43f5e', high: '#fb923c', medium: '#facc15', low: '#38bdf8' };

const TABS = [
  { id: 'kanban', label: 'Kanban', icon: KanbanSquare },
  { id: 'matrix', label: 'Priority Matrix', icon: Grid3x3 },
  { id: 'schedule', label: 'Schedule', icon: CalendarDays },
  { id: 'chat', label: 'Messages', icon: MessageSquare },
];

function AvatarDot({ person, size = 18, ring = false }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold shrink-0 ${ring ? 'border border-dashed' : ''}`}
      style={{
        width: size, height: size, fontSize: size * 0.5,
        background: person.soft, color: person.hex,
        borderColor: ring ? person.hex : undefined,
      }}
      aria-hidden="true"
    >
      {person.name[0]}
    </span>
  );
}

function GuestBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-brand-alt/40 bg-brand-alt/10 text-brand-alt-text px-1.5 h-4 text-[9px] font-semibold uppercase tracking-wide">
      guest
    </span>
  );
}

/** A real-anatomy task card: left priority stripe, title, assignee, due chip. */
function DemoCard({ title, person, priority, due, done, lock, className = '', style }) {
  return (
    <div
      className={`relative rounded-lg border border-line-subtle bg-surface-raised p-2.5 pl-3.5 ${done ? 'opacity-60' : ''} ${className}`}
      style={style}
    >
      <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full" style={{ background: PRIORITY[priority] }} aria-hidden="true" />
      <div className={`text-note font-medium text-primary leading-snug ${done ? 'line-through' : ''}`}>{title}</div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <AvatarDot person={person} size={16} ring={person.guest} />
        <span className="text-micro text-faint truncate">{person.name}{person.guest ? ' · outside collaborator' : ''}</span>
        {person.guest && <GuestBadge />}
        {lock && <Lock className="w-3 h-3 text-faint ml-auto shrink-0" aria-hidden="true" />}
        {due && !lock && <span className="ml-auto text-[9px] text-faint tabular-nums shrink-0">{due}</span>}
        {done && <Check className="w-3 h-3 text-success-text ml-auto shrink-0" aria-hidden="true" />}
      </div>
    </div>
  );
}

/* No count badge on purpose: a static number contradicts the animated board for most
 * of the travel loop (the card is mid-flight), and under reduced motion the landed
 * slot is hidden entirely — a wrong count reads as a bug in the product being demoed. */
const ColHead = ({ tint, children }) => (
  <div className="flex items-center gap-1.5 mb-2 text-micro uppercase tracking-widest text-faint">
    <span className="w-1.5 h-1.5 rounded-full" style={{ background: tint }} />{children}
  </div>
);

/* ---------------------------------- Kanban ---------------------------------- */
function KanbanPanel() {
  return (
    // tabIndex + region: a horizontal scroller is keyboard-unreachable without it,
    // which hides the Done column from keyboard users on narrow viewports.
    <div tabIndex={0} role="region" aria-label="Kanban board preview, scrolls horizontally"
      className="overflow-x-auto no-scrollbar -mx-1 px-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
      <div className="grid grid-cols-3 gap-3 min-w-[560px]">
        <div>
          <ColHead tint="#7c8cff">Inbox</ColHead>
          <div className="relative space-y-2">
            {/* The travelling card: the static copy fades as the overlay clone slides one
                column right — same sleight of hand as the hero board. */}
            <DemoCard className="ld-goA" title="Collect launch-page feedback" person={PEOPLE.priya} priority="high" due="Fri" />
            <DemoCard title="Draft October newsletter" person={PEOPLE.maya} priority="medium" due="Tue" />
            <div className="ld-go absolute inset-x-0 top-0 z-10 !mt-0">
              <DemoCard className="shadow-xl shadow-black/30" title="Collect launch-page feedback" person={PEOPLE.priya} priority="high" due="Fri" style={{ opacity: 0 }} />
            </div>
          </div>
        </div>
        <div>
          <ColHead tint="#38bdf8">Must Do</ColHead>
          <div className="space-y-2">
            {/* Landing slot. NO inline opacity on the landed card: its rest state must be
                VISIBLE so a prefers-reduced-motion visitor (all animations killed) sees a
                complete board, not a blank slot — same pattern as the hero LiveBoard. */}
            <div className="relative ld-landB-wrap">
              <div className="ld-hint absolute inset-0 rounded-lg border border-dashed border-brand-hover/40" style={{ opacity: 0 }} />
              <DemoCard className="ld-landB" title="Collect launch-page feedback" person={PEOPLE.priya} priority="high" due="Fri" />
            </div>
            <DemoCard title="Fix onboarding empty state" person={PEOPLE.jonas} priority="critical" due="Today" />
            <DemoCard title="Prep client kickoff deck" person={PEOPLE.sam} priority="high" due="Thu" />
          </div>
        </div>
        <div>
          <ColHead tint="#34d399">Done</ColHead>
          <div className="space-y-2">
            <DemoCard title="Ship pricing page copy" person={PEOPLE.maya} priority="medium" done />
            <DemoCard title="Invoice review — September" person={PEOPLE.priya} priority="low" done />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Matrix ---------------------------------- */
function Quad({ title, tint, children }) {
  return (
    <div className="rounded-xl border border-line-subtle bg-fill-subtle p-3 min-h-[118px]">
      <div className="text-micro uppercase tracking-widest font-semibold mb-2" style={{ color: tint }}>{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function MatrixPanel() {
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <Quad title="Do first" tint={PRIORITY.critical}>
          <DemoCard className="ld-pulse" title="Fix onboarding empty state" person={PEOPLE.jonas} priority="critical" due="Today" />
        </Quad>
        <Quad title="Schedule" tint="#7c8cff">
          <DemoCard title="Draft October newsletter" person={PEOPLE.maya} priority="medium" due="Tue" />
        </Quad>
        <Quad title="Delegate" tint="#fb923c">
          <DemoCard title="Collect launch-page feedback" person={PEOPLE.priya} priority="high" due="Fri" />
        </Quad>
        <Quad title="Eliminate" tint="#64748b">
          <DemoCard title="Research CRM integrations" person={PEOPLE.sam} priority="low" />
        </Quad>
      </div>
      <p className="mt-3 text-micro text-faint">Urgent × important — the right work rises on its own.</p>
    </div>
  );
}

/* --------------------------------- Schedule --------------------------------- */
function SchedulePanel() {
  const days = [
    { d: 'Mon', n: 6 }, { d: 'Tue', n: 7, items: [{ t: 'Newsletter draft', p: 'medium', who: PEOPLE.maya }] },
    { d: 'Wed', n: 8, today: true, items: [{ t: 'Onboarding fix', p: 'critical', who: PEOPLE.jonas }] },
    { d: 'Thu', n: 9, items: [{ t: 'Kickoff deck', p: 'high', who: PEOPLE.sam }] },
    { d: 'Fri', n: 10, items: [{ t: 'Launch feedback', p: 'high', who: PEOPLE.priya }] },
  ];
  return (
    <div tabIndex={0} role="region" aria-label="Week schedule preview, scrolls horizontally"
      className="overflow-x-auto no-scrollbar -mx-1 px-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
      <div className="grid grid-cols-5 gap-2 min-w-[540px]">
        {days.map((day) => (
          <div key={day.d} className={`rounded-xl border p-2 min-h-[150px] ${day.today ? 'border-brand-hover/40 bg-brand/10' : 'border-line-subtle bg-fill-subtle'}`}>
            <div className="flex items-baseline gap-1 mb-2">
              <span className={`text-micro uppercase tracking-widest ${day.today ? 'text-brand-text font-semibold' : 'text-faint'}`}>{day.d}</span>
              <span className="text-micro text-faint tabular-nums">{day.n}</span>
              {day.today && <span className="ml-auto text-[9px] font-semibold text-brand-text uppercase">Today</span>}
            </div>
            <div className="space-y-1.5">
              {(day.items || []).map((it) => (
                <div key={it.t} className="rounded-md border border-line-subtle bg-surface-raised px-1.5 py-1 flex items-center gap-1.5">
                  <span className="w-1 h-3 rounded-full shrink-0" style={{ background: PRIORITY[it.p] }} />
                  <span className="text-micro text-secondary truncate">{it.t}</span>
                  <AvatarDot person={it.who} size={13} ring={it.who.guest} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-micro text-faint">Due dates on a timeline — reminders fire before things slip.</p>
    </div>
  );
}

/* ----------------------------------- Chat ----------------------------------- */
function Bubble({ who, children, delay, mine }) {
  return (
    <div className={`ld-msg flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''}`} style={{ '--ld-d': delay }}>
      <AvatarDot person={who} ring={who.guest} />
      <div className={`max-w-[75%] rounded-2xl px-3 py-2 border ${mine ? 'bg-brand/15 border-brand-hover/25 rounded-br-md' : 'bg-fill border-line-subtle rounded-bl-md'}`}>
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-micro font-semibold" style={{ color: who.hex }}>{who.name}</span>
          {who.guest && <GuestBadge />}
        </div>
        <div className="text-note text-secondary leading-snug">{children}</div>
      </div>
    </div>
  );
}

function ChatPanel() {
  return (
    <div className="max-w-md mx-auto">
      {/* A 1:1 DIRECT MESSAGE, deliberately. In the product, guests are excluded from
          team chat entirely — their surfaces are their own tasks + DMs — and DMs are
          strictly two-person. Showing Priya in a group channel would promise a thing
          the product refuses to do. Viewer = Maya, so her messages sit right. */}
      <div className="flex items-center gap-2 pb-2 mb-3 border-b border-line-subtle">
        <AvatarDot person={PEOPLE.priya} ring />
        <span className="text-note font-semibold text-primary">Priya</span>
        <GuestBadge />
        <span className="ml-auto text-micro text-faint">Direct message</span>
      </div>
      <div className="space-y-3">
        <Bubble who={PEOPLE.maya} delay="0s" mine>Priya, can you take the launch-page feedback round?</Bubble>
        <Bubble who={PEOPLE.priya} delay=".5s">
          On it — I only see my own tasks here, which honestly keeps it simple.
        </Bubble>
        {/* Voice note — the product's real DM feature, mocked. Sent by Maya (mine). */}
        <div className="ld-msg flex items-end gap-2 flex-row-reverse" style={{ '--ld-d': '1s' }}>
          <AvatarDot person={PEOPLE.maya} />
          <div className="rounded-2xl rounded-br-md px-3 py-2 border bg-brand/15 border-brand-hover/25 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-brand/20 border border-brand-hover/30 flex items-center justify-center shrink-0">
              <Play className="w-3 h-3 text-brand-text translate-x-px" fill="currentColor" aria-hidden="true" />
            </span>
            <span className="flex items-center gap-[2px]" aria-hidden="true">
              {[5, 9, 13, 8, 11, 6, 12, 9, 5, 10, 7, 4].map((h, i) => (
                <span key={i} className="w-[3px] rounded-full bg-brand-text/60" style={{ height: h }} />
              ))}
            </span>
            <span className="text-micro text-faint tabular-nums">0:09</span>
            <Mic className="w-3 h-3 text-faint" aria-hidden="true" />
          </div>
        </div>
        {/* DM read receipt: visible text, so it reads the same to screen readers. */}
        <div className="ld-msg flex items-center justify-end gap-1 pr-1" style={{ '--ld-d': '1.3s' }}>
          <Check className="w-3 h-3 text-brand-text" aria-hidden="true" />
          <span className="text-[9px] text-faint">Seen by Priya</span>
        </div>
        {/* Priya typing a reply */}
        <div className="ld-msg flex items-center gap-2" style={{ '--ld-d': '1.6s' }}>
          <AvatarDot person={PEOPLE.priya} ring />
          <span className="rounded-2xl rounded-bl-md px-3 py-2.5 border bg-fill border-line-subtle inline-flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="ld-dot w-1.5 h-1.5 rounded-full bg-faint" style={{ animationDelay: `${i * 0.18}s` }} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

const PANELS = { kanban: KanbanPanel, matrix: MatrixPanel, schedule: SchedulePanel, chat: ChatPanel };

const BLURB = {
  kanban: 'Drag work through your pipeline — everyone sees it move, instantly.',
  matrix: 'Urgent vs. important, on a 2×2 — priorities argue for themselves.',
  schedule: 'The week at a glance, with due-date reminders built in.',
  chat: 'Team chat for your crew, plus 1:1 direct messages that work with guests too.',
};

export default function LandingDemo() {
  const [tab, setTab] = useState('kanban');
  const tabRefs = useRef({});
  const Panel = PANELS[tab];

  /* Roving-tabindex arrows, per the ARIA tabs pattern. */
  const onKeyDown = useCallback((e) => {
    const idx = TABS.findIndex((t) => t.id === tab);
    let next = null;
    if (e.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length].id;
    if (e.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length].id;
    if (e.key === 'Home') next = TABS[0].id;
    if (e.key === 'End') next = TABS[TABS.length - 1].id;
    if (next) { e.preventDefault(); setTab(next); tabRefs.current[next]?.focus(); }
  }, [tab]);

  return (
    <div className="rounded-2xl border border-line bg-surface-raised shadow-2xl overflow-hidden">
      {/* Window chrome */}
      {/* flex-wrap + py: on a 360px phone the four tabs wrap to a second row instead
          of vanishing into an invisible (no-scrollbar) horizontal scroller. */}
      <div className="flex items-center flex-wrap gap-2 px-4 py-2 border-b border-line-subtle bg-fill-subtle">
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span className="w-2.5 h-2.5 rounded-full bg-danger-hover/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-warning-hover/70" />
          <span className="w-2.5 h-2.5 rounded-full bg-success-hover/70" />
        </span>
        {/* Tab strip */}
        <div role="tablist" aria-label="Product views" onKeyDown={onKeyDown}
          className="ml-2 flex items-center flex-wrap gap-1">
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                ref={(el) => { tabRefs.current[t.id] = el; }}
                role="tab"
                id={`ld-tab-${t.id}`}
                aria-selected={active}
                aria-controls="ld-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-note font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text ${
                  active ? 'bg-brand/15 text-brand-text border border-brand-hover/30' : 'text-muted hover:text-secondary hover:bg-fill border border-transparent'
                }`}
              >
                <t.icon className="w-3.5 h-3.5" aria-hidden="true" />{t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Panel: keyed so the entrance replays on every switch. Fixed min-height so
          switching tabs never reflows the page below. */}
      <div
        role="tabpanel"
        id="ld-panel"
        aria-labelledby={`ld-tab-${tab}`}
        className="p-4 lg:p-5 min-h-[360px]"
      >
        <div key={tab} className="ld-enter">
          <Panel />
        </div>
      </div>

      <div className="px-4 lg:px-5 pb-4 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-note text-faint">{BLURB[tab]}</p>
        <p className="text-micro text-faint/80 shrink-0">Interactive preview · sample data</p>
      </div>
    </div>
  );
}
