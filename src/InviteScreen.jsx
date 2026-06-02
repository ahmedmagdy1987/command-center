import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Mail, Lock, ArrowRight, AlertCircle, Loader2, CheckCircle2, UserPlus } from 'lucide-react';
import { auth, invitations as invitationsApi } from './lib/api';

/**
 * Public /invite/:token screen (sibling to the auth routes in App.jsx, so it bypasses the in-app
 * onboarding bounce). It is the email-bound accept entry point.
 *
 * Signed OUT: sign in, or create an account using the email the invite was sent to (this is the
 *   token-gated invited-signup path — public SIGNUP_ENABLED on the welcome screen stays closed).
 *   On auth, App's session listener re-renders this screen in its signed-in state.
 * Signed IN: preview the token (authenticated-only). If it's valid + the caller's email matches,
 *   show Accept -> accept_invitation -> land in the new workspace. If the email doesn't match,
 *   explain and offer sign-out. Invalid / expired / revoked / already-accepted each get a message.
 */
export default function InviteScreen({ session }) {
  const { token } = useParams();
  const navigate = useNavigate();

  // Signed-out auth sub-form
  const [signupMode, setSignupMode] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authErr, setAuthErr] = useState(null);
  const [authInfo, setAuthInfo] = useState(null);

  // Signed-in preview + accept
  const [preview, setPreview] = useState(undefined); // undefined=loading, null=not found, object=found
  const [previewErr, setPreviewErr] = useState(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptErr, setAcceptErr] = useState(null);

  const myEmail = session?.user?.email || '';

  // Load the preview once signed in.
  useEffect(() => {
    if (!session) return;   // signed-out renders the auth sub-form; preview stays in its loading state
    let alive = true;
    invitationsApi.preview(token)
      .then(p => { if (alive) setPreview(p ?? null); })
      .catch(err => { if (alive) { setPreview(null); setPreviewErr(err?.message || 'Could not load this invitation.'); } });
    return () => { alive = false; };
  }, [session, token]);

  const submitAuth = async (e) => {
    e.preventDefault();
    setAuthErr(null); setAuthInfo(null);
    if (!email || !password) return;
    setAuthBusy(true);
    try {
      if (signupMode) {
        await auth.signUp(email, password);
        setAuthInfo('Account created. If asked, confirm your email, then sign in here to accept.');
        setSignupMode(false);
      } else {
        await auth.signIn(email, password);   // App's session listener re-renders this screen signed-in
      }
    } catch (err) {
      setAuthErr(err?.message || 'Something went wrong. Please try again.');
    } finally { setAuthBusy(false); }
  };

  const accept = async () => {
    setAccepting(true); setAcceptErr(null);
    try {
      const ws = await invitationsApi.accept(token);
      navigate(ws?.id ? `/?ws=${ws.id}` : '/', { replace: true });
    } catch (err) {
      setAcceptErr(err?.message || 'Could not accept this invitation.');
      setAccepting(false);
    }
  };

  const signOut = async () => { try { await auth.signOut(); } catch { /* ignore */ } };

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
        <div className="flex flex-col items-center mb-7">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-2xl shadow-fuchsia-500/30 mb-4">
            <UserPlus className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-semibold text-white font-display tracking-tight">You're invited</h1>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#0f1017]/80 backdrop-blur p-6 shadow-2xl">
          {!session ? (
            // ---- Signed out: sign in or create an account ----
            <>
              <div className="text-center mb-5">
                <h2 className="text-base font-semibold text-white">{signupMode ? 'Create your account' : 'Sign in to continue'}</h2>
                <p className="text-[11px] text-white/40 mt-1">Use the email your invitation was sent to.</p>
              </div>
              <form onSubmit={submitAuth} className="space-y-4">
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus placeholder="you@example.com"
                    className="w-full bg-black/30 border border-white/10 rounded-xl pl-10 pr-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50 transition-colors" />
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                  <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder={signupMode ? 'At least 6 characters' : 'Your password'}
                    className="w-full bg-black/30 border border-white/10 rounded-xl pl-10 pr-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50 transition-colors" />
                </div>
                {authErr && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-px" /><span>{authErr}</span>
                  </div>
                )}
                {authInfo && (
                  <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" /><span>{authInfo}</span>
                  </div>
                )}
                <button type="submit" disabled={authBusy || !email || !password}
                  className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                  {authBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : (<>{signupMode ? 'Create account' : 'Sign in'}<ArrowRight className="w-4 h-4" /></>)}
                </button>
              </form>
              <button onClick={() => { setSignupMode(m => !m); setAuthErr(null); setAuthInfo(null); }}
                className="mt-4 w-full text-center text-[11px] text-white/40 hover:text-white/70 transition-colors">
                {signupMode ? '← I already have an account' : "I don't have an account yet — create one"}
              </button>
            </>
          ) : preview === undefined ? (
            <div className="py-6 flex items-center justify-center text-sm text-white/50 gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Checking your invitation…</div>
          ) : preview === null ? (
            <Message tone="error" title="Invitation not found"
              body={previewErr || "This invitation link is invalid. Ask whoever invited you to send a fresh link."} />
          ) : preview.status === 'revoked' ? (
            <Message tone="error" title="Invitation revoked" body="This invitation was revoked by the workspace owner." />
          ) : preview.status === 'accepted' ? (
            <Message tone="ok" title="Already accepted" body="You've already accepted this invitation."
              action={<PrimaryBtn onClick={() => navigate('/', { replace: true })}>Go to the app</PrimaryBtn>} />
          ) : preview.is_expired ? (
            <Message tone="error" title="Invitation expired" body="This invitation has expired. Ask the owner to send a new one." />
          ) : preview.email && myEmail && preview.email.toLowerCase() !== myEmail.toLowerCase() ? (
            <Message tone="error" title="Wrong account"
              body={`This invitation is for ${preview.email}, but you're signed in as ${myEmail}. Sign out and sign in with the invited email to accept.`}
              action={<button onClick={signOut} className="w-full h-11 rounded-xl border border-white/10 bg-white/5 text-sm font-medium text-white/80 hover:bg-white/10 transition-colors">Sign out</button>} />
          ) : (
            // Valid + email matches -> accept
            <div className="text-center">
              <h2 className="text-base font-semibold text-white mb-1">Join {preview.workspace_name}</h2>
              <p className="text-[12px] text-white/45 mb-5">You'll join as a member, signed in as {myEmail}.</p>
              {acceptErr && (
                <div className="flex items-start gap-2 px-3 py-2.5 mb-4 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 text-left">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-px" /><span>{acceptErr}</span>
                </div>
              )}
              <PrimaryBtn onClick={accept} disabled={accepting}>
                {accepting ? <Loader2 className="w-4 h-4 animate-spin" /> : (<>Accept invitation<ArrowRight className="w-4 h-4" /></>)}
              </PrimaryBtn>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PrimaryBtn({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
      {children}
    </button>
  );
}

function Message({ tone, title, body, action }) {
  const color = tone === 'ok' ? 'text-emerald-300' : 'text-rose-300';
  return (
    <div className="text-center">
      <h2 className={`text-base font-semibold ${color} mb-1`}>{title}</h2>
      <p className="text-[12px] text-white/50 mb-5">{body}</p>
      {action}
    </div>
  );
}
