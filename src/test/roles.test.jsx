/* =================================================================================
   TEST 6 — Client-side role gating.

   SCOPE: this is UX, not security. RLS is the real gate and the SQL proof suites cover it.
   What these tests protect is the client contract: the nav a guest gets, the redirect that
   keeps them out of workspace surfaces, and the admin-only controls. A refactor that drops
   a gate would show controls that always fail server-side — a bad experience, not a breach.

   The four-rung ladder is owner > admin > member > guest, read from the CURRENT workspace's
   membership. `membershipsLoaded` gates all of it so the wrong role never flashes.

   NOTE the nav items are <button>, NOT <a>. Querying them as role="link" matches nothing, so
   an absence assertion written that way passes for the wrong reason — it would still pass if
   the gate were deleted. Every query here is role="button" for that reason.
================================================================================= */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitForElementToBeRemoved } from '@testing-library/react';
import { renderApp, makeTask, makeProject } from './harness.jsx';
import { apiState, resetApiState, ME, WS_1 } from './apiMock.js';

const LOADING = /loading your workspace/i;
const bootDone = () => waitForElementToBeRemoved(() => screen.queryByText(LOADING));

/** Seed the caller's role in the current workspace. */
function asRole(role) {
  apiState.memberships = [{ workspaceId: WS_1, role }];
  apiState.roster = [{ userId: ME, displayName: 'Me', email: 'me@test.dev', role }];
}

beforeEach(() => {
  resetApiState();
  apiState.projects = [makeProject({ id: 'p-1', name: 'Visible Project' })];
  apiState.tasks = [makeTask({ id: 't-1', title: 'A task', project: 'p-1' })];
});

describe('guest', () => {
  it('is bounced off workspace surfaces to My Tasks', async () => {
    asRole('guest');
    renderApp({ route: '/projects' });
    await bootDone();

    // GUEST_VIEWS is {mine, dms}; /projects is not one, so the guest is redirected and the
    // Projects surface never renders.
    expect(screen.queryByText('Visible Project')).not.toBeInTheDocument();
  });

  it('gets the reduced nav — no Projects, no Members', async () => {
    asRole('guest');
    renderApp({ route: '/my-tasks' });
    await bootDone();

    expect(screen.queryByRole('button', { name: /^projects$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^members$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^chat$/i })).not.toBeInTheDocument();
  });
});

describe('member', () => {
  it('sees workspace surfaces but not member management', async () => {
    asRole('member');
    renderApp();
    await bootDone();

    // A member is a full workspace participant...
    expect((await screen.findAllByText('A task')).length).toBeGreaterThan(0);
    // ...but managing members is owner/admin only (canManageMembers).
    expect(screen.queryByRole('button', { name: /^members$/i })).not.toBeInTheDocument();
  });
});

describe('owner and admin', () => {
  it('an owner gets member management', async () => {
    asRole('owner');
    renderApp();
    await bootDone();

    expect(await screen.findByRole('button', { name: /^members$/i })).toBeInTheDocument();
  });

  it('an admin also gets member management (rank >= 2, matching the RLS gate)', async () => {
    asRole('admin');
    renderApp();
    await bootDone();

    expect(await screen.findByRole('button', { name: /^members$/i })).toBeInTheDocument();
  });
});
