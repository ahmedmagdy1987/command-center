import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Sparkles, Lock, ArrowRight, AlertCircle, Loader2, KeyRound } from 'lucide-react';
import { auth } from './lib/api';
import { supabase } from './lib/supabase';

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

  const canSubmit = password.length >= 6 && password === confirm && phase !== 'saving';

  const submit = async (e) => {
    e.preventDefault();
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
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
    <div className="min-h-screen bg-[#070810] text-white flex items-center justify-center p-6 relative overflow-hidden">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Outfit:wght@300..700&display=swap');
        body { font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif; background: #070810; }
        .font-display { font-family: 'Fraunces', ui-serif, serif; font-optical-sizing: auto; font-weight: 500; }
        @keyframes float { 0%,100% { transform: translateY(0px); } 50% { transform: translateY(-20px); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div className="absolute top-1/4 -left-32 w-96 h-96 rounded-full bg-violet-500/10 blur-3xl pointer-events-none" style={{ animation: 'float 8s ease-in-out infinite' }} />
      <div className="absolute bottom-1/4 -right-32 w-96 h-96 rounded-full bg-fuchsia-500/10 blur-3xl pointer-events-none" style={{ animation: 'float 8s ease-in-out infinite reverse' }} />

      <div className="relative w-full max-w-md" style={{ animation: 'fadeIn .4s ease' }}>
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-2xl shadow-fuchsia-500/30 mb-4">
            <Sparkles className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-semibold text-white font-display tracking-tight">Command Center</h1>
          <p className="text-sm text-white/40 mt-1">Visual task management</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#0f1017]/80 backdrop-blur p-6 shadow-2xl">
          {phase === 'verifying' && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <Loader2 className="w-6 h-6 text-white/50 animate-spin" />
              <p className="text-sm text-white/50">Verifying your reset link…</p>
            </div>
          )}

          {phase === 'invalid' && (
            <div className="text-center py-2">
              <div className="w-11 h-11 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center mx-auto mb-3">
                <AlertCircle className="w-5 h-5 text-rose-300" />
              </div>
              <h2 className="text-base font-semibold text-white">Reset link invalid or expired</h2>
              <p className="text-[12px] text-white/45 mt-1.5 mb-5">This password-reset link is no longer valid. Request a fresh one and try again.</p>
              <Link to="/forgot-password"
                className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm hover:shadow-lg hover:shadow-fuchsia-500/30 transition-all">
                Request a new link <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          )}

          {(phase === 'ready' || phase === 'saving') && (
            <>
              <div className="text-center mb-5">
                <div className="w-11 h-11 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center mx-auto mb-3">
                  <KeyRound className="w-5 h-5 text-violet-300" />
                </div>
                <h2 className="text-base font-semibold text-white">Set a new password</h2>
                <p className="text-[11px] text-white/40 mt-1">Choose a new password for your account.</p>
              </div>

              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">New password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                    <input type="password" value={password} onChange={e => setPassword(e.target.value)} required autoFocus
                      placeholder="At least 6 characters"
                      className="w-full bg-black/30 border border-white/10 rounded-xl pl-10 pr-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50 focus:bg-black/40 transition-colors" />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">Confirm password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                    <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required
                      placeholder="Re-enter your new password"
                      className="w-full bg-black/30 border border-white/10 rounded-xl pl-10 pr-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50 focus:bg-black/40 transition-colors" />
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                    <span>{error}</span>
                  </div>
                )}

                <button type="submit" disabled={!canSubmit}
                  className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                  {phase === 'saving' ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                    <>
                      Update password
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-white/30">
          Your private tasks stay yours. Workspace tasks sync with your team.
        </p>
      </div>
    </div>
  );
}
