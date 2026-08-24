import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // Build-time config runs in Node, not the browser, so it needs Node globals on
  // top of the browser set above. Without this, the `process.env` reads in
  // vite.config.js's env guard are 2 `no-undef` errors that sit on top of the real
  // baseline — noise that makes lint useless as a pass/fail gate.
  {
    files: ['*.config.js'],
    languageOptions: { globals: globals.node },
  },
])
