'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiRoutes, viaProxy } from '@auth/contracts/http';
import type { ApiMethod, ApiRoute, TokenPair } from '@auth/contracts/http';
import styles from '../page.module.scss';

/**
 * Every route the edge exposes, as a form.
 *
 * @remarks Six endpoints, and the point of the page is that they are six — the same surface
 * `tools/e2e-gateway.sh` drives over curl, in a form where a person can put their own values
 * in. Nothing here is a second implementation of the API: each entry's method, proxied path
 * and guard come from `@auth/contracts/http`, the file the gateway's controllers are checked
 * against, so this picker cannot advertise a route the edge does not serve.
 *
 * @remarks The token fields start empty and are filled from a login performed *on this page*,
 * so a tester never has to paste a credential they obtained somewhere else — and a response
 * that carries a token pair is offered back into the form, because a refresh token is
 * single-use and the natural way to test `refresh` is to use the one login just issued.
 */
type Endpoint = {
  id: string;
  method: ApiMethod;
  path: string;
  summary: string;
  body: string;
  /** Whether this route needs a Bearer token to be reachable at all. */
  authenticated: boolean;
};

/**
 * Builds a picker entry from the contract, plus the two things only this page owns.
 *
 * @remarks The path goes through the proxy prefix and swaps the gateway's `:id` for the
 * placeholder a tester replaces — the input below is edited by hand before the request is
 * sent, and `<user-id>` says what to put there in a way `:id` does not.
 */
const endpoint = (
  id: string,
  route: ApiRoute,
  summary: string,
  body: string,
): Endpoint => ({
  id,
  method: route.method,
  path: viaProxy(route).replace(':id', '<user-id>'),
  summary,
  body,
  authenticated: route.authenticated,
});

const ENDPOINTS: Endpoint[] = [
  endpoint(
    'create-user',
    ApiRoutes.createUser,
    'Create an account. Public — this is how registration starts.',
    '{\n  "email": "newcomer@example.test",\n  "displayName": "New Comer"\n}',
  ),
  endpoint(
    'set-password',
    ApiRoutes.setPassword,
    'Set the initial password. Needs users:password:set — a refusal with 403 here is the privilege boundary working.',
    '{\n  "password": "Str0ng-Passw0rd!x"\n}',
  ),
  endpoint(
    'login',
    ApiRoutes.login,
    'Exchange email + password for a token pair. Public.',
    '{\n  "email": "demo@example.test",\n  "password": "Str0ng-Passw0rd!x"\n}',
  ),
  endpoint(
    'refresh',
    ApiRoutes.refresh,
    'Rotate a refresh token into a new pair. Public — the refresh token is the credential.',
    '{\n  "refreshToken": ""\n}',
  ),
  endpoint(
    'logout',
    ApiRoutes.logout,
    'End the caller’s session; every session with everywhere: true.',
    '{\n  "reason": "playground",\n  "everywhere": false\n}',
  ),
  endpoint(
    'me',
    ApiRoutes.me,
    'The caller with their live roles and permissions, composed from two services.',
    '',
  ),
];

type Result = {
  status: number;
  statusText: string;
  body: string;
};

export default function Playground() {
  const [selected, setSelected] = useState<Endpoint>(ENDPOINTS[2]);
  const [path, setPath] = useState(ENDPOINTS[2].path);
  const [body, setBody] = useState(ENDPOINTS[2].body);
  const [token, setToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = (endpoint: Endpoint) => {
    setSelected(endpoint);
    setPath(endpoint.path);
    setBody(endpoint.body);
    setResult(null);
    setError(null);
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const headers: Record<string, string> = {};
      if (selected.method === 'POST') headers['Content-Type'] = 'application/json';
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const response = await fetch(path, {
        method: selected.method,
        headers,
        ...(selected.method === 'POST' && body.trim() ? { body } : {}),
      });
      const text = await response.text();

      setResult({
        status: response.status,
        statusText: response.statusText,
        body: formatBody(text),
      });

      // A pair in the answer becomes this page's pair: the refresh test wants exactly the
      // token login just minted, and copying it by hand is the step where a tester ends up
      // pasting an expired one.
      const payload = safeParse(text) as Partial<TokenPair> | null;
      if (payload?.accessToken) setToken(payload.accessToken);
      if (payload?.refreshToken) setRefreshToken(payload.refreshToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const useRefreshToken = () => {
    if (!refreshToken) return;
    setPath(viaProxy(ApiRoutes.refresh));
    setSelected(
      ENDPOINTS.find((endpoint) => endpoint.id === 'refresh') ?? selected,
    );
    setBody(`{\n  "refreshToken": "${refreshToken}"\n}`);
  };

  return (
    <main className={`${styles.page} ${styles.wide}`}>
      <h1>API playground</h1>
      <p className={styles.lede}>
        Every endpoint the edge exposes, through the front&apos;s own proxy — same origin the
        browser will use in production.
      </p>

      <section className={styles.card} aria-labelledby="picker-heading">
        <h2 id="picker-heading">Endpoint</h2>
        <label htmlFor="endpoint">Route</label>
        <select
          id="endpoint"
          value={selected.id}
          onChange={(event) => {
            const endpoint = ENDPOINTS.find((item) => item.id === event.target.value);
            if (endpoint) choose(endpoint);
          }}
        >
          {ENDPOINTS.map((endpoint) => (
            <option key={endpoint.id} value={endpoint.id}>
              {`${endpoint.method} ${endpoint.path}`}
            </option>
          ))}
        </select>
        <p className={styles.muted}>{selected.summary}</p>

        <label htmlFor="request-path">Path</label>
        <input
          id="request-path"
          type="text"
          value={path}
          onChange={(event) => setPath(event.target.value)}
        />

        <label htmlFor="bearer">Bearer token</label>
        <input
          id="bearer"
          type="text"
          autoComplete="off"
          placeholder="Filled by a login below"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />

        {selected.method === 'POST' ? (
          <>
            <label htmlFor="request-body">Request body</label>
            <textarea
              id="request-body"
              rows={7}
              spellCheck={false}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </>
        ) : null}

        <div className={styles.row}>
          <button type="button" onClick={send} disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          <button
            type="button"
            onClick={() => setToken('')}
            disabled={!token || busy}
          >
            Clear token
          </button>
          <button
            type="button"
            onClick={useRefreshToken}
            disabled={!refreshToken || busy}
          >
            Use last refresh token
          </button>
        </div>
        {refreshToken ? (
          <p className={styles.muted} data-testid="refresh-token-held">
            A refresh token from the last response is held for the refresh route.
          </p>
        ) : null}

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {result ? (
        <section className={styles.card} aria-labelledby="result-heading">
          <h2 id="result-heading">Response</h2>
          <p className={styles.muted} data-testid="response-status">
            {`${result.status} ${result.statusText}`}
          </p>
          <pre className={styles.response} data-testid="response-body">
            {result.body}
          </pre>
        </section>
      ) : null}

      <nav className={styles.nav}>
        <Link href="/">Back to sign-in</Link>
        <Link href="/register">Create an account</Link>
      </nav>
    </main>
  );
}

const formatBody = (text: string): string => {
  const parsed = safeParse(text);
  return parsed === null ? text || '(empty body)' : JSON.stringify(parsed, null, 2);
};

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};
