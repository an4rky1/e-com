/**
 * @fileoverview Encryption at rest for TOTP secrets, and digests for recovery codes.
 *
 * @remarks The property under test throughout is *the stored form is not the usable form*.
 * A TOTP secret has to be reversible — the service recomputes a code from it on every
 * verification — which is exactly why a plaintext column would be so much worse here than for
 * a password: there is no second copy anywhere to rotate back to, and nobody is watching for
 * a disclosure.
 */

import { createHash } from 'node:crypto';
import {
  AES_KEY_BYTES,
  ENVELOPE_VERSION,
  parseEncryptionKey,
} from '../src/infrastructure/crypto/aes-gcm-secret-vault';
import {
  canonicalRecoveryCode,
  RECOVERY_CODE_SALT_BYTES,
} from '../src/infrastructure/crypto/node-recovery-codes.service';
import { REDACTED_SECRET, TotpSecret } from '../src/domain/value-objects/totp-secret.vo';
import { RECOVERY_CODE_PATTERN } from '../src/domain/value-objects/mfa-method.vo';
import { RFC_TEST_SECRET, makeCodes, makeVault } from './support/fakes';

describe('AES-256-GCM secret vault', () => {
  it('stores something that is not the secret, and decrypts it back', async () => {
    const vault = makeVault();

    const stored = await vault.encrypt(RFC_TEST_SECRET);

    expect(stored).not.toBe(RFC_TEST_SECRET);
    expect(stored).not.toContain(RFC_TEST_SECRET);
    expect(stored.startsWith(`${ENVELOPE_VERSION}.`)).toBe(true);
    // base64 of the raw base32 secret would contain the secret's own characters verbatim.
    expect(Buffer.from(stored.split('.')[3], 'base64').toString('utf8')).not.toBe(
      RFC_TEST_SECRET,
    );
    expect(await vault.decrypt(stored)).toBe(RFC_TEST_SECRET);
  });

  it('uses a fresh IV per encryption', async () => {
    const vault = makeVault();
    const first = await vault.encrypt(RFC_TEST_SECRET);
    const second = await vault.encrypt(RFC_TEST_SECRET);

    // Repeating an IV under the same key destroys GCM's authentication for both messages.
    expect(first.split('.')[1]).not.toBe(second.split('.')[1]);
    expect(first).not.toBe(second);
  });

  it('refuses a tampered ciphertext rather than returning a different key', async () => {
    const vault = makeVault();
    const stored = await vault.encrypt(RFC_TEST_SECRET);
    const parts = stored.split('.');
    const ciphertext = Buffer.from(parts[3], 'base64');
    ciphertext[0] ^= 0xff;

    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      ciphertext.toString('base64'),
    ].join('.');

    await expect(vault.decrypt(tampered)).rejects.toThrow();
  });

  it('refuses an envelope from a different key', async () => {
    const stored = await makeVault().encrypt(RFC_TEST_SECRET);
    const other = makeVault(Buffer.alloc(AES_KEY_BYTES, 7).toString('base64'));

    await expect(other.decrypt(stored)).rejects.toThrow();
  });

  it('refuses a malformed envelope', async () => {
    const vault = makeVault();
    for (const envelope of ['', 'nope', 'v9.a.b.c', 'v1.a.b', 'v1.aaa.bbb.ccc']) {
      await expect(vault.decrypt(envelope)).rejects.toThrow();
    }
  });

  it('refuses to encrypt nothing', async () => {
    await expect(makeVault().encrypt('')).rejects.toThrow();
  });

  it('accepts a 32-byte key as hex or base64 and refuses anything else', () => {
    const bytes = Buffer.alloc(AES_KEY_BYTES, 3);

    expect(parseEncryptionKey(bytes.toString('hex'))).toEqual(bytes);
    expect(parseEncryptionKey(bytes.toString('base64'))).toEqual(bytes);
    // Padded or truncated keys would encrypt with a key nobody recorded, and every factor
    // would become undecryptable the moment the process restarted.
    expect(() => parseEncryptionKey('too-short')).toThrow(/32 bytes/);
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('TotpSecret', () => {
  it('never serialises itself', () => {
    const secret = TotpSecret.create(RFC_TEST_SECRET);

    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED_SECRET}"}`);
    expect(String(secret)).toContain(RFC_TEST_SECRET);
    // Logs still get a correlator without a usable value.
    expect(secret.redacted).toBe(`${REDACTED_SECRET}:…${RFC_TEST_SECRET.slice(-4)}`);
  });

  it('rejects a secret that is not base32 of the expected length', () => {
    expect(() => TotpSecret.create('too-short')).toThrow();
    expect(() => TotpSecret.create('11111111111111111111111111111111')).toThrow();
  });
});

describe('recovery codes', () => {
  const codes = makeCodes();

  it('mints distinct codes that match the display pattern', () => {
    const minted = codes.generate(10);

    expect(new Set(minted).size).toBe(10);
    for (const code of minted) expect(code).toMatch(RECOVERY_CODE_PATTERN);
  });

  it('never repeats across batches', () => {
    // `Math.random` seeded from the clock would collide here within seconds.
    const first = codes.generate(20);
    const second = codes.generate(20);

    expect(first.filter((code) => second.includes(code))).toHaveLength(0);
  });

  it('hashes a code into a one-way digest that is not the code', () => {
    const salt = codes.newSalt();
    const [code] = codes.generate(1);
    const digest = codes.digest(code, salt);

    expect(digest).not.toBe(code);
    expect(digest).toBe(createHash('sha256').update(`${salt}:${canonicalRecoveryCode(code)}`).digest('hex'));
    // Nothing about the plaintext survives into the stored column.
    expect(digest).not.toContain(code.replace('-', ''));
  });

  it('salts the digest, so two sets never share one', () => {
    const [code] = codes.generate(1);

    expect(codes.digest(code, codes.newSalt())).not.toBe(codes.digest(code, codes.newSalt()));
    expect(codes.newSalt()).toHaveLength(RECOVERY_CODE_SALT_BYTES * 2);
  });

  it('matches only the code that was hashed', () => {
    const salt = codes.newSalt();
    const [mine, theirs] = codes.generate(2);

    expect(codes.matches(mine, salt, codes.digest(mine, salt))).toBe(true);
    expect(codes.matches(theirs, salt, codes.digest(mine, salt))).toBe(false);
    expect(codes.matches(mine, salt, codes.digest(mine, codes.newSalt()))).toBe(false);
  });

  it('canonicalises a retyped code', () => {
    const salt = codes.newSalt();
    const [code] = codes.generate(1);
    const digest = codes.digest(code, salt);

    // Recovery codes are read off a screen and typed back by hand; a hyphen or a lowercase
    // letter must not be the difference between "works" and "support ticket".
    expect(codes.matches(code.toLowerCase(), salt, digest)).toBe(true);
    expect(codes.matches(` ${code} `, salt, digest)).toBe(true);
    expect(codes.matches(code.replace('-', ''), salt, digest)).toBe(true);
  });

  it('answers false — never throws — for an empty or foreign digest', () => {
    const [code] = codes.generate(1);

    expect(codes.matches(code, codes.newSalt(), '')).toBe(false);
    expect(codes.matches(code, codes.newSalt(), 'not-a-digest')).toBe(false);
  });

  it('refuses a nonsensical count', () => {
    expect(() => codes.generate(0)).toThrow();
    expect(() => codes.generate(-1)).toThrow();
    expect(() => codes.generate(1.5)).toThrow();
  });
});