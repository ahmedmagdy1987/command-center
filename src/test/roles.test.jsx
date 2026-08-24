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

    // POSITIVE CONTROL FIRST. Every assertion below is an ABSENCE, and an absence is equally
    // satisfied by "the gate worked" and by "the whole shell failed to render". Prove the app
    // is up and landed on the guest destination before concluding anything from what is missing.
    expect((await screen.findAllByRole('button', { name: /my tasks/i })).length).toBeGreaterThan(0);
    // GUEST_VIEWS is {mine, dms}; /projects is not one, so the guest is redirected. This is the
    // redirect itself, not a proxy for it.
    expect(window.location.pathname).toBe('/my-tasks');

    // The Projects SURFACE is absent — asserted via an affordance only that view renders.
    // NOTE: do NOT assert on the project NAME here. A task's project chip legitimately renders
    // "Visible Project" on My Tasks, so that assertion only passed while the task list had not
    // loaded yet — a race, not a gate. Adding the control above is what exposed it.
    expect(screen.queryByRole('button', { name: /new project/i })).not.toBeInTheDocument();
  });

  it('gets the reduced nav — no Projects, no Members, no Chat', async () => {
    asRole('guest');
    renderApp({ route: '/my-tasks' });
    await bootDone();

    // POSITIVE CONTROL: the nav rendered, and rendered the two destinations a guest DOES get.
    // Without this, a Sidebar that crashed behind its ErrorBoundary would pass all three
    // absence assertions below and report a working role gate.
    // findAll/getAll, not find/get: the nav renders in BOTH the sidebar and the mobile tab bar,
    // and the sidebar item carries an unread badge in its accessible name ("My Tasks1"), so an
    // anchored single-match query is wrong on both counts.
    expect((await screen.findAllByRole('button', { name: /my tasks/i })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /direct messages/i }).length).toBeGreaterThan(0);

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

    // A member is a full workspace participant — this doubles as the positive control that
    // the shell and nav are up before the absence assertion below.
    expect((await screen.findAllByText('A task')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^projects$/i }).length).toBeGreaterThan(0);
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
