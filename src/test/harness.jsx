/* =================================================================================
   RENDER HARNESS.

   WHY WE RENDER THE WHOLE APP RATHER THAN ITS PARTS
   ------------------------------------------------
   `VisualTaskCommandCenter.jsx` has exactly ONE export — the default. `AppProvider`,
   `AppShell`, `useApp`, `defaultProjectId` and every component are module-private, so there
   is no seam to mount in isolation without editing the monolith.

   That constraint turns out to be the RIGHT shape for a refactor safety net anyway. These
   tests drive the app the way a user does — through rendered UI — and assert on rendered
   outcomes and on the api.js calls that result. Nothing here reaches into component
   internals, so Phase B can move any of this code into new modules and the tests keep
   passing, which is exactly what a safety net must do. A test coupled to internals would go
   red on a pure move and train everyone to ignore it.

   The cost is honest: these are integration tests, so a failure localises to a behaviour
   rather than a line. That trade is deliberate.
================================================================================= */
import { render } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VisualTaskCommandCenter from '../VisualTaskCommandCenter.jsx';
import { ME } from './apiMock.js';

export const testSession = {
  user: { id: ME, email: 'me@test.dev' },
  access_token: 'test-token',
};

export const testMember = {
  id: ME,
  email: 'me@test.dev',
  display_name: 'Me',
  avatar_url: null,
};

/**
 * Mount the app at a route.
 *
 * WHY BrowserRouter + a REAL jsdom URL, AND NOT MemoryRouter
 * ----------------------------------------------------------
 * The app reads `window.location` directly in several places rather than going through the
 * router — `?ws=` during workspace resolution, and `window.location.pathname` fed straight
 * back into `navigate(...)` on both resolve and workspace switch.
 *
 * Under MemoryRouter those reads see jsdom's default `http://localhost/`, NOT the router
 * entry. So mounting at '/projects' rendered ProjectsView, and then the resolution effect
 * navigated to `window.location.pathname` — '/' — silently unmounting the very view under
 * test a few hundred ms in. Tests failed with "unable to find" on elements that had been
 * present moments earlier, and worse, absence-style assertions PASSED VACUOUSLY because the
 * whole surface was gone for an unrelated reason.
 *
 * Pushing the route into jsdom's own history and using BrowserRouter keeps the router and
 * `window.location` in agreement, which is the arrangement the app actually ships with.
 *
 * @param {object} [opts]
 * @param {string} [opts.route] Initial URL, e.g. '/projects' or '/?ws=<id>'.
 * @param {object} [opts.session]
 * @param {object} [opts.member]
 * @param {() => void} [opts.onSignOut]
 */
export function renderApp({
  route = '/',
  session = testSession,
  member = testMember,
  onSignOut = () => {},
} = {}) {
  window.history.replaceState({}, '', route);
  return render(
    <BrowserRouter>
      <VisualTaskCommandCenter
        session={session}
        currentMember={member}
        onSignOut={onSignOut}
        refreshCurrentMember={() => {}}
      />
    </BrowserRouter>,
  );
}

/**
 * A complete app-shape Task. `tasks.list()` returns these already mapped, so fixtures must
 * be camelCase and fully populated — a missing `priority` will throw inside the app, which
 * indexes `PRIORITIES[task.priority].rank` without a guard.
 *
 * @param {Partial<import('../lib/types.js').Task>} [over]
 */
export function makeTask(over = {}) {
  return {
    id: 'task-1',
    workspaceId: '11111111-1111-1111-1111-111111111111',
    title: 'Test task',
    description: '',
    assigneeId: ME,
    privacy: 'workspace',
    project: 'proj-1',
    status: 'inbox',
    priority: 'medium',
    effort: 'medium',
    urgent: false,
    important: false,
    blocked: false,
    blockedReason: '',
    dueDate: null,
    scheduledDate: null,
    estimatedMinutes: 30,
    tags: [],
    subtasks: [],
    links: [],
    recurring: null,
    createdBy: ME,
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:00:00.000Z',
    completedAt: null,
    order: 1,
    ...over,
  };
}

/** A RAW project row (snake_case) — matching what `projects.list()` really returns. */
export function makeProject(over = {}) {
  return {
    id: 'proj-1',
    name: 'Project One',
    color: '#5B67F1',
    icon: 'folder',
    workspace_id: '11111111-1111-1111-1111-111111111111',
    ...over,
  };
}
