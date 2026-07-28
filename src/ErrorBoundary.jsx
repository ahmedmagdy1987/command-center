import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { reportError } from './lib/errors';

/**
 * Render-error boundary (class component — React still has no hook for this).
 * A throw during render below this no longer white-screens the whole app: the
 * app-level boundary shows a full-screen fallback, and a per-view boundary keeps
 * the shell (sidebar/top bar) alive so the user can navigate away. Navigating
 * unmounts a view boundary, so a fresh visit always retries; "Try again" retries
 * in place.
 *
 * Note: this only catches RENDER throws. Async/event-handler failures don't reach
 * boundaries by design — those route through reportError/logCaught (lib/errors.js).
 */
export default class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    reportError(error, `render:${this.props.name || 'app'}`);
    if (info?.componentStack) console.error(info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const card = (
      <div className="max-w-md w-full rounded-2xl border border-line bg-surface-raised p-6 text-center">
        <div className="mx-auto w-10 h-10 rounded-xl bg-danger/15 border border-danger-hover/30 flex items-center justify-center">
          <AlertCircle className="w-5 h-5 text-danger-text" />
        </div>
        <div className="mt-3 text-sm font-semibold text-primary">Something went wrong here</div>
        <p className="mt-1.5 text-xs text-muted leading-relaxed">
          This part of the app hit an unexpected error. Your data is safe — it lives on the server, not in this tab.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button onClick={() => this.setState({ error: null })}
            className="h-9 px-4 rounded-xl border border-line bg-fill text-xs font-medium text-secondary hover:bg-fill-strong transition-colors">
            Try again
          </button>
          <button onClick={() => window.location.reload()}
            className="h-9 px-4 rounded-xl bg-brand hover:bg-brand-hover text-white text-xs font-semibold transition-colors inline-flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />Reload app
          </button>
        </div>
      </div>
    );

    // fullScreen: the app-level boundary — nothing else is on screen, so provide the backdrop.
    // Inline (per-view): the shell around it is still alive; just fill the content area.
    return this.props.fullScreen ? (
      <div data-surface="dark" className="min-h-screen bg-canvas text-white flex items-center justify-center p-6">{card}</div>
    ) : (
      <div className="flex items-center justify-center py-16 px-4">{card}</div>
    );
  }
}
