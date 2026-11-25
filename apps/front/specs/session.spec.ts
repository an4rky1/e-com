/**
 * @fileoverview Session helpers: the pair lives in sessionStorage and never in the DOM.
 *
 * @remarks jsdom already provides `window.sessionStorage`; the suite seeds and clears that
 * store rather than redefining `window`, which is non-configurable under jsdom. The helper
 * reaches storage through `globalThis.window`, so this file never needs a DOM lib either.
 */

// A module, not a global script — see the same note in `guest.spec.ts`.
export {};

const KEY = 'auth.session';
const EXPIRES_IN_SEC = 900;

type Store = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

const store = (): Store => {
  const w = (globalThis as { window?: { sessionStorage: Store } }).window;
  if (!w) throw new Error('jsdom window is missing');
  return w.sessionStorage;
};

describe('session helpers', () => {
  beforeEach(() => {
    store().clear();
  });

  afterEach(() => {
    store().clear();
  });

  it('round-trips a token pair through sessionStorage', async () => {
    const { writeSession, readSession, clearSession } = await import('../src/lib/session');
    writeSession({
      accessToken: 'a.t',
      refreshToken: 'r.t',
      sessionId: 's-1',
      expiresIn: EXPIRES_IN_SEC,
    });
    expect(store().getItem(KEY)).not.toBeNull();
    expect(readSession()?.accessToken).toBe('a.t');
    clearSession();
    expect(readSession()).toBeNull();
  });

  it('treats a corrupt entry as signed out rather than throwing', async () => {
    const { readSession } = await import('../src/lib/session');
    store().setItem(KEY, '{not-json');
    expect(readSession()).toBeNull();
  });

  it('refuses an entry with no access token', async () => {
    const { readSession } = await import('../src/lib/session');
    store().setItem(KEY, JSON.stringify({ refreshToken: 'r' }));
    expect(readSession()).toBeNull();
  });

  it('builds a bearer header only when a session exists', async () => {
    const { authHeaders, writeSession } = await import('../src/lib/session');
    expect(authHeaders()).toBeNull();
    writeSession({
      accessToken: 'a.t',
      refreshToken: '',
      sessionId: '',
      expiresIn: EXPIRES_IN_SEC,
    });
    expect(authHeaders()).toEqual({ Authorization: 'Bearer a.t' });
  });
});
