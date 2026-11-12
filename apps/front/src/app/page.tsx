'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ApiRoutes, apiErrorMessage, viaProxy } from '@auth/contracts/http';
import type {
  ApiErrorResponse,
  CurrentUserResponse,
  LoginRequest,
  LogoutRequest,
  RefreshRequest,
  TokenPair,
} from '@auth/contracts/http';
import OAuthButtons from './oauth-buttons';
import { clearSession, writeSession } from '../lib/session';
import styles from './page.module.scss';

// Signed-in state is `GET /auth/me`'s answer, read through its contract type. The tokens
// themselves are deliberately absent from every rendered value: they are held in a ref to
// make the calls, and a token in the DOM is a token in a screenshot and a DOM assertion.

export default function Index() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState<CurrentUserResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Outside `state` on purpose: these two are inputs to the next request, not things the
  // screen shows, and the component-state rule that keeps a token out of the DOM applies to
  // them both.
  const tokens = useRef<TokenPair | null>(null);

  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setInfo(null);

    try {
      const response = await fetch(viaProxy(ApiRoutes.login), {
        method: ApiRoutes.login.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password } satisfies LoginRequest),
      });

      // The login answer is a token pair and a session id — deliberately no profile. "Who is
      // this?" is a second question the edge asks identity and access-control, and a login
      // response that carried a profile would be a profile minted at sign-in time rather than
      // one read from the services that own it.
      const payload = (await response.json()) as TokenPair | ApiErrorResponse;

      if (!response.ok || !('accessToken' in payload)) {
        // The gateway refuses a wrong password without explaining which of the two it was —
        // by design, since "no such account" and "wrong password" are the same answer to a
        // stranger. The refusal message is shown verbatim, and the flow can be retried.
        setMessage(apiErrorMessage(payload, `Sign-in failed (${response.status})`));
        return;
      }

      tokens.current = payload;

      // Multi-page storefront (cart, checkout, orders) shares this pair across navigation.
      // The ref still owns the sign-in screen; sessionStorage is the hand-off between pages.
      writeSession({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        sessionId: payload.sessionId,
        expiresIn: payload.expiresIn,
      });

      const caller = await loadCaller(payload.accessToken);
      if (caller === null) return;

      setSignedIn(caller);
    } catch {
      setMessage('The gateway did not answer');
    } finally {
      setBusy(false);
    }
  };

  /** `GET /auth/me`, the one question the login answer deliberately does not include. */
  const loadCaller = async (accessToken: string): Promise<CurrentUserResponse | null> => {
    const me = await fetch(viaProxy(ApiRoutes.me), {
      method: ApiRoutes.me.method,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const caller = (await me.json()) as CurrentUserResponse | ApiErrorResponse;

    if (!me.ok || !('user' in caller)) {
      setMessage(apiErrorMessage(caller, `Could not load the caller (${me.status})`));
      return null;
    }

    return caller;
  };

  /**
   * Adopts a session that landed in the fragment — from a completed OAuth walk, or from a
   * registration that auto-signed the caller in.
   *
   * @remarks The fragment is a channel, not storage: it is read once, stripped from the URL
   * with `history.replaceState` so it never sits in history, and from then on the pair lives
   * only in the same ref the sign-in form uses. A reload therefore signs out — which is the
   * behaviour this page already had, and deliberately keeps.
   */
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash.length === 0) return;

    const params = new URLSearchParams(hash);

    const oauthError = params.get('oauth_error');
    if (oauthError !== null) {
      window.history.replaceState(null, '', window.location.pathname);
      setMessage(oauthError);
      return;
    }

    const accessToken = params.get('access_token');
    if (accessToken === null) return;

    const pair: TokenPair = {
      accessToken,
      refreshToken: params.get('refresh_token') ?? '',
      // The platform issues exactly one scheme, and neither the OAuth landing nor the
      // register hand-off puts it in the fragment — so it is stated here, once.
      tokenType: 'Bearer',
      expiresIn: Number(params.get('expires_in') ?? 0),
      sessionId: params.get('session_id') ?? '',
    };
    window.history.replaceState(null, '', window.location.pathname);
      tokens.current = pair;
      writeSession({
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        sessionId: pair.sessionId,
        expiresIn: pair.expiresIn,
      });

      void (async () => {
      const caller = await loadCaller(pair.accessToken);
      if (caller !== null) setSignedIn(caller);
    })();
    // Mount-only by nature: the fragment exists on arrival and not again.
  }, []);

  /**
   * Exchanges the refresh token for a new pair — the endpoint, exercised.
   *
   * @remarks The response replaces the pair even though only the next request uses it: a
   * refresh token is single-use by design, and keeping the old one after a rotation would
   * leave the UI holding a credential the server has already retired.
   */
  const refreshSession = async () => {
    const refreshToken = tokens.current?.refreshToken;
    if (!refreshToken) {
      setMessage('No refresh token in this session');
      return;
    }

    setBusy(true);
    setMessage(null);
    setInfo(null);
    try {
      const response = await fetch(viaProxy(ApiRoutes.refresh), {
        method: ApiRoutes.refresh.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken } satisfies RefreshRequest),
      });
      const payload = (await response.json()) as TokenPair | ApiErrorResponse;

      if (!response.ok || !('accessToken' in payload)) {
        setMessage(apiErrorMessage(payload, `Refresh failed (${response.status})`));
        return;
      }

      tokens.current = payload;
      writeSession({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        sessionId: payload.sessionId,
        expiresIn: payload.expiresIn,
      });
      setInfo(`Session refreshed; the new access token lives ${payload.expiresIn}s`);
    } catch {
      setMessage('The gateway did not answer');
    } finally {
      setBusy(false);
    }
  };

  /** Re-reads the caller — the answer can change while the token stays valid. */
  const reloadCaller = async () => {
    const accessToken = tokens.current?.accessToken;
    if (!accessToken) return;

    setBusy(true);
    setMessage(null);
    try {
      const caller = await loadCaller(accessToken);
      if (caller !== null) setSignedIn(caller);
    } catch {
      setMessage('The gateway did not answer');
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    const accessToken = tokens.current?.accessToken;

    // The local state clears first and the server call is best-effort after it: the screen
    // must return to the form the moment the person asks, and a logout that lost the network
    // race would otherwise leave a signed-in screen nobody can leave. The session server-side
    // is ended by the request below whenever the answer arrives in time.
    setSignedIn(null);
    setMessage(null);
    setInfo(null);
    setEmail('');
    setPassword('');
    tokens.current = null;
    clearSession();

    if (accessToken) {
      void fetch(viaProxy(ApiRoutes.logout), {
        method: ApiRoutes.logout.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ reason: 'front' } satisfies LogoutRequest),
      }).catch(() => undefined);
    }
  };

  return (
    <main className={styles.page}>
      <h1>Auth platform</h1>
      <p className={styles.lede}>
        Sign-in against the real <code>api-gateway</code>, across five services.
      </p>

      {signedIn ? (
        <section className={styles.card} aria-labelledby="signed-in-heading">
          <h2 id="signed-in-heading">Signed in</h2>
          <dl className={styles.facts}>
            <div>
              <dt>Email</dt>
              <dd data-testid="me-email">{signedIn.user.email}</dd>
            </div>
            <div>
              <dt>User id</dt>
              <dd data-testid="me-id">{signedIn.user.id}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd data-testid="me-session">{signedIn.sessionId || '—'}</dd>
            </div>
            <div>
              <dt>Roles</dt>
              <dd data-testid="me-roles">{signedIn.roles.join(', ') || '—'}</dd>
            </div>
            <div>
              <dt>Permissions</dt>
              <dd data-testid="me-permissions">
                {signedIn.permissions.join(', ') || '—'}
              </dd>
            </div>
          </dl>

          <div className={styles.row}>
            <button type="button" onClick={refreshSession} disabled={busy}>
              Refresh session
            </button>
            <button type="button" onClick={reloadCaller} disabled={busy}>
              Reload caller
            </button>
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </div>

          {message ? (
            <p className={styles.error} role="alert">
              {message}
            </p>
          ) : null}
          {info ? (
            <p className={styles.muted} data-testid="session-info">
              {info}
            </p>
          ) : null}
        </section>
      ) : (
        <form className={styles.card} onSubmit={signIn}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          {message ? (
            <p className={styles.error} role="alert">
              {message}
            </p>
          ) : null}
        </form>
      )}

      {!signedIn ? <OAuthButtons /> : null}

      <nav className={styles.nav}>
        <Link href="/register">Create an account</Link>
        <Link href="/playground">API playground</Link>
        <Link href="/shop">Shop</Link>
        <Link href="/cart">Cart</Link>
        <Link href="/orders">Orders</Link>
      </nav>
    </main>
  );
}
