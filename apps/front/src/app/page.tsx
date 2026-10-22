'use client';

import { useState } from 'react';
import styles from './page.module.scss';

// The profile, once the token is in hand. `accessToken` is deliberately absent: it is held in
// state to make the `/auth/me` call, and a token kept in a rendered value is a token that ends
// up in a screenshot and a DOM assertion.
type SignedIn = {
  email: string;
  id: string;
};

export default function Index() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState<SignedIn | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // The token lives in component state, not in `localStorage`. This page exists to be driven
  // by a test, and a token that survives a reload is a token the test cannot control: a
  // previous run would decide the next run's starting screen.
  const signIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      // The login answer is a token pair and a session id — deliberately no profile. "Who is
      // this?" is a second question the edge asks identity and access-control, and a login
      // response that carried a profile would be a profile minted at sign-in time rather than
      // one read from the services that own it.
      const payload = (await response.json()) as {
        accessToken?: string;
        error?: string;
      };

      if (!response.ok || !payload.accessToken) {
        // The gateway refuses a wrong password without explaining which of the two it was —
        // by design, since "no such account" and "wrong password" are the same answer to a
        // stranger. The refusal message is shown verbatim, and the flow can be retried.
        setMessage(payload.error ?? `Sign-in failed (${response.status})`);
        return;
      }

      const me = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${payload.accessToken}` },
      });
      const caller = (await me.json()) as {
        user?: { id?: string; email?: string };
        error?: string;
      };

      if (!me.ok || !caller.user) {
        setMessage(caller.error ?? `Could not load the caller (${me.status})`);
        return;
      }

      setSignedIn({
        email: caller.user.email ?? email,
        id: caller.user.id ?? '',
      });
    } catch {
      setMessage('The gateway did not answer');
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    setSignedIn(null);
    setMessage(null);
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
              <dd data-testid="me-email">{signedIn.email}</dd>
            </div>
            <div>
              <dt>User id</dt>
              <dd data-testid="me-id">{signedIn.id}</dd>
            </div>
          </dl>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
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
    </main>
  );
}
