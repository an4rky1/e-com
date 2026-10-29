import type { RecoveryMode } from './saga.config';

export const SAGA_CONFIG = Symbol('SAGA_CONFIG');
export const SAGA_STORE = Symbol('SAGA_STORE');

export interface SagaConfig {
  enabled: boolean;
  stepTimeoutMs: number;
  stepMaxAttempts: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  recoveryIntervalMs: number;
  staleAfterMs: number;
  retentionHours: number;
  recoveryMode: RecoveryMode;
}
