/* =================================================================================
   TEST 1 — App boots and renders the shell.

   This is the white-screen catcher. A refactor that breaks an import, a context, a hook
   order, or the workspace-resolution effect shows up here first and loudest. It is also the
   canary for the whole harness: if this file fails, none of the others mean anything.
================================================================================= */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitForElementToBeRemoved } from '@testing-library/react';
import { renderApp, makeTask, makeProject } from './harness.jsx';
import { apiState, resetApiState, callsTo, WS_1 } from './apiMock.js';

const LOADING = /loading your workspace/i;

beforeEach(() => {
  resetApiState();
  apiState.projects = [makeProject()];
  apiState.tasks = [makeTask({ title: 'Write the safety net' })];
});

describe('app boot', () => {
  it('renders the shell without crashing, past both loading gates', async () => {
    renderApp();

    // Gate: AppShell shows a spinner until `loading` clears AND memberships have loaded.
    await waitForElementToBeRemoved(() => screen.queryByText(LOADING));

    // The shell is up: a task from the seeded workspace is on screen. findAll, not find —
    // the dashboard legitimately surfaces the same task in more than one panel, and pinning
    // that count here would make an unrelated layout change fail this test.
    const hits = await screen.findAllByText('Write the safety net');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('resolves the workspace before issuing any workspace-scoped read', async () => {
    renderApp();
    await waitForElementToBeRemoved(() => screen.queryByText(LOADING));

    // Both resolution reads happen...
    expect(callsTo('workspaces.listMine')).toBeGreaterThan(0);
    expect(callsTo('workspaceMembers.listMine')).toBeGreaterThan(0);

    // ...and every scoped read that follows carries the resolved workspace id. A read with a
    // null/undefined workspace is the shape that used to mix tenants into one view.
    const scoped = apiState.calls.filter((c) => c.method === 'tasks.list' || c.method === 'projects.list');
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) {
      expect(call.args[0]).toBe(WS_1);
    }
  });

  it('shows onboarding, not the shell, when the user has no workspace', async () => {
    apiState.workspaces = [];
    apiState.memberships = [];

    renderApp();

    // No workspace => onboarding, no workspace-scoped reads at all, and no task.
    expect(await screen.findByRole('button', { name: /create workspace/i })).toBeInTheDocument();
    expect(screen.queryByText('Write the safety net')).not.toBeInTheDocument();
    expect(callsTo('tasks.list')).toBe(0);
  });

  it('unsubscribes every realtime channel on unmount (no listener leak)', async () => {
    const { unmount } = renderApp();
    await waitForElementToBeRemoved(() => screen.queryByText(LOADING));

    expect(apiState.subscribers['tasks.subscribe']?.length ?? 0).toBeGreaterThan(0);

    unmount();

    // Every subscribe() cleanup must have run. A leaked subscriber keeps firing setState on
    // an unmounted tree — the class of bug that only shows up as noise in someone else's test.
    for (const [name, list] of Object.entries(apiState.subscribers)) {
      expect(`${name}:${list.length}`).toBe(`${name}:0`);
    }
  });
});
