/**
 * @fileoverview Storage port for audit records.
 *
 * @remarks Declared in the domain and implemented in infrastructure so a record can ask to be
 * persisted without knowing that Postgres exists — and so the chain tests can use a plain
 * in-memory implementation instead of a database.
 *
 * @remarks `append` returns whether the record was *newly* written rather than throwing on a
 * duplicate. Both answers are legitimate, and a caller that has to catch an exception to learn
 * "you already have this" tends to catch too much.
 */
import type { AuditEvent } from '../audit-event.aggregate';
import type { ChainedRecord, ChainVerification } from '../audit-chain';

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');

/** Every filter is optional; an absent one matches everything. */
export interface AuditFilter {
  actorId?: string;
  actorType?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  result?: string;
  /** Inclusive lower bound on `occurred_at`. */
  from?: Date;
  /** Exclusive upper bound on `occurred_at`, so adjacent windows do not double-count. */
  to?: Date;
}

export interface AuditPage {
  readonly records: readonly AuditEvent[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

export interface AuditRepositoryPort {
  /**
   * Appends one record and advances its partition's head.
   *
   * @remarks Must be atomic: the record, its hash and the head update commit together or not
   * at all. A record written without its head leaves a partition whose verification ends at
   * the wrong record forever, and a head advanced without its record leaves a gap that
   * verification cannot distinguish from deletion.
   *
   * @remarks Must be serialised per partition. Two writers that both read head hash H and both
   * append H+1 produce two records at sequence N+1, and whichever commits second silently
   * rewrites the first's chain.
   */
  append(event: AuditEvent): Promise<AppendOutcome>;

  search(filter: AuditFilter, page: number, limit: number): Promise<AuditPage>;

  /**
   * Reads one partition in chain order.
   *
   * @remarks `sequence` order specifically, not `occurred_at`: the producer controls the
   * event time and two records can legitimately share it, so ordering by it would make the
   * chain's own sequence disagree with the order it is read in.
   */
  readPartition(partitionKey: string, limit?: number): Promise<ChainedRecord[]>;

  /** Every partition key that has a record, for "verify everything" sweeps. */
  partitionKeys(limit?: number): Promise<string[]>;

  /** Verifies one partition against its stored head. */
  verify(partitionKey: string, limit?: number): Promise<ChainVerification>;

  /** Total records. Probed by the health indicator: "can I read the log" is the real question. */
  count(): Promise<number>;
}

/**
 * What `append` did.
 *
 * @remarks `UNSUPPORTED_PARTITION` is not a silent success. A partition key the implementation
 * refuses to chain would otherwise be stored as an unchained row, and verification would skip
 * it forever — the worst outcome available, because it looks like a clean log.
 */
export const AppendOutcome = {
  APPENDED: 'appended',
  /** The same record id is already stored. A retried append, not a new fact. */
  DUPLICATE: 'duplicate',
  UNSUPPORTED_PARTITION: 'unsupported_partition',
} as const;

export type AppendOutcome = (typeof AppendOutcome)[keyof typeof AppendOutcome];