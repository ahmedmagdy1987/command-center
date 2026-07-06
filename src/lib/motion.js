import { useEffect } from 'react';

/**
 * Shared motion utilities for the marketing pages (landing, pricing). Everything here animates
 * transform/opacity only. Pages remain responsible for their own reduced-motion CSS overrides
 * (the [data-lp-reveal] hidden state must live inside @media (prefers-reduced-motion:
 * no-preference) in the page's style block).
 */

/** True when it makes sense to run pointer-chasing niceties: a fine pointer and motion allowed.
 *  Checked per event (not once) so a mid-session reduced-motion toggle takes effect instantly. */
export const pointerMotionOK = () =>
  window.matchMedia('(pointer: fine)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Reveals [data-lp-reveal] descendants of rootRef on first view (adds .lp-seen, then
 *  unobserves). Runs even under reduced motion — the hidden state only exists in the page's
 *  no-preference CSS, so adding the class there is a harmless no-op and a mid-session
 *  preference switch can never strand content hidden. */
export function useRevealOnScroll(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll('[data-lp-reveal]'));
    if (!els.length) return;
    if (!('IntersectionObserver' in window)) { els.forEach(el => el.classList.add('lp-seen')); return; }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { en.target.classList.add('lp-seen'); io.unobserve(en.target); }
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [rootRef]);
}
