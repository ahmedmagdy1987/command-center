/* =================================================================================
   CENTRAL ERROR REPORTING
   The one funnel for caught-but-tolerated failures, so "resilient" never means
   "invisible". Today it logs to the console; setErrorSink() is the seam for a real
   tracker (e.g. Sentry.captureException) later — wire it once here, no call-site
   changes. Deliberately-silent catches (localStorage/clipboard environment quirks)
   stay silent and do NOT route through here.
================================================================================= */

let sink = null;

/** Point caught errors at an external tracker: setErrorSink((error, { context }) => …). */
export function setErrorSink(fn) { sink = fn; }

/** Report a caught error. `context` says where/what failed, e.g. 'tasks.reconcile'. */
export function reportError(error, context) {
  try {
    console.error(`[cc:${context || 'unhandled'}]`, error);
    if (sink) sink(error, { context });
  } catch { /* the reporter itself must never throw */ }
}

/**
 * Catch handler that reports before (optionally) falling back:
 *   .catch(logCaught('tasks.stats'))                    — swallow, but visibly
 *   .catch(logCaught('attachments.list', () => []))     — report, then run the fallback
 * The fallback's return value is returned, so `.catch(logCaught(ctx, () => null))`
 * still resolves to null like the bare `.catch(() => null)` it replaces.
 */
export const logCaught = (context, handler) => (error) => {
  reportError(error, context);
  return handler ? handler(error) : undefined;
};

/** Global backstop for errors nothing caught — uncaught render/runtime errors and
 *  unhandled promise rejections (which otherwise surface only in devtools). Idempotent. */
let globalInstalled = false;
export function installGlobalErrorLogging() {
  if (globalInstalled || typeof window === 'undefined') return;
  globalInstalled = true;
  window.addEventListener('error', (e) => reportError(e.error ?? e.message, 'window.onerror'));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'unhandledrejection'));
}
