import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { auth, members } from './lib/api';
import AuthScreen from './AuthScreen';
import VisualTaskCommandCenter from './VisualTaskCommandCenter';
import { supabase } from './lib/supabase';

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
      // Keep the Realtime socket's JWT in sync on login / token refresh / logout.
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

  if (checking) {
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

  if (!session) return <AuthScreen />;

  return <VisualTaskCommandCenter session={session} currentMember={currentMember} onSignOut={handleSignOut} />;
}
