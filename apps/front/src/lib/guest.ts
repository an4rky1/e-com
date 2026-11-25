/**
 * @fileoverview The browser's anonymous identity: one guest id per tab.
 *
 * @remarks A guest id turns "nobody" into an addressable basket: the gateway accepts it
 * as `X-Guest-Id` wherever a bearer would do, and the cart keys a document under
 * `session:<id>` exactly while `userId` is empty. It lives in `sessionStorage` beside the
 * token pair for the same reasons the pair does — dies with the tab, never rendered, and
 * never sent anywhere except as the header the contract specifies.
 *
 * @remarks Minted lazily, only when a cart is actually touched: a catalog read must not
 * spend a round trip (or a row in identity) on a visitor who never opens a basket. The
 * single-flight is what keeps three parallel cart calls on a cold tab from minting three
 * guests — three documents that would each hold part of one basket and never meet.
 */
import { ApiRoutes, GUEST_ID_HEADER, viaProxy } from '@auth/contracts/http';
import type { AcquireGuestUserResponse, ApiErrorResponse } from '@auth/contracts/http';
import { JSON_CONTENT_TYPE } from './api-constants';

const KEY = 'guest.id';

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

/** The guest id this tab already holds, or null. */
export function readGuestId(): string | null {
  const store = browser();
  if (!store) return null;
  try {
    const raw = store.getItem(KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeGuestId(guestId: string): void {
  browser()?.setItem(KEY, guestId);
}

/** Spends the id: after a successful merge the basket it named no longer exists. */
export function clearGuestId(): void {
  browser()?.removeItem(KEY);
}

/** Header for a call that should carry this tab's guest id, or null when it has none. */
export function guestHeaders(): Record<string, string> | null {
  const guestId = readGuestId();
  return guestId ? { [GUEST_ID_HEADER]: guestId } : null;
}

/**
 * The in-flight mint, so a second caller waits on the first instead of asking again.
 *
 * @remarks Module-level rather than per call: the racing callers are separate fetches
 * from separate components, not arguments to one function.
 */
let inFlight: Promise<string | null> | null = null;

/**
 * The guest id for this tab, minting one when it has none.
 *
 * @remarks A failed mint answers `null` rather than throwing: the request that needed
 * the id goes out without the header and the gateway's own refusal ("a bearer access
 * token or a guest id is required") is the answer the caller sees — a truer error than
 * one invented here, and the cart call can be retried once the network is back.
 */
export function ensureGuestId(): Promise<string | null> {
  const existing = readGuestId();
  if (existing) return Promise.resolve(existing);
  if (inFlight) return inFlight;

  inFlight = mintGuestId().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function mintGuestId(): Promise<string | null> {
  if (!browser()) return null;
  try {
    const response = await fetch(viaProxy(ApiRoutes.acquireGuest), {
      method: ApiRoutes.acquireGuest.method,
      headers: { 'Content-Type': JSON_CONTENT_TYPE },
      body: JSON.stringify({}),
    });
    const payload = (await response.json()) as AcquireGuestUserResponse | ApiErrorResponse;
    if (!response.ok || !('user' in payload)) return null;

    const guestId = payload.user?.id;
    if (typeof guestId !== 'string' || guestId.length === 0) return null;

    writeGuestId(guestId);
    return guestId;
  } catch {
    return null;
  }
}
