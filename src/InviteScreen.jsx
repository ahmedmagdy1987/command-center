import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Mail, Lock, ArrowRight, Loader2, UserPlus } from 'lucide-react';
import { auth, invitations as invitationsApi } from './lib/api';
import { reportError } from './lib/errors';
import AuthShell, { AuthField, AuthBanner, AuthCTA } from './AuthShell';

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
 * Presentation lives in AuthShell (shared with the other pre-app screens).
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
      // Prefer the readable slug; an id falls back and self-upgrades to the slug on landing.
      navigate(ws?.slug ? `/?ws=${ws.slug}` : ws?.id ? `/?ws=${ws.id}` : '/', { replace: true });
    } catch (err) {
      setAcceptErr(err?.message || 'Could not accept this invitation.');
      setAccepting(false);
    }
  };

  const signOut = async () => { try { await auth.signOut(); } catch (e) { reportError(e, 'auth.signOut'); } };

  return (
    <AuthShell icon={UserPlus} heading="You're invited" tagline="Join your team on Command Center">
      {!session ? (
        // ---- Signed out: sign in or create an account ----
        <>
          <div className="text-center mb-5">
            <h2 className="text-base font-semibold text-white">{signupMode ? 'Create your account' : 'Sign in to continue'}</h2>
            <p className="text-[11px] text-white/40 mt-1">Use the email your invitation was sent to.</p>
          </div>
          <form onSubmit={submitAuth} className="space-y-4">
            <div className="au-in" style={{ animationDelay: '.16s' }}>
              <AuthField icon={Mail} type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
                placeholder="you@example.com" />
            </div>
            <div className="au-in" style={{ animationDelay: '.2s' }}>
              <AuthField icon={Lock} type="password" value={password} onChange={e => setPassword(e.target.value)} required
                placeholder={signupMode ? 'At least 10 characters' : 'Your password'} />
            </div>
            {authErr && <AuthBanner tone="error">{authErr}</AuthBanner>}
            {authInfo && <AuthBanner tone="ok">{authInfo}</AuthBanner>}
            <div className="au-in" style={{ animationDelay: '.26s' }}>
              <AuthCTA busy={authBusy} busyLabel={signupMode ? 'Creating account…' : 'Signing in…'} disabled={authBusy || !email || !password}>
                {signupMode ? 'Create account' : 'Sign in'}
                <ArrowRight className="w-4 h-4" />
              </AuthCTA>
            </div>
          </form>
          <div className="au-in" style={{ animationDelay: '.32s' }}>
            <button onClick={() => { setSignupMode(m => !m); setAuthErr(null); setAuthInfo(null); }}
              className="mt-4 w-full text-center text-[11px] text-white/40 hover:text-white/70 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
              {signupMode ? '← I already have an account' : "I don't have an account yet. Create one"}
            </button>
          </div>
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
          action={<AuthCTA type="button" onClick={() => navigate('/', { replace: true })}>Go to the app</AuthCTA>} />
      ) : preview.is_expired ? (
        <Message tone="error" title="Invitation expired" body="This invitation has expired. Ask the owner to send a new one." />
      ) : preview.email && myEmail && preview.email.toLowerCase() !== myEmail.toLowerCase() ? (
        <Message tone="error" title="Wrong account"
          body={`This invitation is for ${preview.email}, but you're signed in as ${myEmail}. Sign out and sign in with the invited email to accept.`}
          action={
            <button onClick={signOut}
              className="w-full h-11 rounded-xl border border-white/10 bg-white/5 text-sm font-medium text-white/80 hover:bg-white/10 active:scale-[.97] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300">
              Sign out
            </button>
          } />
      ) : (
        // Valid + email matches -> accept
        <div className="text-center">
          <h2 className="text-base font-semibold text-white mb-1">Join {preview.workspace_name}</h2>
          <p className="text-[12px] text-white/45 mb-5">You'll be added to this workspace, signed in as {myEmail}.</p>
          {acceptErr && <div className="mb-4"><AuthBanner tone="error">{acceptErr}</AuthBanner></div>}
          <AuthCTA type="button" onClick={accept} busy={accepting} busyLabel="Accepting…" disabled={accepting}>
            Accept invitation
            <ArrowRight className="w-4 h-4" />
          </AuthCTA>
        </div>
      )}
    </AuthShell>
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
