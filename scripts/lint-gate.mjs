#!/usr/bin/env node
/* =================================================================================
   LINT GATE — pass/fail against the BASELINE, not against zero.

   WHY THIS EXISTS
   ---------------
   `npm run lint` exits NON-ZERO today: this repo carries 12 known errors and 2 warnings,
   almost all `react-hooks/set-state-in-effect` inside the monolith. They are real, they are
   tracked, and they are Phase B work — not something to fix inside a safety-net commit.

   That makes raw `eslint .` useless as a gate: it always fails, so it gets ignored, so a
   NEW error lands unnoticed among the old ones. This script compares the current counts to
   the recorded baseline and fails only if things got WORSE. A regression is caught on the
   first commit that introduces it.

   RATCHET: when the count drops (Phase B will drop it), this script FAILS with instructions
   to lower the baseline. That is deliberate — the baseline must never silently drift upward
   after an improvement, or the slack gets re-consumed by new errors.
================================================================================= */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Run eslint's own JS entrypoint with the current node binary. Two Windows traps avoided:
// `npx` with `shell: true` emits a DEP0190 deprecation on every run (noise in a gate trains
// people to stop reading it), and spawning `node_modules/.bin/eslint.cmd` WITHOUT a shell
// fails EINVAL. Invoking the .js directly sidesteps both and is platform-neutral.
const BIN = path.join('node_modules', 'eslint', 'bin', 'eslint.js');

/**
 * PER-FILE, not just a total. A totals-only gate is trivially defeated: fix one error in the
 * monolith, introduce one somewhere else, and the sum still reads 12 — "OK, exactly at
 * baseline" — while a brand-new problem just landed. The counts below are keyed by basename.
 */
const BASELINE = {
  'App.jsx': { errors: 1, warnings: 1 },
  'VisualTaskCommandCenter.jsx': { errors: 11, warnings: 1 },
};
const BASELINE_TOTAL = { errors: 12, warnings: 2 };

if (!existsSync(BIN)) {
  console.error(`[lint-gate] eslint not found at ${BIN} — run npm install.`);
  process.exit(2);
}

let raw;
try {
  raw = execFileSync(process.execPath, [BIN, '.', '-f', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // eslint exits non-zero whenever there are errors, which is the normal case here — the
  // JSON report still arrives on stdout. Only a genuinely empty stdout is a real failure.
  raw = err.stdout;
  if (!raw) {
    console.error('[lint-gate] eslint produced no report:\n', err.stderr || err.message);
    process.exit(2);
  }
}

const report = JSON.parse(raw);
let errors = 0;
let warnings = 0;
/** @type {Record<string, {errors: number, warnings: number}>} */
const byFile = {};

for (const file of report) {
  if (!file.errorCount && !file.warningCount) continue;
  const name = file.filePath.split(/[\\/]/).pop();
  byFile[name] = { errors: file.errorCount, warnings: file.warningCount };
  errors += file.errorCount;
  warnings += file.warningCount;
}

const fmt = (e, w) => `${e} error${e === 1 ? '' : 's'} / ${w} warning${w === 1 ? '' : 's'}`;
console.log(`[lint-gate] current:  ${fmt(errors, warnings)}`);
console.log(`[lint-gate] baseline: ${fmt(BASELINE_TOTAL.errors, BASELINE_TOTAL.warnings)}`);

/** @type {string[]} */
const worse = [];
/** @type {string[]} */
const better = [];

for (const name of new Set([...Object.keys(BASELINE), ...Object.keys(byFile)])) {
  const want = BASELINE[name] ?? { errors: 0, warnings: 0 };
  const got = byFile[name] ?? { errors: 0, warnings: 0 };
  if (got.errors > want.errors || got.warnings > want.warnings) {
    worse.push(`  ${name}: ${fmt(got.errors, got.warnings)} (baseline ${fmt(want.errors, want.warnings)})`);
  } else if (got.errors < want.errors || got.warnings < want.warnings) {
    better.push(`  ${name}: ${fmt(got.errors, got.warnings)} (baseline ${fmt(want.errors, want.warnings)})`);
  }
}

if (worse.length) {
  console.error('\n[lint-gate] FAIL — lint got worse than the baseline:');
  worse.forEach((l) => console.error(l));
  console.error('\nFix the new problems. Do NOT raise the baseline to make this pass.');
  process.exit(1);
}

if (better.length) {
  console.error('\n[lint-gate] FAIL — lint got BETTER:');
  better.forEach((l) => console.error(l));
  console.error('\nLower the matching entry in BASELINE (scripts/lint-gate.mjs) to lock the');
  console.error('improvement in, otherwise the slack silently absorbs the next new error.');
  process.exit(1);
}

console.log('[lint-gate] OK — exactly at baseline, per file.');
