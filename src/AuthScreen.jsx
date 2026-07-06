import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Mail, Lock, ArrowRight, AlertCircle, Loader2, CheckCircle2 } from 'lucide-react';
import { auth } from './lib/api';

// ── Public sign-up switch ─────────────────────────────────────────────────────
// Public sign-up is OPEN: invitations shipped, and onboarding routes a no-workspace user to
// create their first workspace (becoming its owner). This is the single APP-side gate — the
// Supabase project must ALSO have "Allow new users to sign up" + Confirm email ON (with working
// SMTP) for signups to actually land. The invited-signup path (InviteScreen) is independent of this.
const SIGNUP_ENABLED = true;

/**
 * Welcome / sign-in screen. `mode` ('signin' | 'reset') is driven by the route (/login vs
 * /forgot-password), so those transitions are real navigations. Sign-up (now open) is an
 * in-screen toggle layered on the signin view (no dedicated route yet).
 */
export default function AuthScreen({ mode = 'signin', initialSignup = false }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [signupOpen, setSignupOpen] = useState(initialSignup);

  // Transient state (error/info/signupOpen) is reset on route change via a per-mode `key` in App.jsx,
  // which remounts this screen on /login <-> /forgot-password — no effect needed.
  const view = (SIGNUP_ENABLED && signupOpen) ? 'signup' : mode;   // 'signin' | 'reset' | 'signup'

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setInfo(null);

    if (view === 'reset') {
      if (!email) return;
      setLoading(true);
      try {
        await auth.resetPassword(email);
        setInfo('If an account exists for that email, a password-reset link is on its way.');
      } catch (err) {
        setError(err.message || 'Could not send the reset email. Please try again.');
      } finally { setLoading(false); }
      return;
    }

    if (!email || !password) return;
    setLoading(true);
    try {
      if (view === 'signup') {
        await auth.signUp(email, password);
        setInfo('Account created. Check your email to confirm, then sign in.');
        setSignupOpen(false);
      } else {
        await auth.signIn(email, password);   // App routes us in once the session listener fires
      }
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally { setLoading(false); }
  };

  const heading = view === 'reset' ? 'Reset your password'
                : view === 'signup' ? 'Create your account'
                : 'Welcome back';
  const subheading = view === 'reset' ? 'Enter your email and we’ll send you a reset link.'
                   : view === 'signup' ? 'Set up your credentials to get started.'
                   : 'Sign in to your Command Center.';
  const cta = view === 'reset' ? 'Send reset link'
            : view === 'signup' ? 'Create account'
            : 'Sign in';
  const canSubmit = view === 'reset' ? !!email : (!!email && !!password);

  return (
    <div className="min-h-screen bg-[#070810] text-white flex items-center justify-center p-6 relative overflow-hidden">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Outfit:wght@300..700&display=swap');
        body { font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif; background: #070810; }
        .font-display { font-family: 'Fraunces', ui-serif, serif; font-optical-sizing: auto; font-weight: 500; }
        @keyframes float { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-20px); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {/* Background glows */}
      <div className="absolute top-1/4 -left-32 w-96 h-96 rounded-full bg-violet-500/10 blur-3xl pointer-events-none" style={{ animation: 'float 8s ease-in-out infinite' }} />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 rounded-full bg-fuchsia-500/10 blur-3xl pointer-events-none" style={{ animation: 'float 8s ease-in-out infinite reverse' }} />

      <div className="relative w-full max-w-md" style={{ animation: 'fadeIn .4s ease' }}>
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-2xl shadow-fuchsia-500/30 mb-4">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-semibold text-white font-display tracking-tight">Command Center</h1>
          <p className="text-sm text-white/40 mt-1">Visual task management</p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/10 bg-[#0f1017]/80 backdrop-blur p-6 shadow-2xl">
          <div className="text-center mb-5">
            <h2 className="text-base font-semibold text-white">{heading}</h2>
            <p className="text-[11px] text-white/40 mt-1">{subheading}</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
                  placeholder="you@example.com"
                  className="w-full bg-black/30 border border-white/10 rounded-xl pl-10 pr-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50 focus:bg-black/40 transition-colors" />
              </div>
            </div>

            {view !== 'reset' && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 block">Password</label>
                  {view === 'signin' && (
                    <button type="button" onClick={() => navigate('/forgot-password')}
                      className="text-[10px] font-medium text-violet-300/70 hover:text-violet-200 transition-colors">
                      Forgot password?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                    placeholder={view === 'signup' ? 'At least 10 characters' : 'Your password'}
                    className="w-full bg-black/30 border border-white/10 rounded-xl pl-10 pr-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50 focus:bg-black/40 transition-colors" />
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                <span>{error}</span>
              </div>
            )}
            {info && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
                <span>{info}</span>
              </div>
            )}

            <button type="submit" disabled={loading || !canSubmit}
              className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                <>
                  {cta}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {view === 'reset' && (
            <button onClick={() => navigate('/login')}
              className="mt-4 w-full text-center text-[11px] text-white/40 hover:text-white/70 transition-colors">
              ← Back to sign in
            </button>
          )}
          {SIGNUP_ENABLED && view === 'signin' && (
            <p className="mt-4 text-center text-[11px] text-white/40">
              Don’t have an account?{' '}
              <button onClick={() => setSignupOpen(true)} className="text-violet-300/80 hover:text-violet-200 font-medium">Create one</button>
            </p>
          )}
          {SIGNUP_ENABLED && view === 'signup' && (
            <button onClick={() => setSignupOpen(false)}
              className="mt-4 w-full text-center text-[11px] text-white/40 hover:text-white/70 transition-colors">
              ← Back to sign in
            </button>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-white/30">
          Your private tasks stay yours. Workspace tasks sync with your team.
        </p>
      </div>
    </div>
  );
}
