export const OUTBOX_CONFIG = Symbol('OUTBOX_CONFIG');
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
export const OUTBOX_RELAY = Symbol('OUTBOX_RELAY');
export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');

export interface OutboxConfig {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  retentionHours: number;
}