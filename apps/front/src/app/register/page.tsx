'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PASSWORD_MIN_LENGTH, apiErrorMessage } from '@auth/contracts/http';
import type { ApiErrorResponse, TokenPair } from '@auth/contracts/http';
import { GATEWAY_UNAVAILABLE_MESSAGE, JSON_CONTENT_TYPE } from '../../lib/api-constants';
import OAuthButtons from '../oauth-buttons';
import styles from '../page.module.scss';

/**
 * Registration: the one part of the account surface that is public at the edge.
 *
 * @remarks The page posts to `/api/register` — the front's own route handler, which checks
 * the three fields and places the `POST /auth/register` call from the server — rather than
 * through the rewrite, so what a well-formed registration looks like is decided next to the
 * form, not by whoever opens the network tab. Success and failure bodies come from
 * `@auth/contracts/http`, so this page reads the gateway's answer through the same types the
 * gateway composes it with.
 *
 * @remarks Registration *is* a sign-in: `POST /auth/register` answers with a session, and
 * this page hands it to the sign-in page through the URL fragment — the same channel the
 * OAuth walk uses — rather than keeping a second copy of the token pair. The pair is never
 * rendered, never stored, and the fragment is stripped on the far side the moment it is
 * read.
 */
export default function Register() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const register = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': JSON_CONTENT_TYPE },
        body: JSON.stringify({
          email,
          password,
          ...(displayName ? { displayName } : {}),
        }),
      });
      const payload = (await response.json()) as TokenPair | ApiErrorResponse;

      if (!response.ok || !('accessToken' in payload)) {
        setMessage(apiErrorMessage(payload, `Account creation failed (${response.status})`));
        return;
      }

      // Auto-login: the session crosses in the fragment, browser-local, and the sign-in
      // page adopts it on mount — one pair, one channel, for both ways in.
      const pair = new URLSearchParams({
        access_token: payload.accessToken,
        refresh_token: payload.refreshToken,
        expires_in: String(payload.expiresIn),
        session_id: payload.sessionId,
      });
      router.push(`/#${pair.toString()}`);
    } catch {
      setMessage(GATEWAY_UNAVAILABLE_MESSAGE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <h1>Create an account</h1>
      <p className={styles.lede}>
        One request creates the account, sets the first password and signs you in.
      </p>

      <form className={styles.card} onSubmit={register}>
        <label htmlFor="reg-email">Email address</label>
        <input
          id="reg-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <label htmlFor="reg-password">Password</label>
        <input
          id="reg-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className={styles.muted}>
          The vault refuses anything weaker than 12 characters without an uppercase letter, a
          lowercase letter, a digit and a symbol.
        </p>

        <label htmlFor="reg-name">Display name</label>
        <input
          id="reg-name"
          name="displayName"
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>

        {message ? (
          <p className={styles.error} role="alert">
            {message}
          </p>
        ) : null}
      </form>

      <OAuthButtons />

      <nav className={styles.nav}>
        <Link href="/">Back to sign-in</Link>
        <Link href="/playground">API playground</Link>
      </nav>
    </main>
  );
}
