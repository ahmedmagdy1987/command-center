/* =================================================================================
   TEST 7 — Theme switching must not blank any surface.

   Theme is applied by writing `data-theme` on <html>, and several components branch on
   `theme === 'light'` to pick colours. The failure this guards is a refactor that breaks the
   theme plumbing and leaves a surface rendering nothing — or throws inside a colour branch,
   which unmounts a whole subtree behind its ErrorBoundary and looks like "the page went
   blank" rather than an error.

   NOTE the initializer writes `document.documentElement` DURING render, so the attribute is
   process-wide state; setup.js clears it after every test.
================================================================================= */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, makeTask, makeProject } from './harness.jsx';
import { apiState, resetApiState } from './apiMock.js';

const LOADING = /loading your workspace/i;
const bootDone = () => waitForElementToBeRemoved(() => screen.queryByText(LOADING));

beforeEach(() => {
  resetApiState();
  apiState.projects = [makeProject()];
  apiState.tasks = [makeTask({ title: 'Survives the theme flip' })];
});

/** Flip the theme through the TopBar account menu. */
async function toggleTheme(user) {
  await user.click(await screen.findByRole('button', { name: /account and settings/i }));
  await user.click(await screen.findByRole('button', { name: /switch to (light|dark)/i }));
}

describe('theme switching', () => {
  it('defaults to dark and applies it to the document', async () => {
    renderApp();
    await bootDone();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('flips to light and keeps every surface rendered', async () => {
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    expect((await screen.findAllByText('Survives the theme flip')).length).toBeGreaterThan(0);

    await toggleTheme(user);

    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));

    // The real assertion: content is STILL THERE after the flip. A blank surface is the
    // failure mode this test exists for.
    expect((await screen.findAllByText('Survives the theme flip')).length).toBeGreaterThan(0);
  });

  it('round-trips back to dark without losing content', async () => {
    const user = userEvent.setup();
    renderApp();
    await bootDone();

    await toggleTheme(user);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'));

    await toggleTheme(user);
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));

    expect((await screen.findAllByText('Survives the theme flip')).length).toBeGreaterThan(0);
  });
});
