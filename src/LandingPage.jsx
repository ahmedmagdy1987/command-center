import { Link } from 'react-router-dom';
import {
  KanbanSquare, Grid3x3, CalendarDays, UserCog, Zap, UserPlus, ArrowRight, Check,
} from 'lucide-react';
import { SiteHeader, SiteFooter } from './SiteChrome';

/**
 * Public marketing landing page (logged-out `/`). Honest to what the product actually does: a
 * visual team task command center, with no invented stats, logos, or testimonials. Copy is
 * placeholder positioning meant to be refined. Matches the app's visual language (dark, the
 * violet/fuchsia/rose gradient, Outfit + Fraunces). CTAs route to /signup and /login.
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

export default function LandingPage() {
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

      <SiteHeader />

      <div className="relative max-w-6xl mx-auto px-5 lg:px-8">
        {/* Hero (compact: fits above the fold on a typical laptop) */}
        <section className="pt-8 lg:pt-12 pb-10 grid lg:grid-cols-2 gap-8 lg:gap-10 items-center" style={{ animation: 'fadeUp .5s ease' }}>
          <div>
            <div className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-violet-300/80 bg-violet-500/10 border border-violet-400/20 rounded-full px-3 h-7 mb-4">
              Visual task management for teams
            </div>
            <h1 className="text-3xl lg:text-4xl xl:text-5xl font-semibold font-display tracking-tight leading-[1.05]">
              Stop losing track of who’s doing what.
            </h1>
            <p className="mt-4 text-sm lg:text-base text-white/55 max-w-xl leading-relaxed">
              Pull every task, owner, and due date into one visual workspace. Track it on a kanban board,
              a priority matrix, or a schedule, live for the whole team.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Link to="/signup" className="h-11 px-6 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 transition-all">
                Get organized free <ArrowRight className="w-4 h-4" />
              </Link>
              <Link to="/login" className="h-11 px-6 rounded-xl border border-white/10 bg-white/[0.03] text-white/80 font-medium text-sm flex items-center hover:bg-white/[0.06] transition-colors">
                Log in
              </Link>
            </div>
            <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px] text-white/40">
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-emerald-400" /> Real-time sync</span>
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-emerald-400" /> Private &amp; shared tasks</span>
              <span className="inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-emerald-400" /> Team chat &amp; direct messages</span>
            </div>
          </div>

          {/* Decorative stylized board (not real data; a visual hint of the UI) */}
          <div className="relative hidden lg:block" aria-hidden="true">
            <div className="rounded-2xl border border-white/10 bg-[#0f1017]/80 backdrop-blur p-4 shadow-2xl">
              <div className="flex items-center gap-1.5 mb-4">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-400/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/70" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'To do', color: '#a78bfa', n: 3 },
                  { label: 'Doing', color: '#38bdf8', n: 2 },
                  { label: 'Done', color: '#34d399', n: 2 },
                ].map(col => (
                  <div key={col.label}>
                    <div className="flex items-center gap-1.5 mb-2 text-[10px] uppercase tracking-widest text-white/40">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: col.color }} />{col.label}
                    </div>
                    <div className="space-y-2">
                      {Array.from({ length: col.n }).map((_, i) => (
                        <div key={i} className="rounded-lg border border-white/[0.06] bg-white/[0.03] p-2.5">
                          <div className="h-1.5 rounded-full mb-2" style={{ width: `${60 + ((i * 17) % 35)}%`, background: col.color, opacity: 0.5 }} />
                          <div className="h-1 rounded-full bg-white/10" style={{ width: `${40 + ((i * 23) % 40)}%` }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="py-14 border-t border-white/[0.06]">
          <h2 className="text-2xl lg:text-3xl font-semibold font-display tracking-tight">Everything your team needs to stay on track</h2>
          <p className="mt-2 text-white/45 max-w-2xl">One workspace for the work, the people, and the plan.</p>
          <div className="mt-9 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map(f => (
              <div key={f.title} className="rounded-2xl border border-white/[0.06] bg-gradient-to-br from-white/[0.03] to-transparent p-5">
                <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-400/20 flex items-center justify-center mb-3">
                  <f.icon className="w-5 h-5 text-violet-300" />
                </div>
                <h3 className="text-base font-semibold text-white">{f.title}</h3>
                <p className="mt-1 text-[13px] text-white/50 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="py-14 border-t border-white/[0.06]">
          <h2 className="text-2xl lg:text-3xl font-semibold font-display tracking-tight">How it works</h2>
          <div className="mt-9 grid md:grid-cols-3 gap-4">
            {STEPS.map(s => (
              <div key={s.n} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-sm font-bold mb-3">{s.n}</div>
                <h3 className="text-base font-semibold text-white">{s.title}</h3>
                <p className="mt-1 text-[13px] text-white/50 leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA band */}
        <section className="py-14 border-t border-white/[0.06]">
          <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-violet-500/15 via-fuchsia-500/10 to-transparent p-8 lg:p-12 text-center">
            <h2 className="text-2xl lg:text-3xl font-semibold font-display tracking-tight">Ready to organize your team’s work?</h2>
            <p className="mt-2 text-white/55">Create a workspace in seconds. It’s free to get started.</p>
            <div className="mt-6 flex justify-center gap-3">
              <Link to="/signup" className="h-12 px-6 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 transition-all">
                Get organized free <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </section>
      </div>

      <SiteFooter />
    </div>
  );
}
