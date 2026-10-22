/**
 * @fileoverview The `MFA_*` namespace.
 *
 * @remarks `process.env` appears in exactly one line of this library. Everything else takes a
 * resolved {@link MfaConfig}, which is what lets the suite build a policy — a window of 0, a
 * zero-second lockout — without mutating global state.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a service that
 * could point itself at another database would make "one service, one database" unenforceable,
 * and it would be enforceable only by convention.
 */

import { z } from 'zod';
import {
  envInt,
  envSecret,
  envString,
  readNamespacedEnv,
  resolveModuleConfig,
} from '@auth/platform/config';
import { TOTP_DIGITS, TOTP_PERIOD_SEC, TOTP_WINDOW } from './domain/value-objects/mfa-method.vo';
import type { MfaPolicy } from './domain/mfa-policy';

/** This service's own Prisma client. Never shared with another domain lib. */
export const MFA_PRISMA = Symbol('MFA_PRISMA');

/**
 * The two RFC 6238 parameters the engine is built with.
 *
 * @remarks Symbols rather than strings because a string token is a namespace every module
 * shares: `'periodSec'` in this service and another in the next collide silently, and the
 * failure mode is a TOTP secret that works for 30 seconds and then stops.
 */
export const MFA_TOTP_PERIOD_SEC = Symbol('MFA_TOTP_PERIOD_SEC');
export const MFA_TOTP_DIGITS = Symbol('MFA_TOTP_DIGITS');

/**
 * The resolved namespace, and the base64 AES-256 key the vault adapter holds.
 *
 * @remarks The key gets its own token rather than riding inside {@link MFA_CONFIG} so the
 * vault can depend on the secret alone: the moment a component can inject the whole config it
 * can inject the key, and the narrower the surface the harder it is to leak.
 */
export const MFA_CONFIG = Symbol('MFA_CONFIG');
export const MFA_SECRET_ENCRYPTION_KEY = Symbol('MFA_SECRET_ENCRYPTION_KEY');

export const Defaults = {
  TOTP_ISSUER: 'auth-platform',
  TOTP_PERIOD_SEC,
  TOTP_DIGITS,
  TOTP_WINDOW,
  /** How long an issued secret may wait for its confirmation. */
  ENROLLMENT_TTL_SEC: 600,
  MAX_FAILED_ATTEMPTS: 5,
  LOCKOUT_SEC: 300,
  RECOVERY_CODE_COUNT: 10,
} as const;

export const mfaSchema = z.object({
  TOTP_ISSUER: envString(Defaults.TOTP_ISSUER),
  TOTP_PERIOD_SEC: envInt(Defaults.TOTP_PERIOD_SEC, { min: 15, max: 300 }),
  TOTP_DIGITS: envInt(Defaults.TOTP_DIGITS, { min: 6, max: 10 }),
  TOTP_WINDOW: envInt(Defaults.TOTP_WINDOW, { min: 0, max: 5 }),
  ENROLLMENT_TTL_SEC: envInt(Defaults.ENROLLMENT_TTL_SEC, { min: 60, max: 86_400 }),
  MAX_FAILED_ATTEMPTS: envInt(Defaults.MAX_FAILED_ATTEMPTS, { min: 3, max: 20 }),
  LOCKOUT_SEC: envInt(Defaults.LOCKOUT_SEC, { min: 0, max: 3_600 }),
  RECOVERY_CODE_COUNT: envInt(Defaults.RECOVERY_CODE_COUNT, { min: 4, max: 20 }),
  /**
   * 32 bytes, base64. No default, on purpose.
   *
   * @remarks A key that silently falls back to a known value is worse than a service that
   * refuses to boot: one is an outage, the other is a silent compromise of every factor in the
   * table. `envSecret` has no `.default()`, so omitting this stops the process at startup.
   */
  SECRET_ENCRYPTION_KEY: envSecret('MFA_SECRET_ENCRYPTION_KEY (32 bytes, base64)'),
});

export type MfaEnvConfig = z.infer<typeof mfaSchema>;

export interface MfaConfig {
  totpIssuer: string;
  totpPeriodSec: number;
  totpDigits: number;
  totpWindow: number;
  enrollmentTtlSec: number;
  maxFailedAttempts: number;
  lockoutSec: number;
  recoveryCodeCount: number;
  /** base64 of exactly 32 bytes. Held only by the vault adapter. */
  secretEncryptionKey: string;
}

/**
 * Reads `MFA_*` into a validated config.
 *
 * @remarks `env` is a parameter so a test never reaches into `process.env`, and so the same
 * resolver serves the boot path and a fixture.
 */
export function resolveMfaConfig(env: NodeJS.ProcessEnv = process.env): MfaConfig {
  const parsed = readNamespacedEnv('MFA', mfaSchema, env);

  return resolveModuleConfig(
    {
      totpIssuer: parsed.TOTP_ISSUER,
      totpPeriodSec: parsed.TOTP_PERIOD_SEC,
      totpDigits: parsed.TOTP_DIGITS,
      totpWindow: parsed.TOTP_WINDOW,
      enrollmentTtlSec: parsed.ENROLLMENT_TTL_SEC,
      maxFailedAttempts: parsed.MAX_FAILED_ATTEMPTS,
      lockoutSec: parsed.LOCKOUT_SEC,
      recoveryCodeCount: parsed.RECOVERY_CODE_COUNT,
      secretEncryptionKey: parsed.SECRET_ENCRYPTION_KEY,
    },
    {},
  );
}

/** The subset the aggregate needs, so it never sees a connection string or a TTL in seconds. */
export const toPolicy = (config: MfaConfig): MfaPolicy => ({
  window: config.totpWindow,
  maxFailedAttempts: config.maxFailedAttempts,
  lockoutMs: config.lockoutSec * 1_000,
});

/** Enrollment window in milliseconds — the unit {@link MfaFactor} is handed. */
export const enrollmentTtlMs = (config: MfaConfig): number =>
  config.enrollmentTtlSec * 1_000;