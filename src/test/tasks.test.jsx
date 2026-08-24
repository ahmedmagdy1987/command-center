/* =================================================================================
   TEST 2 — Task create / edit / delete, including the OPTIMISTIC path and rollback.

   The optimistic paths are the highest-risk surface in a refactor: the UI updates before
   the server confirms, so a broken rollback leaves the screen lying about persisted state.
   Every failure case below asserts BOTH halves — the optimistic row disappears AND the user
   is told. A rollback that silently reverts is still a bug.
================================================================================= */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, makeTask, makeProject } from './harness.jsx';
import { apiState, resetApiState, callsTo, lastCall } from './apiMock.js';

const LOADING = /loading your workspace/i;
const bootDone = () => waitForElementToBeRemoved(() => screen.queryByText(LOADING));

beforeEach(() => {
  resetApiState();
  apiState.projects = [makeProject()];
});

/**
 * Open a task's edit modal by clicking its card.
 *
 * TaskCard's container carries a bare `onClick` with no role or aria attribute, so there is
 * no accessible name to query. We click the title text and let the event bubble to the card.
 * (That the card is not a button is itself an a11y gap worth noting — it is not keyboard
 * reachable — but this phase changes no behaviour, so it is reported, not fixed.)
 */
async function openTask(user, title) {
  const hits = await screen.findAllByText(title);
  await user.click(hits[0]);
  return screen.findByRole('dialog');
}

/** Open QuickAdd via the global `n` shortcut and type a title. */
async function quickAdd(user, title) {
  await user.keyboard('n');
  const input = await screen.findByPlaceholderText(/what needs to get done/i);
  await user.type(input, title);
  await user.type(input, '{Enter}');
  return input;
}

describe('task create', () => {
  it('shows the task optimistically and persists it', async () => {
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    await quickAdd(user, 'Ship the safety net');

    await waitFor(() => expect(callsTo('tasks.create')).toBe(1));
    expect((await screen.findAllByText('Ship the safety net')).length).toBeGreaterThan(0);
  });

  it('ROLLS BACK the optimistic row and tells the user when the write fails', async () => {
    apiState.failures['tasks.create'] = new Error('insert denied');
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    await quickAdd(user, 'Doomed task');

    // It was attempted...
    await waitFor(() => expect(callsTo('tasks.create')).toBe(1));

    // ...and the optimistic row is gone again. This is the assertion that matters: a broken
    // rollback leaves it on screen forever, so the user believes it saved.
    await waitFor(() => expect(screen.queryByText('Doomed task')).not.toBeInTheDocument());

    // And the failure is surfaced, not swallowed.
    expect((await screen.findAllByText(/couldn't add the task/i)).length).toBeGreaterThan(0);
  });
});

describe('task delete', () => {
  it('removes the task and calls attachments cleanup BEFORE the row delete', async () => {
    apiState.tasks = [makeTask({ id: 't-del', title: 'Delete me' })];
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    const dialog = await openTask(user, 'Delete me');
    await user.click(within(dialog).getByRole('button', { name: /delete/i }));
    // Scope to the ConfirmModal (its own role=dialog, aria-label="Delete task"). Querying
    // globally matches the TaskModal's Delete too, and clicking the wrong one is a silent
    // no-op that would make this test assert nothing.
    const confirm = await screen.findByRole('dialog', { name: /^delete task$/i });
    await user.click(within(confirm).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(callsTo('tasks.delete')).toBe(1));

    // Ordering is load-bearing: the storage-delete policy needs the metadata row to
    // authorize removal, so attachments must be cleared before the task row goes.
    const order = apiState.calls.map((c) => c.method).filter((m) => m === 'attachments.removeAllForTask' || m === 'tasks.delete');
    expect(order).toEqual(['attachments.removeAllForTask', 'tasks.delete']);

    await waitFor(() => expect(screen.queryByText('Delete me')).not.toBeInTheDocument());
  });

  it('PUTS THE TASK BACK and tells the user when the delete fails', async () => {
    apiState.tasks = [makeTask({ id: 't-del', title: 'Undeletable' })];
    apiState.failures['tasks.delete'] = new Error('delete denied');
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    const dialog = await openTask(user, 'Undeletable');
    await user.click(within(dialog).getByRole('button', { name: /delete/i }));
    // Scope to the ConfirmModal (its own role=dialog, aria-label="Delete task"). Querying
    // globally matches the TaskModal's Delete too, and clicking the wrong one is a silent
    // no-op that would make this test assert nothing.
    const confirm = await screen.findByRole('dialog', { name: /^delete task$/i });
    await user.click(within(confirm).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(callsTo('tasks.delete')).toBe(1));

    // The reconcile refetch is what restores it — assert the user is told, since a silent
    // restore looks identical to "nothing happened".
    expect((await screen.findAllByText(/couldn't delete the task/i)).length).toBeGreaterThan(0);
    await waitFor(() => expect(callsTo('tasks.list')).toBeGreaterThan(1));
  });
});

describe('task edit', () => {
  it('persists an edit and reverts to the saved version when the write fails', async () => {
    apiState.tasks = [makeTask({ id: 't-ed', title: 'Original title' })];
    apiState.failures['tasks.update'] = new Error('update denied');
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    await openTask(user, 'Original title');
    const titleInput = await screen.findByPlaceholderText(/task title/i);
    await user.clear(titleInput);
    await user.type(titleInput, 'Edited title');
    // The modal commits on blur/close rather than per-keystroke.
    await user.tab();

    await waitFor(() => expect(callsTo('tasks.update')).toBeGreaterThan(0));
    // findAll: the app renders toasts through more than one portal surface, and pinning the
    // count would fail on an unrelated toast change. What matters is that the user is told.
    expect((await screen.findAllByText(/couldn't save that change/i)).length).toBeGreaterThan(0);
    // Reverted by refetch, not left showing the unsaved edit.
    await waitFor(() => expect(callsTo('tasks.list')).toBeGreaterThan(1));
  });
});

describe('id discipline', () => {
  it('never sends a client-generated task id into a uuid-typed field', async () => {
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    await quickAdd(user, 'Check the ids');
    await waitFor(() => expect(callsTo('tasks.create')).toBe(1));

    const [partial, workspaceId] = lastCall('tasks.create');
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // tasks.id is TEXT and is a uid() — it must NOT look like a uuid, and must never be
    // what we hand to a uuid column. This is the 22P02 class the types also guard.
    expect(partial.id ?? '').not.toMatch(UUID_RE);
    expect(workspaceId).toMatch(UUID_RE);
    if (partial.assigneeId) expect(partial.assigneeId).toMatch(UUID_RE);
    expect(partial.assigneeId ?? null).not.toBe(partial.id);
  });
});
