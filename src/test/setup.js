/* =================================================================================
   TEST SETUP — jsdom gap-filling, applied before every test file.

   Everything here exists because jsdom implements a subset of the DOM. Each stub below
   was added because a REAL call site in the app hits it; none is speculative. The call
   sites are named so that if one disappears in Phase B, the stub can go too.
================================================================================= */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/* --------------------------------------------------------------------------------
   MODULE MOCKS — declared here, once, so every test file gets them without repeating
   the incantation. Both use an async factory with a dynamic import: `vi.mock` factories
   are hoisted above imports, so they cannot close over a top-level binding, but they CAN
   await an import inside the factory body.

   `./lib/supabase` MUST be mocked even though `./lib/api` is: the client is imported
   directly by App.jsx and the monolith, and it throws at module scope without env vars.
-------------------------------------------------------------------------------- */
vi.mock('../lib/supabase', async () => (await import('./supabaseMock.js')).buildSupabaseMock());
vi.mock('../lib/api', async () => (await import('./apiMock.js')).buildApiMock());

/* --------------------------------------------------------------------------------
   window.matchMedia — NOT implemented by jsdom.

   `prefersReducedMotion()` guards with `!!window.matchMedia`, so leaving this undefined
   makes it return false and the app takes the ANIMATED path everywhere: deleteTask and
   deleteProject then defer their real work behind a 180ms setTimeout.

   We report `matches: true` (reduced motion ON). That is not a cosmetic choice — it makes
   the delete paths synchronous, so a test can assert the outcome without fake timers and
   without a 180ms sleep. The animated path still gets explicit coverage in the task test,
   which overrides this per-test.
-------------------------------------------------------------------------------- */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** @param {boolean} reduced */
export function setReducedMotion(reduced) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: query === REDUCED_MOTION_QUERY ? reduced : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
setReducedMotion(true);

/* --------------------------------------------------------------------------------
   Element scrolling — NOT implemented by jsdom; calling either throws.
     - Element.prototype.scrollTo    → TaskComments (scrolls on every new comment),
                                        MessageList.jump
     - Element.prototype.scrollIntoView → AssigneeSelect (keyboard nav in the dropdown)
-------------------------------------------------------------------------------- */
Element.prototype.scrollTo = Element.prototype.scrollTo || function scrollTo() {};
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function scrollIntoView() {};

/* --------------------------------------------------------------------------------
   URL.createObjectURL / revokeObjectURL — NOT implemented by jsdom.
   Call sites: exportJSON (download anchor), the avatar picker preview, and both voice-note
   composers (team chat + DM). Without these, exportJSON and any voice path throw TypeError.
-------------------------------------------------------------------------------- */
if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:test/00000000-0000-0000-0000-000000000000');
}
if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn();
}

/* --------------------------------------------------------------------------------
   Cross-test isolation.

   The monolith holds module-scope state that outlives unmount — a `memStore` object behind
   themeStore, a `localAudioUrls` Map, and a `nowPlayingAudio` element. We cannot reach those
   from here (the module does not export them), which is precisely why each test file must
   avoid depending on module state it did not set. What we CAN reset is the DOM, storage, and
   the data-theme attribute the theme initializer writes during render.
-------------------------------------------------------------------------------- */
afterEach(() => {
  cleanup();
  try { window.localStorage.clear(); } catch { /* storage may be stubbed to throw */ }
  try { window.sessionStorage.clear(); } catch { /* ditto */ }
  document.documentElement.removeAttribute('data-theme');
  setReducedMotion(true);
  // The harness pushes each test's route into jsdom history (the app reads window.location
  // directly). Reset it, or the next test inherits the previous one's URL — including any
  // `?ws=`, which would silently select a different workspace at boot.
  window.history.replaceState({}, '', '/');
});
