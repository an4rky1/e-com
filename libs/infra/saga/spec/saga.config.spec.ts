import {
  calculateBackoff,
  Defaults,
  isTerminal,
  RecoveryMode,
  SagaStatus,
  sagaSchema,
  toRecoveryMode,
} from '../src/saga.config';
import { readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';

describe('saga config', () => {
  it('parses an empty environment into the defaults', () => {
    const parsed = readNamespacedEnv('SAGA', sagaSchema, {});

    expect(parsed).toEqual({
      ENABLED: Defaults.ENABLED,
      STEP_TIMEOUT_MS: Defaults.STEP_TIMEOUT_MS,
      STEP_MAX_ATTEMPTS: Defaults.STEP_MAX_ATTEMPTS,
      BASE_RETRY_DELAY_MS: Defaults.BASE_RETRY_DELAY_MS,
      MAX_RETRY_DELAY_MS: Defaults.MAX_RETRY_DELAY_MS,
      RECOVERY_INTERVAL_MS: Defaults.RECOVERY_INTERVAL_MS,
      STALE_AFTER_MS: Defaults.STALE_AFTER_MS,
      RETENTION_HOURS: Defaults.RETENTION_HOURS,
      RECOVERY_MODE: Defaults.RECOVERY_MODE,
    });
  });

  it('honours SAGA_* overrides', () => {
    const parsed = readNamespacedEnv('SAGA', sagaSchema, {
      SAGA_ENABLED: 'false',
      SAGA_STEP_TIMEOUT_MS: '5000',
      SAGA_STEP_MAX_ATTEMPTS: '7',
      SAGA_RECOVERY_MODE: 'compensate',
    });

    expect(parsed.ENABLED).toBe(false);
    expect(parsed.STEP_TIMEOUT_MS).toBe(5_000);
    expect(parsed.STEP_MAX_ATTEMPTS).toBe(7);
    expect(parsed.RECOVERY_MODE).toBe('compensate');
  });

  it('refuses a step timeout below 100ms', () => {
    expect(() =>
      readNamespacedEnv('SAGA', sagaSchema, { SAGA_STEP_TIMEOUT_MS: '10' }),
    ).toThrow(/SAGA_STEP_TIMEOUT_MS/);
  });

  it('refuses a recovery mode it does not know', () => {
    expect(() => toRecoveryMode('restart')).toThrow(/SAGA_RECOVERY_MODE/);
  });

  it('accepts both recovery modes case-insensitively', () => {
    expect(toRecoveryMode('Resume')).toBe(RecoveryMode.RESUME);
    expect(toRecoveryMode('COMPENSATE')).toBe(RecoveryMode.COMPENSATE);
  });

  it('resolves module config with defaults under partial overrides', () => {
    const config = resolveModuleConfig(
      {
        enabled: true,
        stepTimeoutMs: 30_000,
        stepMaxAttempts: 3,
        baseRetryDelayMs: 1_000,
        maxRetryDelayMs: 60_000,
        recoveryIntervalMs: 60_000,
        staleAfterMs: 300_000,
        retentionHours: 24,
        recoveryMode: RecoveryMode.RESUME,
      },
      { stepMaxAttempts: 5 },
    );

    expect(config.stepMaxAttempts).toBe(5);
    expect(config.stepTimeoutMs).toBe(30_000);
    expect(config.recoveryMode).toBe(RecoveryMode.RESUME);
  });
});

describe('calculateBackoff', () => {
  it('stays within the jitter band [capped/2, capped]', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const capped = Math.min(1_000 * 2 ** attempt, 60_000);
      const delay = calculateBackoff(attempt, 1_000, 60_000);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(capped / 2));
      expect(delay).toBeLessThanOrEqual(capped);
    }
  });

  it('is capped by maxMs no matter how large the attempt count grows', () => {
    const delay = calculateBackoff(50, 1_000, 60_000);
    expect(delay).toBeLessThanOrEqual(60_000);
  });
});

describe('isTerminal', () => {
  it('treats only the settled statuses as terminal', () => {
    expect(isTerminal(SagaStatus.COMPLETED)).toBe(true);
    expect(isTerminal(SagaStatus.COMPENSATED)).toBe(true);
    expect(isTerminal(SagaStatus.FAILED)).toBe(true);
    expect(isTerminal(SagaStatus.RUNNING)).toBe(false);
    expect(isTerminal(SagaStatus.COMPENSATING)).toBe(false);
  });
});
