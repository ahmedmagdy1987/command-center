import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';

/**
 * Shared marketing chrome used across the public pages (landing, pricing, terms, privacy) so the
 * header and footer stay identical everywhere. The header is sticky with a subtle blurred bar.
 */
export function SiteHeader({ session }) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#070810]/80 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-5 lg:px-8 h-14 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center shadow-lg shadow-fuchsia-500/20">
            <Sparkles className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-[15px] font-semibold font-display tracking-tight">Command Center</span>
        </Link>
        <nav className="flex items-center gap-1.5">
          <Link to="/pricing" className="hidden sm:inline-flex h-9 px-3.5 rounded-lg text-sm font-medium text-white/70 hover:text-white hover:bg-white/[0.06] items-center transition-colors">Pricing</Link>
          {session ? (
            <Link to="/" className="h-9 px-4 rounded-lg text-sm font-semibold bg-white text-[#0a0b11] hover:bg-white/90 flex items-center transition-colors">Open app</Link>
          ) : (
            <>
              <Link to="/login" className="h-9 px-3.5 rounded-lg text-sm font-medium text-white/70 hover:text-white hover:bg-white/[0.06] flex items-center transition-colors">Log in</Link>
              <Link to="/signup" className="h-9 px-4 rounded-lg text-sm font-semibold bg-white text-[#0a0b11] hover:bg-white/90 flex items-center transition-colors shadow-lg shadow-black/20">Sign up</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative border-t border-white/[0.06] mt-8">
      <div className="max-w-6xl mx-auto px-5 lg:px-8 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-[12px] text-white/40">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 via-fuchsia-500 to-rose-500 flex items-center justify-center">
            <Sparkles className="w-3 h-3 text-white" />
          </div>
          <span className="text-white/60 font-medium">Command Center</span>
          <span className="hidden sm:inline text-white/25">·</span>
          <span className="hidden sm:inline">© {year} Command Center. All rights reserved.</span>
        </div>
        <nav className="flex items-center gap-4">
          <Link to="/pricing" className="hover:text-white/70 transition-colors">Pricing</Link>
          <Link to="/terms" className="hover:text-white/70 transition-colors">Terms</Link>
          <Link to="/privacy" className="hover:text-white/70 transition-colors">Privacy</Link>
          <a href="mailto:hello@example.com" className="hover:text-white/70 transition-colors">Contact</a>
        </nav>
      </div>
    </footer>
  );
}
