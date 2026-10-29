import { z } from 'zod';
import { envBoolean, envInt, envString } from '@auth/platform/config';

export const ENV_PREFIX = 'SAGA';

export const SagaStatus = {
  RUNNING: 'running',
  COMPENSATING: 'compensating',
  COMPLETED: 'completed',
  COMPENSATED: 'compensated',
  FAILED: 'failed',
} as const;

export type SagaStatus = (typeof SagaStatus)[keyof typeof SagaStatus];

export const TerminalStatuses: readonly SagaStatus[] = [
  SagaStatus.COMPLETED,
  SagaStatus.COMPENSATED,
  SagaStatus.FAILED,
];

export function isTerminal(status: SagaStatus): boolean {
  return TerminalStatuses.includes(status);
}

/**
 * How an interrupted saga is finished after the process that owned it died.
 *
 * `resume` re-executes the failed step (every step must be idempotent) and continues;
 * `compensate` unwinds what has already run. `resume` is the default because a half-applied
 * forward step is usually cheaper to finish than to undo, and because compensation of a step
 * whose forward effect never landed is at best a no-op and at worst a second write.
 */
export const RecoveryMode = {
  RESUME: 'resume',
  COMPENSATE: 'compensate',
} as const;

export type RecoveryMode = (typeof RecoveryMode)[keyof typeof RecoveryMode];

export const Defaults = {
  STEP_TIMEOUT_MS: 30_000,
  STEP_MAX_ATTEMPTS: 3,
  BASE_RETRY_DELAY_MS: 1_000,
  MAX_RETRY_DELAY_MS: 60_000,
  RECOVERY_INTERVAL_MS: 60_000,
  STALE_AFTER_MS: 300_000,
  RETENTION_HOURS: 24,
  ENABLED: true,
  RECOVERY_MODE: RecoveryMode.RESUME,
} as const;

export const sagaSchema = z.object({
  ENABLED: envBoolean(Defaults.ENABLED).describe('Enable the recovery sweeper'),
  STEP_TIMEOUT_MS: envInt(Defaults.STEP_TIMEOUT_MS, { min: 100 }).describe(
    'Budget for one step execution or compensation before it is abandoned',
  ),
  STEP_MAX_ATTEMPTS: envInt(Defaults.STEP_MAX_ATTEMPTS, { min: 1, max: 20 }).describe(
    'Attempts per step before the saga compensates',
  ),
  BASE_RETRY_DELAY_MS: envInt(Defaults.BASE_RETRY_DELAY_MS, { min: 10 }).describe(
    'First backoff delay between step attempts; doubles per attempt',
  ),
  MAX_RETRY_DELAY_MS: envInt(Defaults.MAX_RETRY_DELAY_MS, { min: 1_000 }).describe(
    'Backoff ceiling',
  ),
  RECOVERY_INTERVAL_MS: envInt(Defaults.RECOVERY_INTERVAL_MS, {
    min: 1_000,
  }).describe('How often interrupted sagas are swept'),
  STALE_AFTER_MS: envInt(Defaults.STALE_AFTER_MS, { min: 1_000 }).describe(
    'An in-flight saga untouched for this long is considered interrupted',
  ),
  RETENTION_HOURS: envInt(Defaults.RETENTION_HOURS, { min: 1 }).describe(
    'How long terminal instances are kept for inspection',
  ),
  RECOVERY_MODE: envString(Defaults.RECOVERY_MODE).describe(
    'resume | compensate — what recovery does to an interrupted saga',
  ),
});

export type SagaEnvConfig = z.infer<typeof sagaSchema>;

export function toRecoveryMode(value: string): RecoveryMode {
  const normalised = value.trim().toLowerCase();
  const match = (Object.values(RecoveryMode) as string[]).includes(normalised);
  if (!match) {
    throw new Error(
      `SAGA_RECOVERY_MODE must be one of ${Object.values(RecoveryMode).join(', ')}; received "${value}"`,
    );
  }
  return normalised as RecoveryMode;
}

/**
 * Exponential backoff with full jitter.
 *
 * @remarks Copied in spirit from the outbox: without jitter every step that failed during a
 * dependency outage retries at the same instant when the dependency returns.
 */
export function calculateBackoff(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  const capped = Math.min(baseMs * 2 ** Math.max(attempts, 0), maxMs);
  return Math.floor(capped / 2 + Math.random() * (capped / 2));
}
