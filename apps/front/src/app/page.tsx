'use client';

import { useState } from 'react';
import Link from 'next/link';
import OAuthButtons from './oauth-buttons';
import { useAuthSession } from '../lib/use-auth-session';
import styles from './page.module.scss';

/**
 * The auth landing page: sign-in form, or the signed-in card once `GET /auth/me` answers.
 *
 * @remarks Session lifecycle lives in {@link useAuthSession}; this file owns only the form
 * fields and the render. Email and password are local because they are inputs the person
 * is still typing — nothing else on the page needs them, and sign-out clears them here
 * rather than through the hook so the form resets even when the hook is reused elsewhere.
 */
export default function Index() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { signedIn, busy, message, info, signIn, refreshSession, reloadCaller, signOut } =
    useAuthSession();

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await signIn({ email, password });
  };

  const onSignOut = () => {
    signOut();
    setEmail('');
    setPassword('');
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
            <button type="button" onClick={onSignOut}>
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
        <form className={styles.card} onSubmit={onSubmit}>
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
