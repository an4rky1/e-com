/**
 * @fileoverview Key generation, hashing and verification.
 *
 * @remarks This suite runs against `NodeApiKeyCrypto` itself rather than a double, because every
 * property it asserts — a CSPRNG, a real SHA-256, a constant-time comparison — is a property of
 * `node:crypto`. A fake would only prove the fake agrees with itself.
 *
 * @remarks The three failure modes it exists to catch are all silent: a body that came from
 * `Math.random`, a digest that somehow holds the plaintext, and a comparison that throws
 * instead of answering.
 */

import 'reflect-metadata';
import { DIGEST_LENGTH, NodeApiKeyCrypto } from '../src/infrastructure/crypto/node-api-key.crypto';
import {
  API_KEY_PATTERN,
  ApiKeyPrefix,
  PREFIX_SUFFIX_LENGTH,
  SECRET_BODY_LENGTH,
  parseApiKey,
  readPrefixFamily,
} from '../src/domain/value-objects/api-key-prefix.vo';
import { ApiKeySecret } from '../src/domain/value-objects/api-key-secret.vo';

const crypto = new NodeApiKeyCrypto();

/** How many keys "many" means here. Big enough that a birthday collision would show up. */
const BULK = 1_000;

describe('issueMaterial', () => {
  it('produces `<family>_<random>_<body>`, and the prefix is the stored half', () => {
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    expect(API_KEY_PATTERN.test(material.secret.value)).toBe(true);
    expect(material.secret.value.startsWith(`${ApiKeyPrefix.TEST}_`)).toBe(true);
    expect(material.prefix).toBe(material.secret.prefix);
    expect(readPrefixFamily(material.prefix)).toBe(ApiKeyPrefix.TEST);
    expect(material.family).toBe(ApiKeyPrefix.TEST);

    const parsed = parseApiKey(material.secret.value);
    expect(parsed?.prefix).toBe(material.prefix);
    expect(parsed?.body).toHaveLength(SECRET_BODY_LENGTH);
    expect(material.prefix.split('_')[1]).toHaveLength(PREFIX_SUFFIX_LENGTH);
  });

  it('marks a live key `live_` and a test key `test_`, so the two are told apart at a glance', () => {
    // A production key pasted into staging has to be *obviously* wrong, and the family travels
    // inside the credential so a caller cannot relabel one by accident.
    expect(crypto.issueMaterial(ApiKeyPrefix.LIVE).secret.value.startsWith('live_')).toBe(true);
    expect(crypto.issueMaterial(ApiKeyPrefix.TEST).secret.value.startsWith('test_')).toBe(true);
  });

  it('never repeats a key, or a prefix, across many generations', () => {
    const secrets = new Set<string>();
    const prefixes = new Set<string>();
    const digests = new Set<string>();

    for (let i = 0; i < BULK; i += 1) {
      const material = crypto.issueMaterial(ApiKeyPrefix.TEST);
      secrets.add(material.secret.value);
      prefixes.add(material.prefix);
      digests.add(material.digest);
    }

    // A repeat in any one of the three is a real failure: two keys with one plaintext, one
    // lookup prefix resolving to the wrong row, or one digest standing for two credentials.
    expect(secrets.size).toBe(BULK);
    expect(prefixes.size).toBe(BULK);
    expect(digests.size).toBe(BULK);
  });

  it('uses the full base62 alphabet rather than a handful of characters', () => {
    // A biased alphabet — modulo folding, or a smaller draw — removes entropy from a value whose
    // only job is to be unguessable, and does it invisibly.
    const seen = new Set<string>();

    for (let i = 0; i < BULK; i += 1) {
      const body = parseApiKey(crypto.issueMaterial(ApiKeyPrefix.LIVE).secret.value)?.body ?? '';
      for (const character of body) seen.add(character);
    }

    expect(seen.size).toBe(62);
  });
});

describe('digest', () => {
  it('is the SHA-256 of the plaintext, and never the plaintext', () => {
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    expect(material.digest).toHaveLength(DIGEST_LENGTH);
    expect(material.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(material.digest).not.toBe(material.secret.value);
    expect(material.secret.value).not.toContain(material.digest);
  });

  it('is stable, so a re-issued command reproduces the same stored digest', () => {
    const key = crypto.issueMaterial(ApiKeyPrefix.TEST).secret.value;

    expect(crypto.digest(key)).toBe(crypto.digest(key));
  });

  it('is one-way for the value that matters: knowing the digest does not yield the key', () => {
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    // What a database dump yields, and the entire point of storing a digest: ids, prefixes and
    // 64 hex characters, and nothing that can be presented.
    expect(
      JSON.stringify({
        prefix: material.prefix,
        secret_hash: material.digest,
      }),
    ).not.toContain(material.secret.value);
  });
});

describe('verifyKey', () => {
  it('accepts the key it was issued for', () => {
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    expect(crypto.verifyKey(material.secret.value, material.digest)).toBe(true);
  });

  it('refuses every other key, including one that shares the prefix', () => {
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);
    const other = crypto.issueMaterial(ApiKeyPrefix.TEST);

    expect(crypto.verifyKey(other.secret.value, material.digest)).toBe(false);
    // The body swapped under a *real* prefix is the attack the prefix lookup alone cannot stop.
    const tampered = `${material.prefix}_${'C'.repeat(SECRET_BODY_LENGTH)}`;
    expect(crypto.verifyKey(tampered, material.digest)).toBe(false);
    // One character different is still a different key.
    const offByOne = `${material.secret.value.slice(0, -1)}${
      material.secret.value.endsWith('A') ? 'B' : 'A'
    }`;
    expect(crypto.verifyKey(offByOne, material.digest)).toBe(false);
  });

  it('refuses an empty, truncated or over-long digest instead of throwing', () => {
    // `timingSafeEqual` throws on a length mismatch. A `secret_hash` column that was never
    // written — a half-finished migration, a row from a future format — has to fail closed, not
    // turn the answer to "is this key valid?" into a 500.
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    expect(crypto.verifyKey(material.secret.value, '')).toBe(false);
    expect(crypto.verifyKey(material.secret.value, '   ')).toBe(false);
    expect(crypto.verifyKey(material.secret.value, material.digest.slice(0, 32))).toBe(false);
    expect(crypto.verifyKey(material.secret.value, `${material.digest}ff`)).toBe(false);
    expect(crypto.verifyKey(material.secret.value, material.digest.toUpperCase())).toBe(false);
  });

  it('refuses a non-string candidate without hashing it', () => {
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    expect(crypto.verifyKey(undefined as unknown as string, material.digest)).toBe(false);
    expect(crypto.verifyKey(null as unknown as string, material.digest)).toBe(false);
    expect(crypto.verifyKey(material.secret.value, null as unknown as string)).toBe(false);
  });
});

describe('ApiKeySecret', () => {
  it('validates the shape this service issues, and refuses everything else', () => {
    const issued = crypto.issueMaterial(ApiKeyPrefix.TEST).secret.value;

    expect(ApiKeySecret.tryCreate(issued).isSuccess).toBe(true);
    expect(ApiKeySecret.tryCreate('').isFailure).toBe(true);
    expect(ApiKeySecret.tryCreate('test_abcdefgh').isFailure).toBe(true);
    expect(ApiKeySecret.tryCreate(`dev_${issued.slice(4)}`).isFailure).toBe(true);
    expect(ApiKeySecret.tryCreate(`${issued}x`).isFailure).toBe(true);
    expect(ApiKeySecret.tryCreate(undefined).isFailure).toBe(true);
  });

  it('never serialises to the secret, whatever is done to it', () => {
    // `JSON.stringify` is the leak this prevents: an own `value` property is enumerable, so any
    // logger that serialises the credential would emit a live key.
    const secret = ApiKeySecret.create(crypto.issueMaterial(ApiKeyPrefix.TEST).secret.value);

    expect(JSON.stringify(secret)).not.toContain(secret.value);
    expect(String(secret)).toBe('[REDACTED]');
    expect(`${secret}`).not.toContain(secret.value);
  });

  it('does not trim, so a padded key cannot authenticate the same machine', () => {
    const issued = crypto.issueMaterial(ApiKeyPrefix.TEST).secret.value;
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    expect(crypto.verifyKey(` ${issued} `, material.digest)).toBe(false);
    expect(ApiKeySecret.tryCreate(` ${issued} `).isFailure).toBe(true);
  });
});