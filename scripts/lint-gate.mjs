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

const BASELINE = { errors: 12, warnings: 2 };

let raw;
try {
  raw = execFileSync('npx', ['eslint', '.', '-f', 'json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
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
console.log(`[lint-gate] baseline: ${fmt(BASELINE.errors, BASELINE.warnings)}`);

if (errors > BASELINE.errors || warnings > BASELINE.warnings) {
  console.error('\n[lint-gate] FAIL — lint got worse than the baseline.');
  console.error('Per file:');
  for (const [name, c] of Object.entries(byFile)) {
    console.error(`  ${name}: ${fmt(c.errors, c.warnings)}`);
  }
  console.error('\nFix the new problems. Do NOT raise the baseline to make this pass.');
  process.exit(1);
}

if (errors < BASELINE.errors || warnings < BASELINE.warnings) {
  console.error(`\n[lint-gate] FAIL — lint got BETTER (${fmt(errors, warnings)}).`);
  console.error('Lower BASELINE in scripts/lint-gate.mjs to lock the improvement in,');
  console.error('otherwise the slack silently absorbs the next new error.');
  process.exit(1);
}

console.log('[lint-gate] OK — exactly at baseline.');
