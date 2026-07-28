import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { auth, members } from './lib/api';
import { reportError, logCaught } from './lib/errors';
import AuthScreen from './AuthScreen';
import ResetPasswordScreen from './ResetPasswordScreen';
import InviteScreen from './InviteScreen';
import LandingPage from './LandingPage';
import PricingPage from './PricingPage';
import CheckoutScreen from './CheckoutScreen';
import TermsPage from './TermsPage';
import PrivacyPage from './PrivacyPage';
import VisualTaskCommandCenter from './VisualTaskCommandCenter';
import { supabase } from './lib/supabase';

function FullScreenSpinner() {
  return (
    <div data-surface="dark" className="min-h-screen bg-canvas text-primary flex items-center justify-center">
      
      <div className="w-12 h-12 rounded-2xl bg-brand-gradient flex items-center justify-center shadow-2xl shadow-brand/15 animate-pulse">
        <Sparkles className="w-6 h-6 text-brand-fg" />
      </div>
    </div>
  );
}

/** Logged-out routing: the public landing at /, everything else -> the sign-in screen. */
function PublicRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [currentMember, setCurrentMember] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;
    auth.getSession().then((s) => {
      if (!mounted) return;
      // Authenticate the Realtime socket so RLS-protected postgres_changes are delivered live.
      supabase.realtime.setAuth(s?.access_token ?? null);
      setSession(s);
      setChecking(false);
    });

    const unsub = auth.onAuthChange((s) => {
      if (!mounted) return;
      // Keep the Realtime socket's JWT in sync on login / token refresh / logout / recovery.
      supabase.realtime.setAuth(s?.access_token ?? null);
      setSession(s);
      if (!s) setCurrentMember(null);
    });
    return () => { mounted = false; unsub(); };
  }, []);

  // Load current member when session changes (silently fail — non-critical)
  useEffect(() => {
    if (!session) { setCurrentMember(null); return; }
    let cancelled = false;
    members.getCurrent()
      .then(m => { if (!cancelled) setCurrentMember(m); })
      .catch(logCaught('members.getCurrent'));   // member info is non-critical, don't break the app
    return () => { cancelled = true; };
  }, [session?.user?.id]);

  // Re-fetch the signed-in user's member row (after they edit their own profile) so the top bar reflects it.
  const refreshCurrentMember = useCallback(async () => {
    try { setCurrentMember(await members.getCurrent()); } catch (e) { reportError(e, 'members.refresh'); }
  }, []);

  const handleSignOut = async () => {
    try { await auth.signOut(); } catch (err) { reportError(err, 'auth.signOut'); }
  };

  // Gate ALL routing behind the initial session check, so no auth screen flashes before we know
  // whether a session exists (prevents a /login flash for already-signed-in users on reload).
  if (checking) return <FullScreenSpinner />;

  return (
    <Routes>
      {/* Public auth routes. /forgot-password + /reset-password must stay reachable without a normal
          session — the recovery link arrives before/independent of one (and may itself establish a
          recovery session, which is why /reset-password is never gated on session). */}
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <AuthScreen key="signin" mode="signin" />} />
      <Route path="/forgot-password" element={<AuthScreen key="reset" mode="reset" />} />
      <Route path="/reset-password" element={<ResetPasswordScreen />} />

      {/* Email-bound invite acceptance. Public (like the recovery routes): reachable without a
          session — a signed-out invitee signs in / creates an account here, then accepts. */}
      <Route path="/invite/:token" element={<InviteScreen session={session} />} />

      {/* Public sign-up lands directly on the create-account form (the welcome screen otherwise). */}
      <Route path="/signup" element={session ? <Navigate to="/" replace /> : <AuthScreen key="signup" mode="signin" initialSignup />} />

      {/* Monetization surfaces. Public (reachable signed-out for the demand test) and
          also from in-app upgrade prompts. Checkout works either way (it asks a
          signed-out visitor to sign in first). No live payment — see lib/billing.js. */}
      <Route path="/pricing" element={<PricingPage session={session} />} />
      <Route path="/checkout" element={<CheckoutScreen session={session} />} />

      {/* Public legal pages (template content; reachable signed-in or out). */}
      <Route path="/terms" element={<TermsPage session={session} />} />
      <Route path="/privacy" element={<PrivacyPage session={session} />} />

      {/* Everything else: the authenticated app (its own view routes live in AppShell), or — when
          signed out — the public landing at / with every other path sent to sign-in. */}
      <Route
        path="/*"
        element={
          session
            ? <VisualTaskCommandCenter session={session} currentMember={currentMember} onSignOut={handleSignOut} refreshCurrentMember={refreshCurrentMember} />
            : <PublicRoutes />
        }
      />
    </Routes>
  );
}
