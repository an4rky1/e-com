/**
 * @fileoverview The OAuth `state` parameter: signed where it is minted, checked where it
 * returns.
 *
 * @remarks `state` is the only thing tying a callback to the tab that started it — without
 * it, an attacker who obtains a live code can feed it to a victim's browser and have the
 * victim's session bound to the attacker's provider account. Signing it here makes tampering
 * and cross-tab replay visible as a bad signature rather than as a completed sign-in.
 *
 * @remarks The payload is a provider name and an expiry, and nothing else — deliberately.
 * This is a nonce, not a session: anyone who reads a valid state learns which provider was
 * being started and when the window closes, which they already knew, and gains no way to
 * mint a token from it. The comparison is length-prefixed `timingSafeEqual` so a guess is
 * constant-time work rather than an early exit.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface OAuthStateClaims {
  /** Which provider the browser was sent to; a callback for another one is refused. */
  readonly provider: string;
  /** Unix seconds — the moment this state stops being acceptable. */
  readonly exp: number;
}

/** How long a started walk may take before the tab has to start over. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

const b64url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

const mac = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/**
 * Mints `payload.signature`, where the payload is opaque to whoever holds the URL.
 *
 * @remarks The expiry is computed here rather than accepted from the caller: a TTL is a
 * property of this walk, and a caller that could choose it could choose infinity.
 */
export function signOAuthState(
  provider: string,
  secret: string,
  now: Date = new Date(),
): string {
  const exp = Math.floor((now.getTime() + OAUTH_STATE_TTL_MS) / 1000);
  const payload = b64url(JSON.stringify({ p: provider, e: exp }));
  return `${payload}.${mac(payload, secret)}`;
}

/**
 * Reads a returned `state`, or refuses it.
 *
 * @remarks Every refusal is `null`, never a reason: the caller's answer is "verify or stop",
 * and distinguishing "expired" from "forged" in the response would tell an attacker which
 * part of their guess was close. The reason is worth logging at the call site if it ever
 * matters; it is never worth sending back.
 */
export function verifyOAuthState(
  state: string | undefined,
  secret: string,
  now: Date = new Date(),
): OAuthStateClaims | null {
  if (typeof state !== 'string' || state.length === 0) return null;

  const dot = state.indexOf('.');
  if (dot <= 0 || dot === state.length - 1) return null;

  const payload = state.slice(0, dot);
  const signature = Buffer.from(state.slice(dot + 1), 'utf8');
  const expected = Buffer.from(mac(payload, secret), 'utf8');
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { p: provider, e: exp } = parsed as { p?: unknown; e?: unknown };
  if (typeof provider !== 'string' || provider.length === 0) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  // `<=` rather than `<`: a state that expires on this exact second is expired, and the
  // second of expiry is the second an attacker most wants to use it in.
  if (exp * 1000 <= now.getTime()) return null;

  return { provider, exp };
}
