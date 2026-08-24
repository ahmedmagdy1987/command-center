/* =================================================================================
   SUPABASE CLIENT MOCK.

   `src/lib/supabase.js` THROWS AT MODULE TOP LEVEL when VITE_SUPABASE_URL /
   VITE_SUPABASE_ANON_KEY are absent. Both App.jsx and VisualTaskCommandCenter.jsx import it
   directly, so without this mock every test would fail at import time — before a single
   render — with "Missing Supabase env vars". Mocking `./lib/api` alone does NOT save you;
   the client is imported on its own line too.

   The surface here is deliberately tiny, because the app only touches the raw client in two
   places (everything else goes through api.js):
     - `supabase.realtime.setAuth(token)` — App.jsx, on every session change.
     - `supabase.auth.updateUser({ password })` — the in-app password change.
   If this mock ever needs a third method, that is a signal the app grew a new direct
   dependency on the client that probably belongs in api.js instead.
================================================================================= */
import { vi } from 'vitest';

export function buildSupabaseMock() {
  return {
    supabase: {
      auth: {
        updateUser: vi.fn(async () => ({ data: {}, error: null })),
        getSession: vi.fn(async () => ({ data: { session: null } })),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      },
      realtime: {
        setAuth: vi.fn(),
      },
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis(),
        track: vi.fn(),
        presenceState: vi.fn(() => ({})),
      })),
      removeChannel: vi.fn(),
    },
  };
}
