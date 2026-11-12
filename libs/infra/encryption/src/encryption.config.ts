import { z } from 'zod';
import { envSecret, readNamespacedEnv } from '@auth/platform/config';

export const ENCRYPTION_CONFIG = Symbol('ENCRYPTION_CONFIG');

const schema = z.object({
  /** 32 raw bytes, base64- or hex-encoded. No default: a fallback key is a backdoor. */
  KEY: envSecret('AES-256 key: 32 bytes encoded as base64 or hex'),
});

export type EncryptionEnvConfig = z.infer<typeof schema>;

export interface EncryptionConfig {
  key: Buffer;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX = /^[0-9a-fA-F]+$/;

function decodeKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (trimmed.length % 4 === 0 && BASE64.test(trimmed)) {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 32) return buf;
  }
  if (trimmed.length === 64 && HEX.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  return null;
}

/**
 * encryption's own configuration namespace, failing boot on a missing or short key.
 *
 * @remarks Unlike Redis-backed features, which degrade with a warning, a module that
 * cannot decrypt its own data has no degraded mode: reading ciphertext as plaintext or
 * silently skipping encryption is worse than refusing to start. The check lives here —
 * at config resolution — so the error surfaces before the first provider instantiates,
 * naming the variable rather than the call site that eventually tripped over it.
 */
export function resolveEncryptionConfig(env: NodeJS.ProcessEnv = process.env): EncryptionConfig {
  const parsed = readNamespacedEnv('ENCRYPTION', schema, env);
  const key = decodeKey(parsed.KEY);
  if (key === null) {
    throw new Error(
      'ENCRYPTION_KEY must encode exactly 32 bytes (64 hex chars or base64 of 32 bytes)',
    );
  }
  return { key };
}
