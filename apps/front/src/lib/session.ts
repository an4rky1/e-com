/**
 * @fileoverview Browser session for storefront pages.
 *
 * @remarks The sign-in page keeps tokens in a ref — one screen, no navigation. Catalog,
 * cart, checkout and orders are four pages that must share the same bearer, so the pair
 * lives in `sessionStorage`: it dies with the tab, is never rendered, and is never sent
 * anywhere except as the `Authorization` header the contract already specifies.
 *
 * @remarks `globalThis` rather than a bare `window`: the spec config is a Node program
 * without the DOM lib, and naming `window` there is a compile error even though the tests
 * run under jsdom.
 */

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresIn: number;
}

const KEY = 'auth.session';

interface BrowserWindow {
  sessionStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
}

const browser = (): BrowserWindow['sessionStorage'] | null => {
  const candidate = (globalThis as { window?: BrowserWindow }).window;
  return candidate?.sessionStorage ?? null;
};

export function readSession(): SessionTokens | null {
  const store = browser();
  if (!store) return null;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionTokens>;
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? '',
      sessionId: parsed.sessionId ?? '',
      expiresIn: Number(parsed.expiresIn ?? 0),
    };
  } catch {
    return null;
  }
}

export function writeSession(tokens: SessionTokens): void {
  const store = browser();
  if (!store) return;
  store.setItem(KEY, JSON.stringify(tokens));
}

export function clearSession(): void {
  const store = browser();
  if (!store) return;
  store.removeItem(KEY);
}

/** Bearer header for an authenticated storefront call, or null when signed out. */
export function authHeaders(): Record<string, string> | null {
  const session = readSession();
  if (!session) return null;
  return { Authorization: `Bearer ${session.accessToken}` };
}
