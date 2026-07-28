import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock, ArrowRight } from 'lucide-react';
import { auth } from './lib/api';
import AuthShell, { AuthField, AuthBanner, AuthCTA } from './AuthShell';

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
 * Presentation lives in AuthShell (shared with the other pre-app screens).
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
    if (view === 'signup' && password.length < 10) { setError('Password must be at least 10 characters.'); return; }
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
  const busyLabel = view === 'reset' ? 'Sending…'
                  : view === 'signup' ? 'Creating account…'
                  : 'Signing in…';
  const canSubmit = view === 'reset' ? !!email : (!!email && !!password);

  return (
    <AuthShell>
      <div className="text-center mb-5">
        <h2 className="text-base font-semibold text-primary">{heading}</h2>
        <p className="text-meta text-faint mt-1">{subheading}</p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div className="au-in" style={{ animationDelay: '.16s' }}>
          <label className="text-micro font-medium uppercase tracking-widest text-faint mb-1.5 block">Email</label>
          <AuthField icon={Mail} type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
            placeholder="you@example.com" />
        </div>

        {view !== 'reset' && (
          <div className="au-in" style={{ animationDelay: '.2s' }}>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-micro font-medium uppercase tracking-widest text-faint block">Password</label>
              {view === 'signin' && (
                <button type="button" onClick={() => navigate('/forgot-password')}
                  className="text-micro font-medium text-brand-text/70 hover:text-brand-text transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
                  Forgot password?
                </button>
              )}
            </div>
            <AuthField icon={Lock} type="password" value={password} onChange={e => setPassword(e.target.value)} required
              placeholder={view === 'signup' ? 'At least 10 characters' : 'Your password'} />
          </div>
        )}

        {error && <AuthBanner tone="error">{error}</AuthBanner>}
        {info && <AuthBanner tone="ok">{info}</AuthBanner>}

        <div className="au-in" style={{ animationDelay: '.26s' }}>
          <AuthCTA busy={loading} busyLabel={busyLabel} disabled={loading || !canSubmit}>
            {cta}
            <ArrowRight className="w-4 h-4" />
          </AuthCTA>
        </div>
      </form>

      {view === 'reset' && (
        <div className="au-in" style={{ animationDelay: '.32s' }}>
          <button onClick={() => navigate('/login')}
            className="mt-4 w-full text-center text-meta text-faint hover:text-secondary transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
            ← Back to sign in
          </button>
        </div>
      )}
      {SIGNUP_ENABLED && view === 'signin' && (
        <p className="au-in mt-4 text-center text-meta text-faint" style={{ animationDelay: '.32s' }}>
          Don’t have an account?{' '}
          <button onClick={() => setSignupOpen(true)}
            className="text-brand-text/80 hover:text-brand-text font-medium rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
            Create one
          </button>
        </p>
      )}
      {SIGNUP_ENABLED && view === 'signup' && (
        <div className="au-in" style={{ animationDelay: '.32s' }}>
          <button onClick={() => setSignupOpen(false)}
            className="mt-4 w-full text-center text-meta text-faint hover:text-secondary transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
            ← Back to sign in
          </button>
        </div>
      )}
    </AuthShell>
  );
}
