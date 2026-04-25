import React, { useState } from 'react';
import { Sparkles, Mail, Lock, ArrowRight, AlertCircle, Loader2 } from 'lucide-react';
import { auth } from './lib/api';

export default function AuthScreen() {
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true); setError(null); setInfo(null);
    try {
      if (mode === 'signin') {
        await auth.signIn(email, password);
        // App will re-render from session listener
      } else {
        const result = await auth.signUp(email, password);
        if (result?.user && !result?.session) {
          setInfo('Account created! Check your email to confirm, then sign in.');
          setMode('signin');
        }
      }
    } catch (err) {
      setError(err.message || 'Something went wrong. Try again.');
    } finally {
      setLoading(false);
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
          {/* Tab switcher */}
          <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/5 mb-6">
            <button onClick={() => { setMode('signin'); setError(null); setInfo(null); }}
              className={`flex-1 h-9 rounded-lg text-sm font-medium transition-colors ${
                mode === 'signin' ? 'bg-white text-black' : 'text-white/60 hover:text-white'
              }`}>
              Sign in
            </button>
            <button onClick={() => { setMode('signup'); setError(null); setInfo(null); }}
              className={`flex-1 h-9 rounded-lg text-sm font-medium transition-colors ${
                mode === 'signup' ? 'bg-white text-black' : 'text-white/60 hover:text-white'
              }`}>
              Sign up
            </button>
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

            <div>
              <label className="text-[10px] font-medium uppercase tracking-widest text-white/40 mb-1.5 block">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40 pointer-events-none" />
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                  minLength={6}
                  placeholder={mode === 'signup' ? 'At least 6 characters' : 'Your password'}
                  className="w-full bg-black/30 border border-white/10 rounded-xl pl-10 pr-3 h-11 text-sm text-white placeholder-white/30 outline-none focus:border-violet-400/50 focus:bg-black/40 transition-colors" />
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                <span>{error}</span>
              </div>
            )}
            {info && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
                <Sparkles className="w-4 h-4 shrink-0 mt-px" />
                <span>{info}</span>
              </div>
            )}

            <button type="submit" disabled={loading || !email || !password}
              className="w-full h-11 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:shadow-lg hover:shadow-fuchsia-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : (
                <>
                  {mode === 'signin' ? 'Sign in' : 'Create account'}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-5 pt-5 border-t border-white/5 text-center text-[11px] text-white/40">
            {mode === 'signin' ? (
              <>New here? <button onClick={() => { setMode('signup'); setError(null); }} className="text-violet-300 hover:text-violet-200 font-medium">Create an account</button></>
            ) : (
              <>Already have an account? <button onClick={() => { setMode('signin'); setError(null); }} className="text-violet-300 hover:text-violet-200 font-medium">Sign in</button></>
            )}
          </div>
        </div>

        <p className="mt-6 text-center text-[11px] text-white/30">
          Your private tasks stay yours. Workspace tasks sync with your team.
        </p>
      </div>
    </div>
  );
}
