/* =================================================================================
   TEST 4 — Project delete: the "keep the tasks" reassign path and the role gate.

   `tasks.project` is FREE TEXT with no FK, so "keep the tasks" moving them to an
   unresolvable id silently unfiles them — the data-loss path closed by migration
   20260719172122 (which now raises P0002) plus a real destination picker in the client.
   The client half is what these tests pin: the destination must be a project that EXISTS,
   and it must be what actually reaches the RPC.

   The delete control is owner/admin only, matching the projects_delete_admin policy. The
   client gate is UX (RLS is the real gate), but a refactor that drops it would show every
   member a button that always 42501s.
================================================================================= */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, makeTask, makeProject } from './harness.jsx';
import { apiState, resetApiState, lastCall, callsTo, WS_1 } from './apiMock.js';

const LOADING = /loading your workspace/i;
const bootDone = () => waitForElementToBeRemoved(() => screen.queryByText(LOADING));

beforeEach(() => {
  resetApiState();
  apiState.projects = [
    makeProject({ id: 'p-doomed', name: 'Doomed Project' }),
    makeProject({ id: 'p-keep', name: 'Keeper Project' }),
  ];
  apiState.tasks = [makeTask({ id: 't1', title: 'Filed task', project: 'p-doomed' })];
});

describe('project delete — keep the tasks', () => {
  it('reassigns to a REAL project id, and sends that id to the RPC', async () => {
    apiState.projectTaskCount = 1;              // has tasks => a destination is required
    const user = userEvent.setup();
    renderApp({ route: '/projects' });
    await bootDone();

    // Snapshot the real project ids BEFORE the delete — after it, the deleted project is gone
    // from apiState and any "does it exist" check against the post-state would be trivially
    // satisfiable. This is the set the destination must belong to.
    const idsBefore = apiState.projects.map((p) => p.id);

    await user.click(await screen.findByRole('button', { name: /delete doomed project/i }));

    const dialog = await screen.findByRole('dialog');
    // The destination picker exists precisely so the id cannot be a hardcoded guess.
    const dest = within(dialog).getByLabelText(/destination project for the kept tasks/i);
    await user.selectOptions(dest, 'p-keep');

    await user.click(within(dialog).getByRole('button', { name: /delete|confirm|keep/i }));

    await waitFor(() => expect(callsTo('projects.deleteViaRpc')).toBe(1));
    const [projectId, workspaceId, mode, reassignTo] = lastCall('projects.deleteViaRpc');

    expect(projectId).toBe('p-doomed');
    expect(workspaceId).toBe(WS_1);
    expect(mode).toBe('unassign');
    // The whole point: the destination must be a project that actually exists. 'other' —
    // the old hardcoded seed id — resolves in NO workspace here, and would strand the task.
    expect(reassignTo).toBe('p-keep');
    // And it must be a project that ACTUALLY EXISTED and is not the one being deleted. The
    // earlier version of this line was `...some(p => p.id === reassignTo) || reassignTo === 'p-keep'`,
    // which the preceding assertion already guaranteed — an unfailable check dressed up as
    // the load-bearing one.
    expect(idsBefore).toContain(reassignTo);
    expect(reassignTo).not.toBe(projectId);
  });

  it('blocks confirmation while the task count is still unknown (fails CLOSED)', async () => {
    // A count that never resolves must not enable a destructive confirm.
    apiState.failures['projects.taskCount'] = new Error('count failed');
    const user = userEvent.setup();
    renderApp({ route: '/projects' });
    await bootDone();

    await user.click(await screen.findByRole('button', { name: /delete doomed project/i }));
    const dialog = await screen.findByRole('dialog');

    // Errored count => blocked. Asserting the RPC is never reached is the real check.
    await user.click(within(dialog).getByRole('button', { name: /delete|confirm|keep/i }).closest('button'));
    await new Promise((r) => setTimeout(r, 50));
    expect(callsTo('projects.deleteViaRpc')).toBe(0);
  });
});

describe('project delete — role gate', () => {
  it('offers delete to an owner', async () => {
    apiState.memberships = [{ workspaceId: WS_1, role: 'owner' }];
    renderApp({ route: '/projects' });
    await bootDone();

    expect(await screen.findByRole('button', { name: /delete doomed project/i })).toBeInTheDocument();
  });

  it('does NOT offer delete to a plain member', async () => {
    apiState.memberships = [{ workspaceId: WS_1, role: 'member' }];
    apiState.roster = [{ userId: 'aaaaaaaa-0000-0000-0000-00000000000a', displayName: 'Me', email: 'me@test.dev', role: 'member' }];
    renderApp({ route: '/projects' });
    await bootDone();

    // The project itself is visible...
    expect((await screen.findAllByText('Doomed Project')).length).toBeGreaterThan(0);
    // ...but the destructive control is not offered.
    expect(screen.queryByRole('button', { name: /delete doomed project/i })).not.toBeInTheDocument();
  });
});
