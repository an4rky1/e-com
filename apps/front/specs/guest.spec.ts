/**
 * @fileoverview The guest id: one per tab, minted once, carried as a header.
 *
 * @remarks jsdom provides `window.sessionStorage`; the suite seeds and clears that store
 * the way `session.spec` does. The two properties that matter here are the single-flight
 * — a cold tab must not mint one guest per parallel cart call — and the failure answer:
 * a refused mint is `null`, not a thrown error, so the caller's own request still goes
 * out and the gateway's refusal is what the shopper sees.
 */

// A module, not a global script: without an import/export TypeScript puts every spec's
// top-level names in one shared scope, and `KEY`/`Store`/`store` collide across files.
export {};

const KEY = 'guest.id';

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

const originalFetch = global.fetch;

const reply = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('guest id helpers', () => {
  beforeEach(() => {
    store().clear();
  });

  afterEach(() => {
    store().clear();
    global.fetch = originalFetch;
  });

  it('round-trips an id through sessionStorage', async () => {
    const { readGuestId, writeGuestId, clearGuestId } = await import('../src/lib/guest');

    expect(readGuestId()).toBeNull();
    writeGuestId('guest-1');
    expect(store().getItem(KEY)).toBe('guest-1');
    expect(readGuestId()).toBe('guest-1');
    clearGuestId();
    expect(readGuestId()).toBeNull();
  });

  it('builds the header only when the tab holds an id', async () => {
    const { guestHeaders, writeGuestId } = await import('../src/lib/guest');

    expect(guestHeaders()).toBeNull();
    writeGuestId('guest-1');
    expect(guestHeaders()).toEqual({ 'x-guest-id': 'guest-1' });
  });

  it('treats an empty entry as absent rather than as an id', async () => {
    const { readGuestId } = await import('../src/lib/guest');
    store().setItem(KEY, '');

    expect(readGuestId()).toBeNull();
  });

  it('mints against the contract route when the tab has none', async () => {
    global.fetch = jest.fn().mockResolvedValue(reply(200, { user: { id: 'guest-minted' } }));
    const { ensureGuestId, readGuestId } = await import('../src/lib/guest');

    await expect(ensureGuestId()).resolves.toBe('guest-minted');
    expect(readGuestId()).toBe('guest-minted');

    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(call[0])).toContain('/auth/guest');
    expect(call[1]?.method).toBe('POST');
  });

  it('reuses a stored id without asking identity again', async () => {
    global.fetch = jest.fn();
    const { ensureGuestId, writeGuestId } = await import('../src/lib/guest');
    writeGuestId('guest-existing');

    await expect(ensureGuestId()).resolves.toBe('guest-existing');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('single-flights a cold mint into one request', async () => {
    // Three cart calls on a cold tab, all in the same tick: the second and third wait on
    // the first's promise instead of minting guests that would each hold part of one
    // basket and never meet.
    global.fetch = jest
      .fn()
      .mockResolvedValue(reply(200, { user: { id: 'guest-once' } }));
    const { ensureGuestId } = await import('../src/lib/guest');

    const [first, second, third] = await Promise.all([
      ensureGuestId(),
      ensureGuestId(),
      ensureGuestId(),
    ]);

    expect([first, second, third]).toEqual(['guest-once', 'guest-once', 'guest-once']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('answers null when the gateway refuses, and stores nothing', async () => {
    global.fetch = jest.fn().mockResolvedValue(reply(503, { detail: 'identity is down' }));
    const { ensureGuestId, readGuestId } = await import('../src/lib/guest');

    await expect(ensureGuestId()).resolves.toBeNull();
    expect(readGuestId()).toBeNull();
  });

  it('answers null when the call rejects outright, and allows a retry', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(reply(200, { user: { id: 'guest-retry' } }));
    global.fetch = fetchMock;
    const { ensureGuestId } = await import('../src/lib/guest');

    await expect(ensureGuestId()).resolves.toBeNull();

    // The flight is over, so the next cart call may ask again rather than inherit
    // a promise that already settled to null forever.
    await expect(ensureGuestId()).resolves.toBe('guest-retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
