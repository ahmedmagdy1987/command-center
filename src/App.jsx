import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { auth, members } from './lib/api';
import AuthScreen from './AuthScreen';
import ResetPasswordScreen from './ResetPasswordScreen';
import InviteScreen from './InviteScreen';
import LandingPage from './LandingPage';
import VisualTaskCommandCenter from './VisualTaskCommandCenter';
import { supabase } from './lib/supabase';

function FullScreenSpinner() {
  return (
    <div className="min-h-screen bg-[#070810] text-white flex items-center justify-center">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300..700&display=swap');
        body { font-family: 'Outfit', sans-serif; background: #070810; }
      `}</style>
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-2xl shadow-fuchsia-500/30 animate-pulse">
        <Sparkles className="w-6 h-6 text-white" />
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
      .catch(() => { /* member info is non-critical, don't break the app */ });
    return () => { cancelled = true; };
  }, [session?.user?.id]);

  const handleSignOut = async () => {
    try { await auth.signOut(); } catch (err) { console.error('Sign out failed:', err); }
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

      {/* Everything else: the authenticated app (its own view routes live in AppShell), or — when
          signed out — the public landing at / with every other path sent to sign-in. */}
      <Route
        path="/*"
        element={
          session
            ? <VisualTaskCommandCenter session={session} currentMember={currentMember} onSignOut={handleSignOut} />
            : <PublicRoutes />
        }
      />
    </Routes>
  );
}
