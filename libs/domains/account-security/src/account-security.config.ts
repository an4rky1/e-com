import { z } from 'zod';
import {
  envBoolean,
  envInt,
  readNamespacedEnv,
  resolveModuleConfig,
} from '@auth/platform/config';
import { Defaults as RiskDefaults, type RiskScoringPolicy } from './domain/services/risk-scoring.service';

export const ACCOUNT_SECURITY_PRISMA = Symbol('ACCOUNT_SECURITY_PRISMA');
export const ACCOUNT_SECURITY_REDIS = Symbol('ACCOUNT_SECURITY_REDIS');
export const ACCOUNT_SECURITY_CONFIG = Symbol('ACCOUNT_SECURITY_CONFIG');

export const Defaults = {
  /**
   * Five failed attempts.
   *
   * @remarks Matches credential-vault's budget on purpose. Both numbers answer "how many wrong
   * passwords before we stop", and two different values would mean a user could be refused by
   * one service and admitted by the other for the same run of guesses — which is exactly the
   * kind of inconsistency that turns into a support ticket nobody can reproduce.
   */
  MAX_FAILED_ATTEMPTS: 5,
  /**
   * Twenty failures from one address.
   *
   * @remarks Higher than the per-account budget because the two attacks are different shapes.
   * An attacker who reached every account at five would lock the whole system; at twenty the
   * script has spent twenty guesses per address before anything happens, which is expensive
   * enough to be a bad trade.
   */
  MAX_IP_FAILED_ATTEMPTS: 20,
  /** 15 minutes. Long enough to stop a run, short enough that a real user is not stranded. */
  LOCKOUT_SEC: 900,
  /**
   * 24 hours.
   *
   * @remarks How long a run of failures stays "a run". Long enough that a patient attacker
   * spaced over a day still trips it, short enough that a user who mistypes three passwords
   * on Monday is not still being scored as an attack on Tuesday.
   */
  FAILURE_WINDOW_SEC: 86_400,
  IMPOSSIBLE_TRAVEL_KM: RiskDefaults.IMPOSSIBLE_TRAVEL_KM,
  RAPID_FAILURE_THRESHOLD: RiskDefaults.RAPID_FAILURE_THRESHOLD,
  UNUSUAL_HOUR_FROM: RiskDefaults.UNUSUAL_HOUR_FROM,
  UNUSUAL_HOUR_TO: RiskDefaults.UNUSUAL_HOUR_TO,
  USUAL_HOUR_SAMPLE_SIZE: RiskDefaults.USUAL_HOUR_SAMPLE_SIZE,
  /** 30 days — a device list that never forgets is a device list nobody reads. */
  DEVICE_RETENTION_DAYS: 30,
  LOGIN_HISTORY_PAGE_SIZE: 50,
  MAX_LOGIN_HISTORY_PAGE_SIZE: 200,
} as const;

/**
 * account-security's own configuration namespace.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that could
 * reconfigure its own connection would make "one service, one database" unenforceable. The Redis
 * url is the exception that proves it — Redis is a shared cache and rate-limit store, not this
 * service's data, and every key it writes is namespaced per account.
 */
export const accountSecuritySchema = z.object({
  MAX_FAILED_ATTEMPTS: envInt(Defaults.MAX_FAILED_ATTEMPTS, { min: 1, max: 100 }),
  MAX_IP_FAILED_ATTEMPTS: envInt(Defaults.MAX_IP_FAILED_ATTEMPTS, { min: 1, max: 10_000 }),
  LOCKOUT_SEC: envInt(Defaults.LOCKOUT_SEC, { min: 30, max: 86_400 }),
  FAILURE_WINDOW_SEC: envInt(Defaults.FAILURE_WINDOW_SEC, { min: 60, max: 2_592_000 }),
  IMPOSSIBLE_TRAVEL_KM: envInt(Defaults.IMPOSSIBLE_TRAVEL_KM, { min: 1, max: 20_000 }),
  RAPID_FAILURE_THRESHOLD: envInt(Defaults.RAPID_FAILURE_THRESHOLD, { min: 1, max: 100 }),
  UNUSUAL_HOUR_FROM: envInt(Defaults.UNUSUAL_HOUR_FROM, { min: 0, max: 23 }),
  UNUSUAL_HOUR_TO: envInt(Defaults.UNUSUAL_HOUR_TO, { min: 1, max: 24 }),
  USUAL_HOUR_SAMPLE_SIZE: envInt(Defaults.USUAL_HOUR_SAMPLE_SIZE, { min: 1, max: 500 }),
  DEVICE_RETENTION_DAYS: envInt(Defaults.DEVICE_RETENTION_DAYS, { min: 1, max: 3_650 }),
  LOGIN_HISTORY_PAGE_SIZE: envInt(Defaults.LOGIN_HISTORY_PAGE_SIZE, { min: 1, max: 1_000 }),
  MAX_LOGIN_HISTORY_PAGE_SIZE: envInt(Defaults.MAX_LOGIN_HISTORY_PAGE_SIZE, { min: 1, max: 5_000 }),
  /**
   * Whether the rate counters go to Redis at all.
   *
   * @remarks On by default and still fail-safe when it is off: the store becomes a no-op and
   * the counters read back as zero. That is a worse product — no lockout, no per-ip limit —
   * but it is a *documented* degradation rather than an outage, which is the right way round.
   * Turning it off silently by accident is what the boot log below prevents.
   */
  CACHE_ENABLED: envBoolean(true),
  REDIS_URL: z.string().optional(),
  REDIS_KEY_PREFIX: z.string().default('account-security'),
});

export type AccountSecurityEnvConfig = z.infer<typeof accountSecuritySchema>;

/** Everything the handlers need to know about policy. Nothing else reads the environment. */
export interface AccountSecurityConfig {
  maxFailedAttempts: number;
  maxIpFailedAttempts: number;
  lockoutSec: number;
  failureWindowSec: number;
  deviceRetentionDays: number;
  loginHistoryPageSize: number;
  maxLoginHistoryPageSize: number;
  cacheEnabled: boolean;
  redisUrl: string | null;
  redisKeyPrefix: string;
  riskScoring: RiskScoringPolicy;
}

/**
 * Reads `ACCOUNT_SECURITY_*` into the shape the handlers take.
 *
 * @remarks Separate from the schema so a test can build an `AccountSecurityConfig` literally,
 * without an environment. The `resolveModuleConfig` call is there for the same reason it is in
 * the other services: keys that are present but `undefined` fall through instead of pinning a
 * value to `undefined`, which is a bug that only shows up in the one deployment that sets the
 * variable to an empty string.
 */
export function resolveAccountSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
): AccountSecurityConfig {
  const parsed = readNamespacedEnv('ACCOUNT_SECURITY', accountSecuritySchema, env);

  const unusualHourFrom = Math.min(parsed.UNUSUAL_HOUR_FROM, parsed.UNUSUAL_HOUR_TO - 1);

  return resolveModuleConfig(
    {
      maxFailedAttempts: parsed.MAX_FAILED_ATTEMPTS,
      maxIpFailedAttempts: parsed.MAX_IP_FAILED_ATTEMPTS,
      lockoutSec: parsed.LOCKOUT_SEC,
      failureWindowSec: parsed.FAILURE_WINDOW_SEC,
      deviceRetentionDays: parsed.DEVICE_RETENTION_DAYS,
      loginHistoryPageSize: Math.min(
        parsed.LOGIN_HISTORY_PAGE_SIZE,
        parsed.MAX_LOGIN_HISTORY_PAGE_SIZE,
      ),
      maxLoginHistoryPageSize: parsed.MAX_LOGIN_HISTORY_PAGE_SIZE,
      cacheEnabled: parsed.CACHE_ENABLED,
      redisUrl: parsed.REDIS_URL?.trim() || null,
      redisKeyPrefix: parsed.REDIS_KEY_PREFIX,
      riskScoring: {
        rapidFailureThreshold: parsed.RAPID_FAILURE_THRESHOLD,
        ipFailureThreshold: parsed.MAX_IP_FAILED_ATTEMPTS,
        impossibleTravelKm: parsed.IMPOSSIBLE_TRAVEL_KM,
        unusualHourFrom,
        unusualHourTo: parsed.UNUSUAL_HOUR_TO,
        usualHourSampleSize: parsed.USUAL_HOUR_SAMPLE_SIZE,
        stepUpAt: RiskDefaults.STEP_UP_AT,
        notifyAt: RiskDefaults.NOTIFY_AT,
        refuseAt: RiskDefaults.REFUSE_AT,
      },
    },
    {},
  );
}