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
  return { plugins: [react()] }
})
