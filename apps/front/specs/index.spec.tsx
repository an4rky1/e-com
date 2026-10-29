import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import Page from '../src/app/page';

const originalFetch = global.fetch;

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const me = {
  user: {
    id: 'u-1',
    email: 'ada@example.test',
    displayName: 'Ada',
    status: 'active',
    emailVerified: true,
  },
  roles: ['member'],
  permissions: ['users:read'],
  sessionId: 'session-1',
};

/**
 * Routes by URL rather than by call order: the adoption effect, the mount-time provider
 * read and the caller load all fetch, and which lands first is React's business, not the
 * test's.
 */
const routingFetch = (routes: Record<string, unknown>) =>
  jest.fn().mockImplementation((input: unknown) => {
    const url = String(input);
    for (const [needle, body] of Object.entries(routes)) {
      if (url.includes(needle)) return Promise.resolve(reply(200, body));
    }
    return Promise.resolve(reply(404, { error: 'not stubbed' }));
  });

afterEach(() => {
  global.fetch = originalFetch;
  window.history.replaceState(null, '', '/');
});

describe('Page', () => {
  it('renders the sign-in form', () => {
    render(<Page />);

    // Plain jest matchers, not jest.dom's: the setup file that teaches `toBeInTheDocument` is
    // not part of this workspace, and a matcher that does not exist fails as a test failure
    // rather than as a missing dependency.
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('adopts a session that landed in the fragment, strips it, and loads the caller', async () => {
    window.location.hash =
      '#access_token=access.token.value&refresh_token=refresh.token.value&expires_in=900&session_id=session-1';
    global.fetch = routingFetch({ '/auth/me': me, '/auth/oauth': { google: false, github: false, telegram: false, telegramBotUsername: null } });

    render(<Page />);

    await waitFor(() => expect(screen.getByTestId('me-email').textContent).toBe('ada@example.test'));
    // The pair was read once and removed from the URL — a channel, not storage.
    expect(window.location.hash).toBe('');
    const meCall = (global.fetch as jest.Mock).mock.calls.find(([url]) =>
      String(url).includes('/auth/me'),
    );
    expect(meCall?.[1]?.headers).toEqual({ Authorization: 'Bearer access.token.value' });
  });

  it('shows a refusal the OAuth walk landed with, and strips that too', async () => {
    window.location.hash = '#oauth_error=the+sign-in+could+not+be+verified';
    global.fetch = routingFetch({ '/auth/oauth': { google: false, github: false, telegram: false, telegramBotUsername: null } });

    render(<Page />);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('the sign-in could not be verified'),
    );
    expect(window.location.hash).toBe('');
  });

  it('leaves the form alone when there is no fragment to adopt', () => {
    global.fetch = routingFetch({ '/auth/oauth': { google: false, github: false, telegram: false, telegramBotUsername: null } });

    render(<Page />);

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByTestId('me-email')).toBeNull();
  });
});
