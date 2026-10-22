/**
 * @fileoverview Which family an issued key belongs to, and the shape of a key.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the wire format is plain text. The `prefix`
 * column is `text` for the same reason — adding a family must not be a migration.
 *
 * @remarks `live` and `test` are separated on purpose. A production key pasted into a
 * staging service has to be obviously wrong at a glance, and the database has to be able to
 * refuse it there too: the family travels in the key itself, so the caller cannot mislabel
 * one by accident.
 */

/** The key family, and the leading segment of every issued key. */
export const ApiKeyPrefix = {
  LIVE: 'live',
  TEST: 'test',
} as const;

export type ApiKeyPrefix = (typeof ApiKeyPrefix)[keyof typeof ApiKeyPrefix];

/** Separates the prefix from the secret body, and the family from the prefix's own suffix. */
export const KEY_SEPARATOR = '_';

/**
 * Random base62 characters inside the stored `prefix`.
 *
 * @remarks The column is `@unique` and is the lookup key, so the prefix carries its own
 * entropy: a caller holding a key must be able to find its row without scanning digests,
 * and that shortcut may never be guessable. Eight characters is ~47 bits.
 */
export const PREFIX_SUFFIX_LENGTH = 8;

/** Base62 characters in the secret body. 43 characters ≈ 256 bits. */
export const SECRET_BODY_LENGTH = 43;

/** Every family name, joined for the pattern below to match greedily. */
const FAMILY_NAMES: readonly string[] = Object.values(ApiKeyPrefix);

const FAMILIES = FAMILY_NAMES.join('|');

/**
 * `live_9f3k2aQb_7Zq0mL8...`
 *
 * @remarks Anchored, and the body is base62 only — which is what makes {@link parseApiKey}
 * unambiguous: with no second underscore in the body, the prefix is everything before the
 * last one.
 *
 * @remarks Built from the constants above rather than written out, so a length cannot change
 * in one place and not the other.
 */
export const API_KEY_PATTERN = new RegExp(
  `^(${FAMILIES})${KEY_SEPARATOR}[0-9A-Za-z]{${PREFIX_SUFFIX_LENGTH}}${KEY_SEPARATOR}[0-9A-Za-z]{${SECRET_BODY_LENGTH}}$`,
);

/**
 * Shortest value that could have been issued by this service.
 *
 * @remarks Measured from the longest *family name*, not from {@link FAMILIES}. The two look
 * alike and are not: `FAMILIES` is `live|test` — the alternation a pattern is built from, eight
 * characters including the pipe — and using it here would set the floor above every key this
 * service can issue, so `ApiKeySecret` would reject its own output on the way out.
 *
 * @remarks A length floor rejects obviously malformed input before it reaches the database.
 * Anything long enough to have been minted here passes, and an attacker guessing one simply
 * misses on the digest comparison.
 */
export const API_KEY_MIN_LENGTH =
  Math.max(...FAMILY_NAMES.map((family) => family.length)) +
  1 +
  PREFIX_SUFFIX_LENGTH +
  1 +
  SECRET_BODY_LENGTH;

export function isApiKeyPrefix(value: unknown): value is ApiKeyPrefix {
  return (
    typeof value === 'string' &&
    (Object.values(ApiKeyPrefix) as string[]).includes(value)
  );
}

/** `<family>_<random>`, the value stored in `api_keys.prefix` and shown back to the owner. */
export function composePrefix(family: ApiKeyPrefix, suffix: string): string {
  return `${family}${KEY_SEPARATOR}${suffix}`;
}

/** The family a stored prefix belongs to, or `null` when it is not one of ours. */
export function readPrefixFamily(prefix: string): ApiKeyPrefix | null {
  const family = prefix.split(KEY_SEPARATOR)[0];
  return isApiKeyPrefix(family) ? family : null;
}

export interface ParsedApiKey {
  /** The stored `prefix` column value: `<family>_<random>`. */
  readonly prefix: string;
  /** The random half only. Never compared, never stored — it exists to fill the digest. */
  readonly body: string;
}

/**
 * Splits a presented key into lookup prefix and secret body.
 *
 * @remarks Returns `null` rather than throwing: this runs on the unauthenticated path, where
 * the input is attacker-controlled and a malformed value is an ordinary outcome rather than
 * an error condition.
 */
export function parseApiKey(raw: string): ParsedApiKey | null {
  if (typeof raw !== 'string') return null;

  const separator = raw.lastIndexOf(KEY_SEPARATOR);
  if (separator <= 0 || separator === raw.length - 1) return null;

  const prefix = raw.slice(0, separator);
  if (readPrefixFamily(prefix) === null) return null;

  return { prefix, body: raw.slice(separator + 1) };
}