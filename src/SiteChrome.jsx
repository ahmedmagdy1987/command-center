import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { pointerMotionOK } from './lib/motion';

/**
 * Shared marketing chrome used across the public pages (landing, pricing, terms, privacy) so the
 * header and footer stay identical everywhere. The header is sticky and scroll-aware: transparent
 * at the top of the page, with a blurred dark bar that CROSSFADES in (opacity-only — the bar is a
 * separate absolutely-positioned layer, so no layout ever changes) once the page scrolls.
 *
 * Also home to the shared marketing motion COMPONENTS (Magnetic, Hairline) so the landing and
 * pricing pages share one implementation; the non-component utilities (pointerMotionOK,
 * useRevealOnScroll) live in lib/motion.js to keep this file exporting components only
 * (react-refresh rule). Everything animates transform/opacity only.
 */

/** Magnetic wrapper for a primary CTA: the button leans a few px toward the cursor and springs
 *  back on leave. Transform-only, writes straight to the node (no state), desktop-only. The
 *  spring transition is inline so the component is self-contained on any page (a page-level
 *  `transition: none !important` reduced-motion override still beats it). */
export function Magnetic({ children, className = '' }) {
  const ref = useRef(null);
  const onMove = (e) => {
    const el = ref.current;
    if (!el || !pointerMotionOK()) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    el.style.transform = `translate(${(dx * 5).toFixed(1)}px, ${(dy * 4).toFixed(1)}px)`;
  };
  const onLeave = () => { if (ref.current) ref.current.style.transform = ''; };
  return (
    <span
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={`inline-flex ${className}`}
      style={{ transition: 'transform .35s cubic-bezier(.22,1,.36,1)' }}
    >
      {children}
    </span>
  );
}

/** Gradient hairline — the marketing pages' section divider. */
export const Hairline = ({ className = '' }) => (
  <div aria-hidden="true" className={`h-px bg-gradient-to-r from-transparent via-brand-hover/25 to-transparent ${className}`} />
);

/** Text nav link with an animated gradient underline (transform-only scale-x). */
function NavTextLink({ to, className = '', children }) {
  return (
    <Link
      to={to}
      className={`relative h-9 px-3.5 rounded-lg text-sm font-medium text-secondary hover:text-white items-center transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text after:content-[''] after:absolute after:left-3.5 after:right-3.5 after:bottom-1.5 after:h-px after:bg-gradient-to-r after:from-brand-hover after:to-brand-alt-hover after:origin-left after:scale-x-0 hover:after:scale-x-100 after:transition-transform after:duration-300 motion-reduce:after:transition-none ${className}`}
    >
      {children}
    </Link>
  );
}

export function SiteHeader({ session }) {
  const [scrolled, setScrolled] = useState(() => typeof window !== 'undefined' && window.scrollY > 8);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; setScrolled(window.scrollY > 8); });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  return (
    <header className="sticky top-0 z-40">
      {/* Crossfaded bar: border + blur + shadow live here and fade in on scroll */}
      <div
        aria-hidden="true"
        className={`absolute inset-0 border-b border-line-subtle bg-canvas/85 backdrop-blur-md shadow-lg shadow-sm transition-opacity duration-300 motion-reduce:transition-none ${scrolled ? 'opacity-100' : 'opacity-0'}`}
      />
      <div className="relative max-w-6xl mx-auto px-5 lg:px-8 h-14 flex items-center justify-between">
        <Link to="/" className="group flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">
          <div className="w-7 h-7 rounded-lg bg-brand-gradient flex items-center justify-center shadow-lg shadow-brand-alt/20 transition-transform duration-300 motion-reduce:transition-none group-hover:scale-110 group-hover:rotate-6">
            <Sparkles className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-[15px] font-semibold font-display tracking-tight">Command Center</span>
        </Link>
        <nav className="flex items-center gap-1.5">
          <NavTextLink to="/pricing" className="hidden sm:inline-flex">Pricing</NavTextLink>
          {session ? (
            <Link to="/" className="h-9 px-4 rounded-lg text-sm font-semibold bg-inverse text-inverse-fg hover:bg-inverse/90 active:scale-[.97] flex items-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">Open app</Link>
          ) : (
            <>
              <NavTextLink to="/login" className="flex">Log in</NavTextLink>
              <Link to="/signup" className="h-9 px-4 rounded-lg text-sm font-semibold bg-inverse text-inverse-fg hover:bg-inverse/90 active:scale-[.97] flex items-center transition-all shadow-lg shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-text">Sign up</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

function FooterCol({ title, links }) {
  return (
    <div>
      <div className="text-micro font-medium uppercase tracking-widest text-muted mb-2">{title}</div>
      <ul className="space-y-1 text-compact">
        {links.map(([label, to]) => (
          <li key={label}>
            {to.startsWith('mailto:')
              ? <a href={to} className="inline-block py-1.5 text-muted hover:text-white transition-colors">{label}</a>
              : <Link to={to} className="inline-block py-1.5 text-muted hover:text-white transition-colors">{label}</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="relative mt-8 overflow-hidden">
      <div aria-hidden="true" className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-brand-hover/25 to-transparent" />
      <div aria-hidden="true" className="absolute -top-28 left-1/2 -ml-44 h-72 rounded-full pointer-events-none" style={{ width: '22rem', background: 'radial-gradient(closest-side, rgba(139,92,246,.09), transparent 70%)' }} />
      <div className="relative max-w-6xl mx-auto px-5 lg:px-8 pt-10 pb-8">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-8">
          <div className="max-w-xs">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-brand-gradient flex items-center justify-center">
                <Sparkles className="w-3 h-3 text-white" />
              </div>
              <span className="text-secondary font-semibold font-display tracking-tight">Command Center</span>
            </div>
            <p className="mt-3 text-note text-faint leading-relaxed">
              One visual workspace for your team’s tasks, owners, and due dates — live for everyone.
            </p>
          </div>
          <div className="flex gap-14">
            <FooterCol title="Product" links={[['Pricing', '/pricing'], ['Log in', '/login'], ['Sign up', '/signup']]} />
            <FooterCol title="Company" links={[['Terms', '/terms'], ['Privacy', '/privacy'], ['Contact', 'mailto:support@opscommandcenter.com']]} />
          </div>
        </div>
        <div className="mt-9 pt-5 border-t border-line-subtle text-note text-muted">
          © {year} Command Center. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
