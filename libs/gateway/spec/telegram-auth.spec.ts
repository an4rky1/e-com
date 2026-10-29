/**
 * @fileoverview The Telegram callback signature, against a fixed vector and every refusal.
 *
 * @remarks The vector is computed once, by hand, from the documented algorithm — not by the
 * code under test — so this file catches a change in *how* the data-check-string or the key
 * is built, which an internally-consistent round trip would happily absorb. The vector also
 * carries a `query_id`, so accepting it proves extra signed fields are kept in the string
 * rather than dropped: sign one set, verify another, and every tamper test still passes.
 */
import { createHash, createHmac } from 'node:crypto';
import {
  TELEGRAM_AUTH_FUTURE_TOLERANCE_SEC,
  TELEGRAM_AUTH_MAX_AGE_SEC,
  verifyTelegramAuth,
} from '../src/application/oauth/telegram-auth';

const BOT_TOKEN = '7000000001:test-telegram-bot-token';
const AUTH_DATE = 1_700_000_000;
const NOW = new Date((AUTH_DATE + 60) * 1000);

/** The exact fields Telegram signed, and the hash it produced for them. */
const SIGNED = {
  auth_date: String(AUTH_DATE),
  first_name: 'Ada',
  id: '777000111',
  last_name: 'Lovelace',
  photo_url: 'https://t.me/i/userpic/32/photo.jpg',
  query_id: 'AAHexamplequeryid',
  username: 'ada_lovelace',
} as const;

const FIXED_HASH =
  '8eaa6cebf9fef30e77bcdde00b47d7cb38340f6291a4704b5ce5569d2caee4f4';

const FIXED_QUERY: Record<string, string | string[]> = { ...SIGNED, hash: FIXED_HASH };

/** A hash over whatever this test decides to send — for the cases no vector can cover. */
const signed = (
  fields: Record<string, string>,
  botToken: string = BOT_TOKEN,
): Record<string, string | string[]> => {
  const dataCheckString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return { ...fields, hash };
};

describe('verifyTelegramAuth', () => {
  it('accepts the fixed vector and reads the profile out of it', () => {
    const profile = verifyTelegramAuth(FIXED_QUERY, BOT_TOKEN, NOW);

    expect(profile).toEqual({
      subject: '777000111',
      displayName: 'Ada Lovelace',
      username: 'ada_lovelace',
    });
  });

  it('sorts the fields itself — the order they arrive in is not part of the signature', () => {
    const reversed = Object.fromEntries(Object.entries(FIXED_QUERY).reverse());

    expect(verifyTelegramAuth(reversed, BOT_TOKEN, NOW)).not.toBeNull();
  });

  it('refuses one field changed after signing', () => {
    const tampered = { ...FIXED_QUERY, first_name: 'Eve' };

    expect(verifyTelegramAuth(tampered, BOT_TOKEN, NOW)).toBeNull();
  });

  it('refuses an added field', () => {
    const tampered = { ...FIXED_QUERY, admin: '1' };

    expect(verifyTelegramAuth(tampered, BOT_TOKEN, NOW)).toBeNull();
  });

  it('refuses a hash keyed with another bot', () => {
    expect(verifyTelegramAuth(FIXED_QUERY, '7000000002:another-token', NOW)).toBeNull();
  });

  it('refuses an empty token — an unconfigured deployment verifies nothing', () => {
    expect(verifyTelegramAuth(FIXED_QUERY, '', NOW)).toBeNull();
  });

  it('refuses a missing or empty hash', () => {
    const unsigned: Record<string, string | string[]> = { ...FIXED_QUERY };
    delete unsigned.hash;

    expect(verifyTelegramAuth(unsigned, BOT_TOKEN, NOW)).toBeNull();
    expect(verifyTelegramAuth({ ...unsigned, hash: '' }, BOT_TOKEN, NOW)).toBeNull();
  });

  it('refuses a repeated parameter — the string that was signed had one value', () => {
    const duplicated = { ...FIXED_QUERY, first_name: ['Ada', 'Eve'] };

    expect(verifyTelegramAuth(duplicated, BOT_TOKEN, NOW)).toBeNull();
  });

  it('accepts a callback at the edge of the window and refuses one past it', () => {
    const onTime = signed({ id: '1', auth_date: String(AUTH_DATE) });
    const boundary = new Date((AUTH_DATE + TELEGRAM_AUTH_MAX_AGE_SEC) * 1000);
    const late = new Date((AUTH_DATE + TELEGRAM_AUTH_MAX_AGE_SEC + 1) * 1000);

    expect(verifyTelegramAuth(onTime, BOT_TOKEN, boundary)).not.toBeNull();
    expect(verifyTelegramAuth(onTime, BOT_TOKEN, late)).toBeNull();
  });

  it('refuses a callback dated in the future beyond clock skew', () => {
    const ahead = signed({ id: '1', auth_date: String(AUTH_DATE) });
    const justInside = new Date((AUTH_DATE - TELEGRAM_AUTH_FUTURE_TOLERANCE_SEC) * 1000);
    const beyond = new Date((AUTH_DATE - TELEGRAM_AUTH_FUTURE_TOLERANCE_SEC - 1) * 1000);

    expect(verifyTelegramAuth(ahead, BOT_TOKEN, justInside)).not.toBeNull();
    expect(verifyTelegramAuth(ahead, BOT_TOKEN, beyond)).toBeNull();
  });

  it('refuses a date that is not a number at all', () => {
    for (const authDate of ['', 'now', '1.5', ' 1700000000', '9'.repeat(400)]) {
      const query = signed({ id: '1', auth_date: authDate });
      // A body that signed a malformed date is itself malformed — and the length check
      // still has to hold when the number parses to Infinity.
      expect(verifyTelegramAuth(query, BOT_TOKEN, NOW)).toBeNull();
    }
  });

  it('refuses a payload with no id — there would be no subject to link on', () => {
    const noId: Record<string, string> = { ...SIGNED };
    delete noId.id;

    expect(verifyTelegramAuth(signed(noId), BOT_TOKEN, NOW)).toBeNull();
  });

  it('falls back through the name the way the widget offers it', () => {
    expect(
      verifyTelegramAuth(signed({ id: '5', auth_date: String(AUTH_DATE), username: 'ada' }), BOT_TOKEN, NOW),
    ).toEqual({ subject: '5', displayName: 'ada', username: 'ada' });
    expect(
      verifyTelegramAuth(signed({ id: '5', auth_date: String(AUTH_DATE) }), BOT_TOKEN, NOW),
    ).toEqual({ subject: '5', displayName: '5' });
  });
});
