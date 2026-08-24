/* =================================================================================
   API MOCK — the seam the whole test suite hangs off.

   We mock at `src/lib/api.js`, NOT at the network or the Supabase client. That boundary is
   chosen deliberately:
     - It is the app's real data seam. Every DB read/write in the monolith goes through one
       of these 14 objects (VisualTaskCommandCenter.jsx imports them on a single line), so
       mocking here exercises ALL of the app's own logic — optimistic updates, rollback,
       workspace scoping, role gating — while cutting the network.
     - It survives Phase B. Extraction moves components around; it does not change this
       boundary. Tests pinned here should not need rewriting as the monolith is split, which
       is the entire point of a safety net.
     - api.js has NO module-level mutable state, so there is no cross-test bleed from it.

   FIDELITY NOTE — the two return shapes are NOT the same, and getting this wrong would make
   tests pass against data the app never sees:
     - `tasks.list()`     returns APP shape (it maps through fromDbTask internally).
     - `projects.list()`  returns RAW DB ROWS (snake_case, unmapped).
   The builders below mirror that exactly.
================================================================================= */
import { vi } from 'vitest';

export const WS_1 = '11111111-1111-1111-1111-111111111111';
export const WS_2 = '22222222-2222-2222-2222-222222222222';
export const ME = 'aaaaaaaa-0000-0000-0000-00000000000a';
export const PEER = 'bbbbbbbb-0000-0000-0000-00000000000b';
export const DM_CONV_ID = 'cccccccc-0000-0000-0000-00000000000c';

/**
 * Mutable state the mock reads at CALL time (not at mock-construction time), so a test can
 * arrange data after the module graph is already wired.
 */
export const apiState = {
  /** @type {any[]} */ tasks: [],
  /** @type {any[]} */ projects: [],
  /** @type {any[]} */ workspaces: [],
  /** @type {any[]} */ memberships: [],
  /** @type {any[]} */ roster: [],
  /** @type {any[]} */ members: [],
  /** @type {any[]} */ notifications: [],
  /** @type {any[]} */ messages: [],
  /** @type {any[]} */ dmConversations: [],
  /** @type {any}   */ stats: null,
  projectTaskCount: 0,
  chatUnread: 0,
  hiddenCount: 0,
  /**
   * Force a method to reject. Key is "namespace.method", value is the Error to throw.
   * This is how the rollback tests drive a failed write.
   * @type {Record<string, Error>}
   */
  failures: /** @type {Record<string, Error>} */ ({}),
  /** Every call made, in order: { method, args }. @type {{method: string, args: any[]}[]} */
  calls: [],
  /** Live realtime callbacks, so a test can push an event. @type {Record<string, Function[]>} */
  subscribers: /** @type {Record<string, Function[]>} */ ({}),
};

export function resetApiState() {
  apiState.tasks = [];
  apiState.projects = [];
  apiState.workspaces = [{ id: WS_1, name: 'Command Center', slug: 'command-center', created_at: '2026-01-01T00:00:00Z' }];
  apiState.memberships = [{ workspaceId: WS_1, role: 'owner' }];
  apiState.roster = [{ userId: ME, displayName: 'Me', email: 'me@test.dev', role: 'owner' }];
  apiState.members = [{ id: ME, email: 'me@test.dev', display_name: 'Me' }];
  apiState.notifications = [];
  apiState.messages = [];
  apiState.dmConversations = [];
  apiState.stats = null;
  apiState.projectTaskCount = 0;
  apiState.chatUnread = 0;
  apiState.hiddenCount = 0;
  apiState.failures = {};
  apiState.calls = [];
  apiState.subscribers = {};
}
resetApiState();

/** Record a call and honour any configured failure for it. */
function track(method, args) {
  apiState.calls.push({ method, args });
  const failure = apiState.failures[method];
  if (failure) throw failure;
}

/** Build an async mock that records, may fail, then resolves to `produce()`. */
function fn(method, produce) {
  return vi.fn(async (...args) => {
    track(method, args);
    return typeof produce === 'function' ? produce(...args) : produce;
  });
}

/** Build a subscribe-style mock: registers the callback and returns an unsubscribe fn. */
function sub(name) {
  return vi.fn((...args) => {
    apiState.calls.push({ method: name, args });
    const cb = args.find((a) => typeof a === 'function');
    if (cb) (apiState.subscribers[name] ||= []).push(cb);
    // EVERY cleanup in the app calls this unconditionally — returning undefined here would
    // surface as "unsub is not a function" on unmount, in an effect cleanup, where it is
    // maximally confusing. Always return a function.
    return () => {
      const list = apiState.subscribers[name];
      if (list && cb) list.splice(list.indexOf(cb), 1);
    };
  });
}

/** Push a realtime event to every live subscriber of `name`. */
export function emit(name, payload) {
  (apiState.subscribers[name] || []).forEach((cb) => cb(payload));
}

/** How many times a method was called. */
export function callsTo(method) {
  return apiState.calls.filter((c) => c.method === method).length;
}

/** The arguments of the most recent call to `method`, or undefined. */
export function lastCall(method) {
  const hits = apiState.calls.filter((c) => c.method === method);
  return hits.length ? hits[hits.length - 1].args : undefined;
}

const SESSION = { user: { id: ME, email: 'me@test.dev' }, access_token: 'test-token' };

export function buildApiMock() {
  return {
    auth: {
      getSession: fn('auth.getSession', () => SESSION),
      signIn: fn('auth.signIn', () => ({ session: SESSION })),
      signUp: fn('auth.signUp', () => ({ session: SESSION })),
      signOut: fn('auth.signOut'),
      resetPassword: fn('auth.resetPassword'),
      updatePassword: fn('auth.updatePassword'),
      onAuthChange: sub('auth.onAuthChange'),
    },

    members: {
      list: fn('members.list', () => apiState.members),
      getCurrent: fn('members.getCurrent', () => apiState.members[0] ?? null),
      updateProfile: fn('members.updateProfile', (patch) => ({ ...apiState.members[0], ...patch })),
      uploadAvatar: fn('members.uploadAvatar', () => `${ME}/avatar.png`),
      removeAvatar: fn('members.removeAvatar'),
      signedAvatarUrls: fn('members.signedAvatarUrls', () => ({})),
    },

    workspaces: {
      listMine: fn('workspaces.listMine', () => apiState.workspaces),
      create: fn('workspaces.create', (name) => {
        const row = { id: WS_2, name, slug: 'new-ws', created_at: '2026-02-02T00:00:00Z' };
        apiState.workspaces = [...apiState.workspaces, row];
        apiState.memberships = [...apiState.memberships, { workspaceId: WS_2, role: 'owner' }];
        return row;
      }),
    },

    workspaceMembers: {
      listMine: fn('workspaceMembers.listMine', () => apiState.memberships),
      listForWorkspace: fn('workspaceMembers.listForWorkspace', () => apiState.roster),
      setRole: fn('workspaceMembers.setRole'),
      remove: fn('workspaceMembers.remove'),
    },

    invitations: {
      listForWorkspace: fn('invitations.listForWorkspace', () => []),
      listMine: fn('invitations.listMine', () => []),
      create: fn('invitations.create', () => ({ id: 'inv-1', token: 'tok' })),
      accept: fn('invitations.accept', () => ({ workspace_id: WS_1 })),
      preview: fn('invitations.preview', () => null),
      revoke: fn('invitations.revoke'),
    },

    projects: {
      // RAW DB ROWS — snake_case, deliberately unmapped. See the FIDELITY NOTE above.
      // Workspace-SCOPED like the real query (`.eq('workspace_id', …)`). Modelling this is
      // what lets a test detect an UNSCOPED read; a mock that ignores the argument returns
      // the same rows either way and can never catch tenant bleed.
      list: fn('projects.list', (workspaceId) =>
        apiState.projects.filter((p) => !workspaceId || !p.workspace_id || p.workspace_id === workspaceId)),
      create: fn('projects.create', ({ name, color, icon }, workspaceId) => {
        const row = { id: `proj-${apiState.projects.length + 1}`, name, color, icon, workspace_id: workspaceId };
        apiState.projects = [...apiState.projects, row];
        return row;
      }),
      update: fn('projects.update', (id, patch) => {
        apiState.projects = apiState.projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
        return apiState.projects.find((p) => p.id === id);
      }),
      deleteViaRpc: fn('projects.deleteViaRpc', (projectId, _ws, mode, reassignTo) => {
        // Mirror the server: 'unassign' re-files this project's tasks onto reassignTo,
        // 'cascade' deletes them. Then the project row goes.
        if (mode === 'cascade') {
          apiState.tasks = apiState.tasks.filter((t) => t.project !== projectId);
        } else {
          apiState.tasks = apiState.tasks.map((t) => (t.project === projectId ? { ...t, project: reassignTo } : t));
        }
        apiState.projects = apiState.projects.filter((p) => p.id !== projectId);
        return { mode, tasks_affected: 0, project_deleted: true };
      }),
      taskCount: fn('projects.taskCount', () => apiState.projectTaskCount),
    },

    tasks: {
      // APP SHAPE — already mapped through fromDbTask by the real implementation.
      list: fn('tasks.list', (workspaceId) =>
        apiState.tasks.filter((t) => !workspaceId || !t.workspaceId || t.workspaceId === workspaceId)),
      stats: fn('tasks.stats', () => apiState.stats),
      getById: fn('tasks.getById', (id) => apiState.tasks.find((t) => t.id === id) ?? null),
      getSubtasks: fn('tasks.getSubtasks', (id) => apiState.tasks.find((t) => t.id === id)?.subtasks ?? []),
      create: fn('tasks.create', (partial, workspaceId) => {
        const row = { ...partial, id: partial.id ?? `srv-${apiState.tasks.length + 1}`, workspaceId };
        apiState.tasks = [row, ...apiState.tasks];
        return row;
      }),
      update: fn('tasks.update', (id, patch) => {
        apiState.tasks = apiState.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
        return apiState.tasks.find((t) => t.id === id);
      }),
      delete: fn('tasks.delete', (id) => {
        apiState.tasks = apiState.tasks.filter((t) => t.id !== id);
      }),
      bulkInsert: fn('tasks.bulkInsert', () => []),
      subscribe: sub('tasks.subscribe'),
    },

    notifications: {
      // Workspace-SCOPED, like the real endpoint: `notifications.list(limit, workspaceId)`
      // filters server-side by workspace. Modelling that faithfully is what lets a test
      // detect an unscoped read — a mock that ignores the argument returns the same rows
      // either way and can never catch tenant bleed.
      unreadCount: fn('notifications.unreadCount', (workspaceId) =>
        apiState.notifications.filter((n) => !n.read && (!workspaceId || n.workspaceId === workspaceId)).length),
      list: fn('notifications.list', (_limit, workspaceId) =>
        apiState.notifications.filter((n) => !workspaceId || n.workspaceId === workspaceId)),
      markRead: fn('notifications.markRead'),
      markAllRead: fn('notifications.markAllRead'),
      delete: fn('notifications.delete'),
      clearIds: fn('notifications.clearIds'),
      subscribe: sub('notifications.subscribe'),
    },

    comments: {
      list: fn('comments.list', () => []),
      add: fn('comments.add', (taskId, body) => ({ id: 'c1', taskId, body })),
      update: fn('comments.update'),
      remove: fn('comments.remove'),
      subscribe: sub('comments.subscribe'),
    },

    messages: {
      search: fn('messages.search', () => []),
      // The REAL messages.list / listBefore THROW on a falsy workspaceId (api.js:683, 697):
      // the old table read silently omitted the filter and mixed every visible workspace into
      // one channel. Mirror the throw, or a refactor that drops the argument passes the tests
      // and mixes tenants in production.
      list: fn('messages.list', (_limit, workspaceId) => {
        if (!workspaceId) throw new Error('messages.list requires a workspaceId');
        return apiState.messages.filter((m) => !m.workspaceId || m.workspaceId === workspaceId);
      }),
      listBefore: fn('messages.listBefore', (_before, _limit, workspaceId) => {
        if (!workspaceId) throw new Error('messages.listBefore requires a workspaceId');
        return [];
      }),
      unreadCount: fn('messages.unreadCount', () => apiState.chatUnread),
      hide: fn('messages.hide', (id) => {
        apiState.messages = apiState.messages.filter((m) => m.id !== id);
        apiState.hiddenCount += 1;
      }),
      unhide: fn('messages.unhide'),
      hiddenCount: fn('messages.hiddenCount', () => apiState.hiddenCount),
      unhideAll: fn('messages.unhideAll'),
      sendText: fn('messages.sendText', (body, workspaceId) => {
        const row = { id: `m-${apiState.messages.length + 1}`, workspaceId, senderId: ME, body,
          createdAt: new Date('2026-03-01T12:00:00Z').toISOString(), editedAt: null, deletedAt: null, mentions: [] };
        apiState.messages = [...apiState.messages, row];
        return row;
      }),
      sendVoice: fn('messages.sendVoice', () => ({ id: 'mv-1', audioPath: 'p.webm' })),
      update: fn('messages.update'),
      softDelete: fn('messages.softDelete', (m) => ({ ...m, body: null, deletedAt: new Date().toISOString() })),
      signedUrl: fn('messages.signedUrl', () => 'https://signed.test/a.webm'),
      subscribe: sub('messages.subscribe'),
      // Presence returns a HANDLE, not an unsubscribe function. Shape matters: the app calls
      // .update(partial) and .unsubscribe().
      presence: vi.fn(() => {
        apiState.calls.push({ method: 'messages.presence', args: [] });
        return { update() {}, unsubscribe() {} };
      }),
    },

    chatReads: {
      reads: fn('chatReads.reads', () => []),
      markRead: fn('chatReads.markRead'),
    },

    directMessages: {
      // Returns a SCALAR uuid string, not an object — api.js:1021 ends
      // `return Array.isArray(data) ? data[0] : data;   // scalar uuid`, and the app binds it
      // straight to `const convId = await ...`. An object here would make a future DM test
      // pass against a shape the app can never receive.
      getOrCreateConversation: fn('directMessages.getOrCreateConversation', () => DM_CONV_ID),
      listConversations: fn('directMessages.listConversations', () => apiState.dmConversations),
      listMessages: fn('directMessages.listMessages', () => []),
      listMessagesBefore: fn('directMessages.listMessagesBefore', () => []),
      listRecentMessages: fn('directMessages.listRecentMessages', () => []),
      hide: fn('directMessages.hide'),
      unhide: fn('directMessages.unhide'),
      hiddenCount: fn('directMessages.hiddenCount', () => 0),
      unhideAll: fn('directMessages.unhideAll'),
      // ARRAY of { conversationId, unread } — verified against api.js:1130. Returning an
      // object here made the app throw "unreadRows.map is not a function" inside a caught
      // handler, i.e. it degraded silently rather than failing the test. Mock fidelity is
      // load-bearing: a wrong shape tests the app against data it can never receive.
      unreadCounts: fn('directMessages.unreadCounts', () => []),
      reads: fn('directMessages.reads', () => []),
      markRead: fn('directMessages.markRead'),
      sendText: fn('directMessages.sendText', (conversationId, body) => ({ id: 'dmm-1', conversationId, body })),
      sendVoice: fn('directMessages.sendVoice', () => ({ id: 'dmv-1' })),
      update: fn('directMessages.update'),
      softDelete: fn('directMessages.softDelete'),
      subscribe: sub('directMessages.subscribe'),
      subscribeThread: sub('directMessages.subscribeThread'),
    },

    attachments: {
      list: fn('attachments.list', () => []),
      upload: fn('attachments.upload', () => ({ id: 'att-1' })),
      signedUrl: fn('attachments.signedUrl', () => 'https://signed.test/f.pdf'),
      remove: fn('attachments.remove'),
      // deleteTask awaits this FIRST and only then calls tasks.delete in .finally().
      // If this never settles, the delete silently never happens.
      removeAllForTask: fn('attachments.removeAllForTask'),
    },
  };
}
