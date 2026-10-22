import { z } from 'zod';
import { readNamespacedEnv, resolveModuleConfig, envBoolean, envInt, envString } from '@auth/platform/config';
import { RECOVERY_CODE_COUNT_MAX } from './domain/value-objects/recovery-code.vo';
import { PASSWORD_MIN_LENGTH_FLOOR } from './domain/value-objects/password-policy.vo';
import { ARGON2_VERSION, type HashParameters } from './domain/ports/password-hasher.port';

export const VAULT_PRISMA = Symbol('VAULT_PRISMA');
export const VAULT_CONFIG = Symbol('VAULT_CONFIG');

export const Defaults = {
  /**
   * 64 MiB, three passes, one lane.
   *
   * @remarks Memory is the term that makes Argon2 expensive to attack, and the OWASP floor is
   * 19 MiB — this is deliberately well above it, because the whole point of the cost is that
   * it hurts an offline attacker far more than it hurts a sign-in. Parallelism is 1, not the
   * library's default of 4: lanes buy throughput at a cost in total CPU, and this service
   * wants the *slowest* per-hash cost that is still tolerable, not the best hash-per-second.
   */
  ARGON2_MEMORY_COST: 65_536,
  ARGON2_TIME_COST: 3,
  ARGON2_PARALLELISM: 1,
  ARGON2_HASH_LENGTH: 32,
  /**
   * Five wrong passwords.
   *
   * @remarks Low enough that a fat-fingered user recovers on their own, high enough that an
   * online guessing run costs the attacker a full Argon2 budget per five attempts.
   */
  MAX_FAILED_ATTEMPTS: 5,
  /** 15 minutes — long enough to stop a run, short enough that the user is not locked out. */
  LOCKOUT_SEC: 900,
  RECOVERY_CODE_COUNT: 10,
  MIN_PASSWORD_LENGTH: PASSWORD_MIN_LENGTH_FLOOR,
  /**
   * Whether a password below the current Argon2 policy is transparently upgraded on use.
   *
   * @remarks On by default: rehashing costs one hash on a request that is already paying for
   * one, and it is the only way a parameter bump ever reaches the hashes already on disk.
   */
  ALLOW_REHASH: true,
} as const;

/**
 * credential-vault's own configuration namespace.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database" unenforceable.
 */
export const credentialVaultSchema = z.object({
  /**
   * The pepper, optional.
   *
   * @remarks Deliberately not `envSecret`: refusing to boot would take down every sign-in for
   * a deployment that is otherwise fine, and Argon2id on its own is a defensible
   * configuration. What a missing pepper costs is spelled out at boot by the module factory,
   * because a secret that silently evaluates to empty is the same as no secret at all and
   * nobody would notice until a dump of the table was in someone else's hands.
   */
  PEPPER: z.string().optional(),
  ARGON2_MEMORY_COST: envInt(Defaults.ARGON2_MEMORY_COST, { min: 8_192, max: 262_144 }),
  ARGON2_TIME_COST: envInt(Defaults.ARGON2_TIME_COST, { min: 1, max: 16 }),
  ARGON2_PARALLELISM: envInt(Defaults.ARGON2_PARALLELISM, { min: 1, max: 16 }),
  ARGON2_HASH_LENGTH: envInt(Defaults.ARGON2_HASH_LENGTH, { min: 16, max: 128 }),
  MAX_FAILED_ATTEMPTS: envInt(Defaults.MAX_FAILED_ATTEMPTS, { min: 1, max: 100 }),
  LOCKOUT_SEC: envInt(Defaults.LOCKOUT_SEC, { min: 30, max: 86_400 }),
  RECOVERY_CODE_COUNT: envInt(Defaults.RECOVERY_CODE_COUNT, { min: 1, max: RECOVERY_CODE_COUNT_MAX }),
  MIN_PASSWORD_LENGTH: envInt(Defaults.MIN_PASSWORD_LENGTH, {
    min: PASSWORD_MIN_LENGTH_FLOOR,
    max: 128,
  }),
  ALLOW_REHASH: envBoolean(Defaults.ALLOW_REHASH),
  /** Identifier written on a password credential when the caller does not supply one. */
  DEFAULT_IDENTIFIER: envString('password'),
});

export type CredentialVaultEnvConfig = z.infer<typeof credentialVaultSchema>;

export interface CredentialVaultConfig {
  /** `null` when `VAULT_PEPPER` is unset — see the note on the schema field. */
  pepper: string | null;
  argon2: HashParameters;
  maxFailedAttempts: number;
  lockoutSec: number;
  recoveryCodeCount: number;
  minPasswordLength: number;
  allowRehash: boolean;
  defaultIdentifier: string;
}

/**
 * Reads `VAULT_*` into the shape the handlers take.
 *
 * @remarks Separate from the schema so that a test can build a `CredentialVaultConfig`
 * literally, without an environment. Everything the handlers need to know about policy is in
 * this object — nothing in the application layer reads `process.env` itself.
 *
 * @remarks The Argon2 version is *not* configurable: `0x13` is the only version the
 * `argon2id` encoding in `secret_hash` can express, so a setting that appeared to choose
 * another one would produce hashes this service could not read back.
 */
export function resolveCredentialVaultConfig(
  env: NodeJS.ProcessEnv = process.env,
): CredentialVaultConfig {
  const parsed = readNamespacedEnv('VAULT', credentialVaultSchema, env);

  return resolveModuleConfig(
    {
      pepper: parsed.PEPPER?.trim() || null,
      argon2: {
        algorithm: 'argon2id',
        memoryCost: parsed.ARGON2_MEMORY_COST,
        timeCost: parsed.ARGON2_TIME_COST,
        parallelism: parsed.ARGON2_PARALLELISM,
        hashLength: parsed.ARGON2_HASH_LENGTH,
        version: ARGON2_VERSION,
      },
      maxFailedAttempts: parsed.MAX_FAILED_ATTEMPTS,
      lockoutSec: parsed.LOCKOUT_SEC,
      recoveryCodeCount: parsed.RECOVERY_CODE_COUNT,
      minPasswordLength: parsed.MIN_PASSWORD_LENGTH,
      allowRehash: parsed.ALLOW_REHASH,
      defaultIdentifier: parsed.DEFAULT_IDENTIFIER,
    },
    {},
  );
}