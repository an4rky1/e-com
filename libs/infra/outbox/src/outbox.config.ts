import { z } from 'zod';
import { envBoolean, envInt } from '@auth/platform/config';

export const ENV_PREFIX = 'OUTBOX';

export const OutboxStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  PUBLISHED: 'published',
  FAILED: 'failed',
  DLQ: 'dlq',
} as const;

export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export const Defaults = {
  POLL_INTERVAL_MS: 1_000,
  BATCH_SIZE: 100,
  MAX_RETRIES: 5,
  BASE_RETRY_DELAY_MS: 1_000,
  MAX_RETRY_DELAY_MS: 60_000,
  RETENTION_HOURS: 24,
  ENABLED: true,
} as const;

export const outboxSchema = z.object({
  ENABLED: envBoolean(Defaults.ENABLED).describe('Enable the outbox relay'),
  POLL_INTERVAL_MS: envInt(Defaults.POLL_INTERVAL_MS, { min: 50 }).describe(
    'Base interval between relay polls when the backlog is small',
  ),
  BATCH_SIZE: envInt(Defaults.BATCH_SIZE, { min: 1, max: 1_000 }).describe(
    'Maximum events claimed per poll',
  ),
  MAX_RETRIES: envInt(Defaults.MAX_RETRIES, { min: 1, max: 20 }).describe(
    'Attempts before an event is moved to the dead-letter table',
  ),
  BASE_RETRY_DELAY_MS: envInt(Defaults.BASE_RETRY_DELAY_MS, { min: 100 }).describe(
    'First backoff delay; doubles per attempt',
  ),
  MAX_RETRY_DELAY_MS: envInt(Defaults.MAX_RETRY_DELAY_MS, { min: 1_000 }).describe(
    'Backoff ceiling',
  ),
  RETENTION_HOURS: envInt(Defaults.RETENTION_HOURS, { min: 1 }).describe(
    'How long published rows are kept for inspection',
  ),
});

export type OutboxEnvConfig = z.infer<typeof outboxSchema>;

export interface OutboxRecord {
  id: string;
  topic: string;
  partitionKey: string;
  /** Serialised {@link import('@auth/contracts').IntegrationEvent}. */
  payload: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  traceId?: string;
  lastError?: string;
  createdAt: Date;
  publishedAt?: Date;
}

export interface AppendOptions {
  topic: string;
  /** Id of the entity whose ordering matters. Defaults to the aggregate id. */
  partitionKey?: string;
  traceId?: string;
}

/**
 * Exponential backoff with full jitter.
 *
 * @remarks The jitter is not cosmetic. Without it, every event that failed during a broker
 * outage retries at the same instant when the broker returns, and the reconnect stampede
 * takes it down again.
 */
export function calculateBackoff(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  const capped = Math.min(baseMs * 2 ** Math.max(attempts, 0), maxMs);
  return Math.floor(capped / 2 + Math.random() * (capped / 2));
}