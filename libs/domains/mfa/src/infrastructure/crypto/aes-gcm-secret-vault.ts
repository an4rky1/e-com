/**
 * @fileoverview AES-256-GCM at rest for factor secrets.
 *
 * @remarks A TOTP secret is not a credential that can be rotated on suspicion — nobody watches
 * them, and a disclosure is indistinguishable from normal use. That asymmetry is why it is
 * encrypted rather than hashed: the service has to be able to recompute a code from the stored
 * value on every verification, so the stored form has to be reversible. GCM is chosen over CBC
 * because it authenticates as well as encrypts, so a tampered envelope fails loudly at
 * decryption instead of silently yielding a different key.
 *
 * @remarks The envelope is `v1.<iv>.<tag>.<ciphertext>`, base64 each. The version prefix is
 * what makes a future key rotation or algorithm change a migration with a decrypt path rather
 * than an outage discovered months later.
 *
 * @remarks A fresh 96-bit IV per encryption, prepended and never reused. Under GCM, repeating
 * an IV with the same key destroys the authentication guarantee for both messages — which is
 * why this is `randomBytes` and not a counter that could reset on restart.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import type { SecretVaultPort } from '../../domain/ports/secret-vault.port';
import { MFA_SECRET_ENCRYPTION_KEY } from '../../mfa.config';

/** Envelope marker. Bump only alongside a migration that can read the previous form. */
export const ENVELOPE_VERSION = 'v1';

/** 96 bits: the GCM-native length, and the one the specification is cheapest with. */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
export const AES_KEY_BYTES = 32;

/** Accepts base64 (what `openssl rand -base64 32` prints) or 64 hex characters. */
export function parseEncryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const decoded = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  if (decoded.length !== AES_KEY_BYTES) {
    // Refused at boot rather than padded or truncated: either of those produces a service that
    // encrypts with a key nobody recorded, and the factors become undecryptable the moment
    // the process restarts.
    throw new Error(
      `MFA secret encryption key must decode to ${AES_KEY_BYTES} bytes, received ${decoded.length}`,
    );
  }

  return decoded;
}

@Injectable()
export class AesGcmSecretVault implements SecretVaultPort {
  private readonly key: Buffer;

  constructor(@Inject(MFA_SECRET_ENCRYPTION_KEY) rawKey: string) {
    this.key = parseEncryptionKey(rawKey);
  }

  async encrypt(plaintext: string): Promise<string> {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new Error('refusing to encrypt an empty secret');
    }

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    return [
      ENVELOPE_VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  /**
   * Refuses to return a plaintext it cannot authenticate.
   *
   * @remarks `getAuthTag()` comparison is constant-time and any mismatch throws. Returning
   * *something* — even wrong plaintext — would let a truncated or edited row produce codes
   * that fail with no explanation, and the operator would be hunting a storage problem in a
   * verification failure.
   */
  async decrypt(envelope: string): Promise<string> {
    const parts = String(envelope).split('.');
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw new Error('malformed secret envelope');
    }

    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');

    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) {
      throw new Error('malformed secret envelope');
    }

    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}