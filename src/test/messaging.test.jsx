/* =================================================================================
   TEST 5 — Team chat: send, and the per-user hide ("delete for me").

   "Delete for me" is a PERSONAL hide, not a delete: the row stays, only the hiding user
   stops seeing it. The distinction is the whole feature, so the test asserts the hide is
   scoped to one message and routed through `messages.hide` — never through `softDelete`,
   which is the delete-for-EVERYONE path and would destroy the peer's copy.
================================================================================= */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, makeProject } from './harness.jsx';
import { apiState, resetApiState, callsTo, lastCall, ME, PEER, WS_1 } from './apiMock.js';

const LOADING = /loading your workspace/i;
const bootDone = () => waitForElementToBeRemoved(() => screen.queryByText(LOADING));

function msg(over = {}) {
  return {
    id: 'm1', workspaceId: WS_1, senderId: ME, body: 'Hello team',
    audioPath: null, audioDuration: null, mentions: [],
    createdAt: '2026-03-01T12:00:00.000Z', updatedAt: null, editedAt: null, deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  resetApiState();
  apiState.projects = [makeProject()];
  apiState.roster = [
    { userId: ME, displayName: 'Me', email: 'me@test.dev', role: 'owner' },
    { userId: PEER, displayName: 'Peer', email: 'peer@test.dev', role: 'member' },
  ];
  apiState.members = [
    { id: ME, email: 'me@test.dev', display_name: 'Me' },
    { id: PEER, email: 'peer@test.dev', display_name: 'Peer' },
  ];
});

describe('team chat send', () => {
  it('sends a message scoped to the current workspace', async () => {
    const user = userEvent.setup();
    renderApp({ route: '/chat' });
    await bootDone();

    const composer = await screen.findByPlaceholderText(/message the workspace/i);
    await user.type(composer, 'Hello team{Enter}');

    await waitFor(() => expect(callsTo('messages.sendText')).toBe(1));
    const [body, workspaceId] = lastCall('messages.sendText');
    expect(body).toContain('Hello team');
    // A falsy workspaceId here would previously have mixed every visible workspace into one
    // channel; api.js now throws on it. Pin the scoping at the call site.
    expect(workspaceId).toBe(WS_1);
  });
});

describe('"delete for me" (per-user hide)', () => {
  it('hides only that message, via hide() and NOT via softDelete()', async () => {
    apiState.messages = [
      msg({ id: 'm1', body: 'Hide this one' }),
      msg({ id: 'm2', body: 'Keep this one' }),
    ];

    const user = userEvent.setup();
    renderApp({ route: '/chat' });
    await bootDone();

    expect((await screen.findAllByText('Hide this one')).length).toBeGreaterThan(0);

    // Open the actions menu on the first message.
    const menus = await screen.findAllByLabelText(/message actions/i);
    await user.click(menus[0]);
    await user.click(await screen.findByRole('menuitem', { name: /delete for me/i }));

    await waitFor(() => expect(callsTo('messages.hide')).toBe(1));
    expect(lastCall('messages.hide')[0]).toBe('m1');

    // The critical distinction: a personal hide must NEVER become a delete-for-everyone.
    expect(callsTo('messages.softDelete')).toBe(0);

    // Gone for me; the sibling is untouched.
    await waitFor(() => expect(screen.queryByText('Hide this one')).not.toBeInTheDocument());
    expect((await screen.findAllByText('Keep this one')).length).toBeGreaterThan(0);
  });

  it('restores the message when the hide write fails', async () => {
    apiState.messages = [msg({ id: 'm1', body: 'Sticky message' })];
    apiState.failures['messages.hide'] = new Error('hide denied');

    const user = userEvent.setup();
    renderApp({ route: '/chat' });
    await bootDone();

    const menus = await screen.findAllByLabelText(/message actions/i);
    await user.click(menus[0]);
    await user.click(await screen.findByRole('menuitem', { name: /delete for me/i }));

    await waitFor(() => expect(callsTo('messages.hide')).toBe(1));
    // A refetch being ISSUED is not the property under test — the message coming BACK is.
    // Asserting only the call count would stay green if the refetch returned and the UI
    // never re-rendered it.
    await waitFor(() => expect(callsTo('messages.list')).toBeGreaterThan(1));
    expect((await screen.findAllByText('Sticky message')).length).toBeGreaterThan(0);
  });
});
