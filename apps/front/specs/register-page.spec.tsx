import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Register from '../src/app/register/page';

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

const originalFetch = global.fetch;

const mockFetch = (result: { ok: boolean; status: number; json: () => Promise<unknown> }) => {
  const fetchMock = jest.fn().mockResolvedValue(result);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

afterEach(() => {
  global.fetch = originalFetch;
  push.mockReset();
});

const submitWith = async (container: HTMLElement, fields: Record<string, string>) => {
  for (const [label, value] of Object.entries(fields)) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.submit(container.querySelector('form') as HTMLFormElement);
};

describe('Register', () => {
  it('collects a password and hands the issued session to the sign-in page', async () => {
    const fetchMock = mockFetch(
      reply(200, {
        accessToken: 'access.token.value',
        refreshToken: 'refresh.token.value',
        expiresIn: 900,
        sessionId: 'session-1',
        tokenType: 'Bearer',
      }),
    );
    const { container } = render(<Register />);

    await submitWith(container, {
      'Email address': 'ada@example.test',
      Password: 'Str0ng-Passw0rd!x',
      'Display name': 'Ada',
    });

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        '/#access_token=access.token.value&refresh_token=refresh.token.value&expires_in=900&session_id=session-1',
      ),
    );
    // The whole registration — three fields, one request; the old two-field provisioning
    // call is gone. Found by URL because the provider read on mount fetched first.
    const registerCall = fetchMock.mock.calls.find(
      ([url]: [unknown]) => String(url) === '/api/register',
    );
    expect(registerCall).toBeDefined();
    const init = (registerCall as [string, { body: string }])[1];
    expect(JSON.parse(init.body)).toEqual({
      email: 'ada@example.test',
      password: 'Str0ng-Passw0rd!x',
      displayName: 'Ada',
    });
  });

  it('shows the refusal the endpoint reports, and signs nobody in', async () => {
    mockFetch(reply(409, { error: 'email already registered' }));
    const { container } = render(<Register />);

    await submitWith(container, {
      'Email address': 'taken@example.test',
      Password: 'Str0ng-Passw0rd!x',
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('email already registered'),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('reports the gateway being unreachable', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { container } = render(<Register />);

    await submitWith(container, {
      'Email address': 'ada@example.test',
      Password: 'Str0ng-Passw0rd!x',
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('The gateway did not answer'),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it('offers only the providers the gateway reports as configured', async () => {
    const fetchMock = jest
      .fn()
      // The mount-time read: Google is configured, GitHub and Telegram are not.
      .mockResolvedValueOnce(
        reply(200, { google: true, github: false, telegram: false, telegramBotUsername: null }),
      )
      .mockResolvedValue(reply(200, { accessToken: 'a' }));

    global.fetch = fetchMock as unknown as typeof fetch;
    render(<Register />);

    const google = await screen.findByTestId('oauth-google');
    expect(google.getAttribute('href')).toBe('/api/auth/oauth/google');
    expect(screen.queryByTestId('oauth-github')).toBeNull();
    expect(screen.queryByTestId('oauth-telegram')).toBeNull();
  });

  it('renders the Telegram widget with the reported bot and an absolute callback URL', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        reply(200, {
          google: false,
          github: false,
          telegram: true,
          telegramBotUsername: 'front_test_bot',
        }),
      )
      .mockResolvedValue(reply(200, { accessToken: 'a' }));

    global.fetch = fetchMock as unknown as typeof fetch;
    render(<Register />);

    const widget = await screen.findByTestId('oauth-telegram');
    await waitFor(() => {
      const script = widget.querySelector('script');
      expect(script?.getAttribute('src')).toContain('telegram.org/js/telegram-widget.js');
      expect(script?.getAttribute('data-telegram-login')).toBe('front_test_bot');
      // Telegram refuses a relative target: the widget needs the origin spelled out.
      expect(script?.getAttribute('data-auth-url')).toBe(
        'http://localhost/api/auth/oauth/telegram/callback',
      );
    });
    expect(screen.queryByTestId('oauth-google')).toBeNull();
    expect(screen.queryByTestId('oauth-github')).toBeNull();
  });
});
