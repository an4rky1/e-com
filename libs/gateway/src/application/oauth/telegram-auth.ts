/**
 * @fileoverview Telegram's login widget: the signature it brings back, checked here.
 *
 * @remarks Telegram has no consent-screen redirect. The widget renders on our own page and
 * lands the browser on the callback with a payload — `id`, names, `auth_date`, `hash` —
 * signed by the bot's token rather than exchanged for a code. The signature is
 * HMAC-SHA256 over a *data-check-string*: every received field except `hash` itself, sorted
 * by key, `key=value` per line, newline-joined, keyed with `SHA256(bot_token)`. One byte
 * changed anywhere — a name, a date, an added field — is a different string under the same
 * key, so verification is the whole authenticity story: there is nothing to exchange and
 * no second round trip to make.
 *
 * @remarks `auth_date` is what makes a captured callback expire. Without it the signed URL
 * is a bearer token replayable by anyone who obtains it — from a log line, a referrer, a
 * screenshot — for as long as the bot lives. The window here is a day, Telegram's own
 * guidance, with a few minutes of tolerance the other way for clock skew between this
 * process and theirs.
 *
 * @remarks Every refusal is `null`, never a reason — the same doctrine as `verifyOAuthState`:
 * "verify or stop" does not become "verify and explain which half of the guess was close"
 * just because the caller is a browser. Distinctions that matter for a log stay here, out
 * of the redirect the victim is staring at.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** What the signature vouches for, once every check has passed. */
export interface TelegramAuthProfile {
  /** Telegram's numeric user id — stable for life, the subject the account links on. */
  readonly subject: string;
  /** First and last name, falling back to the username, falling back to the id. */
  readonly displayName: string;
  readonly username?: string;
}

/** How long a signed callback stays acceptable — a day, as Telegram itself advises. */
export const TELEGRAM_AUTH_MAX_AGE_SEC = 86_400;

/** Tolerance the other way: a widget whose clock reports slightly ahead is not a forgery. */
export const TELEGRAM_AUTH_FUTURE_TOLERANCE_SEC = 300;

/**
 * Verifies a callback's payload against the bot token, or refuses it.
 *
 * @remarks A repeated parameter arrives as an array and is refused rather than stringified:
 * the data-check-string is defined over exactly what was signed, and a request where one
 * key appears twice is already not the request Telegram sent.
 */
export function verifyTelegramAuth(
  query: Record<string, string | string[]>,
  botToken: string,
  now: Date = new Date(),
): TelegramAuthProfile | null {
  if (botToken.length === 0) return null;

  const hash = query.hash;
  if (typeof hash !== 'string' || hash.length === 0) return null;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (key === 'hash') continue;
    if (typeof value !== 'string') return null;
    lines.push(`${key}=${value}`);
  }
  lines.sort();
  const dataCheckString = lines.join('\n');

  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const received = hash.toLowerCase();
  if (
    received.length !== expected.length ||
    !timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'))
  ) {
    return null;
  }

  const authDate = query.auth_date;
  if (typeof authDate !== 'string' || !/^\d+$/.test(authDate)) return null;
  const age = Math.floor(now.getTime() / 1000) - Number(authDate);
  if (age > TELEGRAM_AUTH_MAX_AGE_SEC || age < -TELEGRAM_AUTH_FUTURE_TOLERANCE_SEC) {
    return null;
  }

  const subject = query.id;
  if (typeof subject !== 'string' || !/^\d{1,32}$/.test(subject)) return null;

  const first = typeof query.first_name === 'string' ? query.first_name.trim() : '';
  const last = typeof query.last_name === 'string' ? query.last_name.trim() : '';
  const username = typeof query.username === 'string' && query.username.length > 0
    ? query.username
    : undefined;
  const displayName = [first, last].filter((part) => part.length > 0).join(' ') ||
    username ||
    subject;

  return { subject, displayName, ...(username ? { username } : {}) };
}
