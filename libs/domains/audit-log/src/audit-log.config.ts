/**
 * @fileoverview The audit-log service's configuration namespace.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database" unenforceable.
 *
 * @remarks `resolveAuditLogConfig` is deliberately separate from the schema so a test can build
 * an {@link AuditLogConfig} literally. Nothing in the application or domain layer reads
 * `process.env` itself — every value it needs is on this object.
 */
import {
  envBoolean,
  envInt,
  envString,
  readNamespacedEnv,
  resolveModuleConfig,
} from '@auth/platform/config';
import { z } from 'zod';
import { MAX_PAGE_SIZE } from '@auth/contracts/http/api';

/** DI token for this service's own Prisma client, separate from any platform-wide binding. */
export const AUDIT_LOG_PRISMA = Symbol('AUDIT_LOG_PRISMA');

/** DI token for the resolved {@link AuditLogConfig}. */
export const AUDIT_LOG_CONFIG = Symbol('AUDIT_LOG_CONFIG');

export const Defaults = {
  /**
   * Ceiling on `SearchAuditEvents`.
   *
   * @remarks An audit table grows without bound and the operator query is the one that reads
   * the most of it, so an unbounded `limit` here is a denial of service that only surfaces
   * once the table is big — which is exactly when somebody is relying on it.
   */
  MAX_PAGE_SIZE,
  /**
   * Default page size when a caller does not pass one.
   *
   * @remarks Small on purpose. An operator opening a dashboard wants the newest slice, and a
   * large default is how a browser tab starts rendering a million rows.
   */
  DEFAULT_PAGE_SIZE: 50,
  /**
   * How long a consumer claim survives before it may be reclaimed.
   *
   * @remarks A claim is taken *before* the record is appended and released if the append
   * fails, so the normal path never depends on this. It exists for the abnormal path: a pod
   * killed between claiming and releasing leaves the claim behind, and without an expiry the
   * event is stuck forever and never audited.
   */
  CLAIM_TTL_SEC: 900,
  /**
   * Whether malformed payloads are dead-lettered to `${topic}.dlq`.
   *
   * @remarks On by default. A poison message that is neither retried nor dead-lettered either
   * blocks its partition forever or is silently dropped, and "a security event nobody knows
   * was lost" is a worse failure than "a security event on a topic somebody reads".
   */
  DEAD_LETTER_ENABLED: true,
  /**
   * Ceiling on how many records a single chain verification will recompute.
   *
   * @remarks Verification is O(partition length), so an unbounded walk over a long-lived
   * per-actor partition would let one HTTP request hold a transaction open for minutes. The
   * cap is reported back in the result rather than applied silently, so a truncated
   * verification is never mistaken for a clean one.
   */
  MAX_VERIFY_RECORDS: 10_000,
  /** `actor`: one chain per actor, forever. See {@link PartitionStrategy}. */
  PARTITION_STRATEGY: 'actor',
} as const;

export const auditLogSchema = z.object({
  MAX_PAGE_SIZE: envInt(Defaults.MAX_PAGE_SIZE, { min: 1, max: 5_000 }),
  DEFAULT_PAGE_SIZE: envInt(Defaults.DEFAULT_PAGE_SIZE, { min: 1, max: 5_000 }),
  CLAIM_TTL_SEC: envInt(Defaults.CLAIM_TTL_SEC, { min: 30, max: 86_400 }),
  DEAD_LETTER_ENABLED: envBoolean(Defaults.DEAD_LETTER_ENABLED),
  MAX_VERIFY_RECORDS: envInt(Defaults.MAX_VERIFY_RECORDS, { min: 1, max: 1_000_000 }),
  /** `actor` chains per actor; `day` chains per actor per UTC day. See the domain docs. */
  PARTITION_STRATEGY: envString(Defaults.PARTITION_STRATEGY),
});

export type AuditLogEnvConfig = z.infer<typeof auditLogSchema>;

/** How a partition key is derived from a record's actor. */
export const PartitionStrategy = {
  /** One chain per actor, forever. Best tamper evidence; unbounded chain length. */
  ACTOR: 'actor',
  /** One chain per actor per UTC day. Bounded chains; the day boundary splits a history. */
  ACTOR_DAY: 'actor_day',
} as const;

export type PartitionStrategy = (typeof PartitionStrategy)[keyof typeof PartitionStrategy];

export interface AuditLogConfig {
  maxPageSize: number;
  defaultPageSize: number;
  claimTtlSec: number;
  deadLetterEnabled: boolean;
  maxVerifyRecords: number;
  partitionStrategy: PartitionStrategy;
}

/**
 * Reads `AUDIT_*` into the shape the handlers take.
 *
 * @remarks `PARTITION_STRATEGY` is validated rather than cast. A typo would otherwise resolve
 * to `undefined`, match no branch in the partition key builder, and silently produce a chain
 * keyed on `undefined` — every record sharing one chain and the per-actor guarantee quietly
 * gone.
 */
export function resolveAuditLogConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuditLogConfig {
  const parsed = readNamespacedEnv('AUDIT', auditLogSchema, env);

  const defaults: AuditLogConfig = {
    maxPageSize: Defaults.MAX_PAGE_SIZE,
    defaultPageSize: Defaults.DEFAULT_PAGE_SIZE,
    claimTtlSec: Defaults.CLAIM_TTL_SEC,
    deadLetterEnabled: Defaults.DEAD_LETTER_ENABLED,
    maxVerifyRecords: Defaults.MAX_VERIFY_RECORDS,
    partitionStrategy: Defaults.PARTITION_STRATEGY,
  };

  return resolveModuleConfig(defaults, {
    maxPageSize: parsed.MAX_PAGE_SIZE,
    defaultPageSize: parsed.DEFAULT_PAGE_SIZE,
    claimTtlSec: parsed.CLAIM_TTL_SEC,
    deadLetterEnabled: parsed.DEAD_LETTER_ENABLED,
    maxVerifyRecords: parsed.MAX_VERIFY_RECORDS,
    partitionStrategy: toPartitionStrategy(parsed.PARTITION_STRATEGY),
  });
}

function toPartitionStrategy(value: string): PartitionStrategy {
  const normalised = value.trim().toLowerCase();
  const match = (Object.values(PartitionStrategy) as string[]).includes(normalised);

  if (!match) {
    throw new Error(
      `AUDIT_PARTITION_STRATEGY must be one of ${Object.values(PartitionStrategy).join(', ')}; received "${value}"`,
    );
  }

  return normalised as PartitionStrategy;
}