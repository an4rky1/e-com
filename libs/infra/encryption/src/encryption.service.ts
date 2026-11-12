import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ENCRYPTION_CONFIG, type EncryptionConfig } from './encryption.config';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`Cannot decrypt payload: ${reason}`);
    this.name = 'DecryptionError';
  }
}

/**
 * AES-256-GCM for values the database may hold but operators may not read: PSP API keys,
 * webhook secrets, card references.
 *
 * @remarks Format `v1:<iv>:<tag>:<ciphertext>` (base64url). The version prefix is what
 * makes a future algorithm migration possible without guessing at payload shapes, and the
 * tag is verified before a single plaintext byte is returned — GCM without its check is
 * just obfuscation with a failure mode that accepts tampered data.
 */
@Injectable()
export class EncryptionService {
  constructor(@Inject(ENCRYPTION_CONFIG) private readonly config: EncryptionConfig) {}

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.config.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const [version, ivRaw, tagRaw, dataRaw, ...extra] = payload.split(':');
    if (version !== VERSION || !ivRaw || !tagRaw || !dataRaw || extra.length > 0) {
      throw new DecryptionError('unrecognized payload format');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, this.config.key, Buffer.from(ivRaw, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataRaw, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key or tampered ciphertext: GCM raises on both, and neither is worth
      // distinguishing to a caller — both mean "this value is not yours to read".
      throw new DecryptionError('authentication failed (wrong key or tampered data)');
    }
  }

  /**
   * A deterministic, one-way digest for lookups ("where is this token stored?") — the
   * case where `encrypt` is the wrong tool, because searching by ciphertext requires
   * encrypting with the same IV, and reusing an IV breaks GCM.
   */
  fingerprint(value: string): string {
    return createHash('sha256')
      .update(this.config.key)
      .update(value, 'utf8')
      .digest('hex');
  }
}
