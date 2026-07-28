import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Lock, ArrowRight, AlertCircle, Loader2, KeyRound } from 'lucide-react';
import { auth } from './lib/api';
import { supabase } from './lib/supabase';
import AuthShell, { AuthField, AuthBanner, AuthCTA } from './AuthShell';
import { Magnetic } from './SiteChrome';

/**
 * The page a Supabase password-recovery email link lands on (/reset-password).
 *
 * Recovery detection (no token hand-parsing): the client is created with detectSessionInUrl on
 * (default), so it turns the recovery link's hash into a session and fires PASSWORD_RECOVERY.
 *  - PRIMARY: getSession() on mount — by the time we render, the recovery session is usually set.
 *  - FALLBACK (timing race): subscribe to the RAW supabase.auth.onAuthStateChange for
 *    PASSWORD_RECOVERY / a late session (the api.js onAuthChange wrapper drops the event).
 *  - If neither yields a session, the link is invalid/expired.
 *
 * On success the recovery session is a full session, so we navigate to "/" and let the normal
 * authenticated gating route the user in (their workspace, or /onboarding if none).
 * Presentation lives in AuthShell (shared with the other pre-app screens).
 */
export default function ResetPasswordScreen() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState('verifying');   // 'verifying' | 'ready' | 'invalid' | 'saving'
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    // PRIMARY: the recovery link has (usually) already been turned into a session.
    auth.getSession().then((s) => {
      if (active && s) setPhase((p) => (p === 'verifying' ? 'ready' : p));
    }).catch(() => { /* fall through to the listener / timeout */ });

    // FALLBACK: catch PASSWORD_RECOVERY or a session that arrives just after mount.
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (active && (event === 'PASSWORD_RECOVERY' || sess)) {
        setPhase((p) => (p === 'verifying' ? 'ready' : p));
      }
    });

    // No session established → the link is invalid or expired.
    const timer = setTimeout(() => {
      if (active) setPhase((p) => (p === 'verifying' ? 'invalid' : p));
    }, 4000);

    return () => { active = false; sub.subscription.unsubscribe(); clearTimeout(timer); };
  }, []);

  const canSubmit = password.length >= 10 && password === confirm && phase !== 'saving';

  const submit = async (e) => {
    e.preventDefault();
    if (password.length < 10) { setError('Password must be at least 10 characters.'); return; }
    if (password !== confirm) { setError('Passwords don’t match.'); return; }
    setError(null);
    setPhase('saving');
    try {
      await auth.updatePassword(password);
      navigate('/', { replace: true });   // recovery session is now a full session → authed gating takes over
    } catch (err) {
      setError(err.message || 'Could not update your password. Please try again.');
      setPhase('ready');
    }
  };

  return (
    <AuthShell>
      {phase === 'verifying' && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Loader2 className="w-6 h-6 text-muted animate-spin" />
          <p className="text-sm text-muted">Verifying your reset link…</p>
        </div>
      )}

      {phase === 'invalid' && (
        <div className="text-center py-2">
          <div className="w-11 h-11 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-3">
            <AlertCircle className="w-5 h-5 text-rose-300" />
          </div>
          <h2 className="text-base font-semibold text-white">Reset link invalid or expired</h2>
          <p className="text-[12px] text-faint mt-1.5 mb-5">This password-reset link is no longer valid. Request a fresh one and try again.</p>
          <Magnetic>
            <Link to="/forgot-password"
              className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm hover:shadow-lg hover:shadow-fuchsia-500/40 hover:brightness-110 active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
              Request a new link <ArrowRight className="w-4 h-4" />
            </Link>
          </Magnetic>
        </div>
      )}

      {(phase === 'ready' || phase === 'saving') && (
        <>
          <div className="text-center mb-5">
            <div className="w-11 h-11 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center mx-auto mb-3">
              <KeyRound className="w-5 h-5 text-violet-300" />
            </div>
            <h2 className="text-base font-semibold text-white">Set a new password</h2>
            <p className="text-[11px] text-faint mt-1">Choose a new password for your account.</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div className="au-in" style={{ animationDelay: '.16s' }}>
              <label className="text-[10px] font-medium uppercase tracking-widest text-faint mb-1.5 block">New password</label>
              <AuthField icon={Lock} type="password" value={password} onChange={e => setPassword(e.target.value)} required autoFocus
                placeholder="At least 10 characters" />
            </div>

            <div className="au-in" style={{ animationDelay: '.2s' }}>
              <label className="text-[10px] font-medium uppercase tracking-widest text-faint mb-1.5 block">Confirm password</label>
              <AuthField icon={Lock} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
                placeholder="Re-enter your new password" />
            </div>

            {error && <AuthBanner tone="error">{error}</AuthBanner>}

            <div className="au-in" style={{ animationDelay: '.26s' }}>
              <AuthCTA busy={phase === 'saving'} busyLabel="Updating…" disabled={!canSubmit}>
                Update password
                <ArrowRight className="w-4 h-4" />
              </AuthCTA>
            </div>
          </form>
        </>
      )}
    </AuthShell>
  );
}
