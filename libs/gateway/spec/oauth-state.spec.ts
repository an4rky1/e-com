/**
 * @fileoverview The `state` nonce, as the callback will meet it.
 *
 * @remarks This parameter is the whole CSRF defence of the walk: a callback without it is a
 * URL anybody can construct, and a callback with a *forgeable* one is nearly as bad. The
 * claims below are therefore the difference between "the tab that started this is the tab
 * that finished it" and a stranger binding their provider account to somebody else's
 * session, so each failure mode gets its own line here.
 */
import { createHmac } from 'node:crypto';
import {
  OAUTH_STATE_TTL_MS,
  signOAuthState,
  verifyOAuthState,
} from '../src/application/oauth/oauth-state';

const SECRET = 'a-state-secret-for-the-suite';
const NOW = new Date('2026-10-25T12:00:00.000Z');

describe('signOAuthState', () => {
  it('round-trips the provider inside the window', () => {
    const state = signOAuthState('google', SECRET, NOW);

    expect(verifyOAuthState(state, SECRET, NOW)).toEqual({
      provider: 'google',
      exp: expect.any(Number),
    });
  });

  it('sets an expiry one TTL out, and no further', () => {
    const state = signOAuthState('github', SECRET, NOW);
    const claims = verifyOAuthState(state, SECRET, NOW);

    // `<=` on the boundary: a state is dead on its expiry second, not a second later.
    expect(claims?.exp).toBe(Math.floor((NOW.getTime() + OAUTH_STATE_TTL_MS) / 1000));
    expect(verifyOAuthState(state, SECRET, new Date(NOW.getTime() + OAUTH_STATE_TTL_MS))).toBeNull();
    expect(
      verifyOAuthState(state, SECRET, new Date(NOW.getTime() + OAUTH_STATE_TTL_MS - 1)),
    ).not.toBeNull();
  });
});

describe('verifyOAuthState', () => {
  it('refuses a state signed with another secret', () => {
    const state = signOAuthState('google', SECRET, NOW);

    expect(verifyOAuthState(state, 'a-different-secret', NOW)).toBeNull();
  });

  it('refuses a payload whose bytes were swapped', () => {
    const state = signOAuthState('google', SECRET, NOW);
    const [payload, signature] = state.split('.');

    // Same length, different content: the signature covers every byte of it, so a string
    // comparison of lengths or a slice would have to be exactly as strict as this.
    const last = payload.slice(-1);
    const swapped = payload.slice(0, -1) + (last === 'a' ? 'b' : 'a');
    expect(verifyOAuthState(`${swapped}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it('refuses structural junk without throwing', () => {
    for (const junk of ['', 'no-dot-here', 'a.', '.b', '..', `${'x'.repeat(64)}.sig`]) {
      expect(verifyOAuthState(junk, SECRET, NOW)).toBeNull();
    }
    expect(verifyOAuthState(undefined, SECRET, NOW)).toBeNull();
  });

  it('refuses a payload that signs but is not a claim pair', () => {
    // A correctly signed body with the wrong shape: possible only if the signer itself is
    // confused, which is exactly when the verifier must not trust it either.
    const payload = Buffer.from(JSON.stringify({ p: '', e: 'soon' }), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', SECRET).update(payload).digest('base64url');

    expect(verifyOAuthState(`${payload}.${signature}`, SECRET, NOW)).toBeNull();
  });
});
