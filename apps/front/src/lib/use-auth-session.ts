'use client';

/**
 * @fileoverview Sign-in state for the auth landing page.
 *
 * @remarks Owns the token ref, the `GET /auth/me` answer, and every call that moves the
 * pair: login, refresh, logout, and the one-shot adoption of a fragment that landed from
 * an OAuth walk or a registration that auto-signed the caller in. The page keeps only the
 * form fields and the render — a screen that both manages credentials and draws them is
 * the screen where a token ends up in the DOM.
 *
 * @remarks Tokens live in a ref, never in state: they are inputs to the next request, not
 * things the screen shows, and the component-state rule that keeps a token out of a
 * screenshot applies to them both. Signed-in state is `GET /auth/me`'s answer, read
 * through its contract type.
 *
 * @remarks The fragment is a channel, not storage: it is read once, stripped from the URL
 * with `history.replaceState` so it never sits in history, and from then on the pair lives
 * only in the same ref the sign-in form uses. A reload therefore signs out — which is the
 * behaviour this page already had, and deliberately keeps.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiRoutes, apiErrorMessage, viaProxy } from '@auth/contracts/http';
import type {
  ApiErrorResponse,
  CurrentUserResponse,
  LoginRequest,
  LogoutRequest,
  RefreshRequest,
  TokenPair,
} from '@auth/contracts/http';
import { clearSession, writeSession } from './session';

export interface UseAuthSessionResult {
  signedIn: CurrentUserResponse | null;
  busy: boolean;
  message: string | null;
  info: string | null;
  signIn(input: { email: string; password: string }): Promise<void>;
  refreshSession(): Promise<void>;
  reloadCaller(): Promise<void>;
  signOut(): void;
}

export function useAuthSession(): UseAuthSessionResult {
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState<CurrentUserResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Outside `state` on purpose: these two are inputs to the next request, not things the
  // screen shows, and the component-state rule that keeps a token out of the DOM applies to
  // them both.
  const tokens = useRef<TokenPair | null>(null);

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

  const signIn = async (input: { email: string; password: string }): Promise<void> => {
    setBusy(true);
    setMessage(null);
    setInfo(null);

    try {
      const response = await fetch(viaProxy(ApiRoutes.login), {
        method: ApiRoutes.login.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input.email, password: input.password } satisfies LoginRequest),
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

  /**
   * Adopts a session that landed in the fragment — from a completed OAuth walk, or from a
   * registration that auto-signed the caller in.
   *
   * @remarks Mount-only by nature: the fragment exists on arrival and not again.
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
  const refreshSession = async (): Promise<void> => {
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
  const reloadCaller = async (): Promise<void> => {
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

  const signOut = (): void => {
    const accessToken = tokens.current?.accessToken;

    // The local state clears first and the server call is best-effort after it: the screen
    // must return to the form the moment the person asks, and a logout that lost the network
    // race would otherwise leave a signed-in screen nobody can leave. The session server-side
    // is ended by the request below whenever the answer arrives in time.
    setSignedIn(null);
    setMessage(null);
    setInfo(null);
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

  return {
    signedIn,
    busy,
    message,
    info,
    signIn,
    refreshSession,
    reloadCaller,
    signOut,
  };
}
