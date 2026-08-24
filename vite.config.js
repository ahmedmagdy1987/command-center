import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  // Fail LOUDLY instead of silently emitting an app-less bundle: a missing
  // VITE_SUPABASE_URL makes src/lib/supabase.js throw at module top level,
  // which rolldown DCE then strips the whole app after (exit 0, empty app).
  const missing = REQUIRED.filter((k) => !env[k] && !process.env[k])
  if (command === 'build' && missing.length) {
    throw new Error(
      `[vite] Missing required env var(s): ${missing.join(', ')}. ` +
      `Refusing to build an app-less bundle. Ensure .env exists at the repo ` +
      `root and is UTF-8 WITHOUT a BOM.`
    )
  }
  return {
    plugins: [react()],

    // Vitest. Deliberately colocated with the real Vite config rather than a separate
    // vitest.config.js: tests then compile through the EXACT plugin/transform pipeline that
    // ships, so a test can never pass against a different build of the code than production
    // runs. The env guard above is scoped to `command === 'build'`, so it never fires here.
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.js'],
      css: false,
      restoreMocks: true,
      // The monolith is one ~7k-line module; a single test file importing it dominates
      // startup. Keep the reporter quiet enough that a failure is findable.
      reporters: 'default',
      include: ['src/**/*.test.{js,jsx}'],
    },
  }
})
