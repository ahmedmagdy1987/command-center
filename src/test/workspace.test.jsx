/* =================================================================================
   TEST 3 — Workspace switching, and what MUST reset when it happens.

   This is a regression test for a bug that actually shipped: notifications from the previous
   workspace survived a switch and inflated the new workspace's unread badge. The fix lives
   in NotificationBell — the previous workspace's items are cleared on switch, AND the merge
   that follows filters carryover with `x.workspaceId === currentWorkspaceId`.

   Tenant bleed is the worst class of bug this app can have, so the assertions here are
   deliberately about DATA SCOPE, not cosmetics: after a switch, nothing from the old
   workspace may remain on screen and every scoped read must carry the new id.
================================================================================= */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, makeTask, makeProject } from './harness.jsx';
import { apiState, resetApiState, WS_1, WS_2 } from './apiMock.js';

const LOADING = /loading your workspace/i;
const bootDone = () => waitForElementToBeRemoved(() => screen.queryByText(LOADING));

beforeEach(() => {
  resetApiState();
  apiState.workspaces = [
    { id: WS_1, name: 'Alpha Workspace', slug: 'alpha', created_at: '2026-01-01T00:00:00Z' },
    { id: WS_2, name: 'Beta Workspace', slug: 'beta', created_at: '2026-01-02T00:00:00Z' },
  ];
  apiState.memberships = [
    { workspaceId: WS_1, role: 'owner' },
    { workspaceId: WS_2, role: 'owner' },
  ];
  apiState.projects = [makeProject()];
  apiState.tasks = [makeTask({ id: 'a1', title: 'Alpha only task', workspaceId: WS_1 })];
});

/** Open the workspace switcher and pick a workspace by visible name. */
async function switchTo(user, name) {
  await user.click(screen.getByTitle(/switch or create workspace/i));
  await user.click(await screen.findByRole('button', { name: new RegExp(name, 'i') }));
}

describe('workspace switching', () => {
  it('re-scopes every workspace read to the newly selected workspace', async () => {
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    const before = apiState.calls.length;
    await switchTo(user, 'Beta Workspace');

    await waitFor(() => {
      const after = apiState.calls.slice(before);
      const scoped = after.filter((c) => c.method === 'tasks.list' || c.method === 'projects.list');
      expect(scoped.length).toBeGreaterThan(0);
      // Every post-switch scoped read carries WS_2. A single WS_1 read here means the old
      // workspace's rows land in the new workspace's view.
      for (const call of scoped) expect(call.args[0]).toBe(WS_2);
    });
  });

  it('drops the previous workspace data from the screen', async () => {
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    expect((await screen.findAllByText('Alpha only task')).length).toBeGreaterThan(0);

    // The new workspace has no tasks.
    apiState.tasks = [];
    await switchTo(user, 'Beta Workspace');

    await waitFor(() => expect(screen.queryByText('Alpha only task')).not.toBeInTheDocument());
  });

  it('does NOT carry notifications across the switch (the shipped tenant-bleed bug)', async () => {
    apiState.notifications = [
      // NOTE the bell row renders `message`, NOT `title` — so the distinctive string has to
      // live in `message` or this test would assert on text the UI never draws.
      { id: 'n-alpha', workspaceId: WS_1, recipientId: 'me', type: 'task_assigned',
        title: 'Assigned', message: 'Alpha notification', read: false,
        createdAt: '2026-03-01T09:00:00.000Z', taskId: null, actorId: null, refId: null },
    ];

    const user = userEvent.setup();
    renderApp();
    await bootDone();

    // Visible in Alpha.
    await user.click(await screen.findByRole('button', { name: /notifications/i }));
    expect((await screen.findAllByText(/alpha notification/i)).length).toBeGreaterThan(0);

    // The Alpha notification DELIBERATELY STAYS in the fixture. Clearing it would make this
    // test pass no matter what the app does — there would be nothing left to leak. It stays,
    // and the mock's workspace filter is what must keep it out of Beta.
    //
    // Switching CLOSES the panel (the bell remounts, resetting its `open` state), so exactly
    // one click re-opens it. An earlier version got that count wrong and toggled it SHUT,
    // making the absence assertion pass against a panel that was not on screen at all.
    await switchTo(user, 'Beta Workspace');
    await user.click(await screen.findByRole('button', { name: /notifications/i }));

    // POSITIVE CONTROL: prove the panel is open and rendering its (now empty) list before
    // asserting something is missing from it. Without this, "not in the document" is
    // satisfied by a closed panel exactly as well as by a correctly-scoped one — which is
    // precisely how the earlier version passed while testing nothing.
    expect(await screen.findByText(/caught up/i)).toBeInTheDocument();

    // The Alpha notification must be GONE — it still exists, it simply belongs to another
    // workspace. Dropping the workspace argument from the notifications read makes it
    // reappear here, which is the tenant-bleed shape this test exists to catch.
    await waitFor(() => expect(screen.queryByText(/alpha notification/i)).not.toBeInTheDocument());
  });
});
