/**
 * @fileoverview The read side: what happened, and can the record of it be trusted.
 *
 * @remarks Two questions, and they are genuinely different. `SearchAuditEvents` answers "what
 * happened"; `VerifyAuditChain` answers "can that be believed". An audit UI that shows only the
 * first is a list somebody can edit.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import {
  AUDIT_REPOSITORY,
  type AuditFilter,
  type AuditRepositoryPort,
} from '../../domain/ports/audit-repository.port';
import type { AuditEvent } from '../../domain/audit-event.aggregate';
import type { ChainVerification } from '../../domain/audit-chain';
import { AUDIT_LOG_CONFIG, type AuditLogConfig } from '../../audit-log.config';

/**
 * Projection of a record for callers.
 *
 * @remarks A distinct type rather than returning `AuditEvent` itself: the aggregate's job is
 * to be hashable, and a caller that could reach `link` could also reach `previousHash` and
 * start reasoning about chain internals it has no business touching.
 */
export interface AuditEventReadModel {
  id: string;
  partitionKey: string;
  sequence: number;
  occurredAt: Date;
  receivedAt: Date;
  actorId: string;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
  ipAddress: string | null;
  userAgent: string | null;
  payload: Record<string, unknown>;
  traceId: string;
}

export const toReadModel = (event: AuditEvent): AuditEventReadModel => ({
  id: event.id,
  partitionKey: event.partitionKey,
  sequence: event.sequence,
  occurredAt: event.occurredAt,
  receivedAt: event.receivedAt,
  actorId: event.actorId,
  actorType: event.actorType,
  action: event.action,
  resourceType: event.resourceType,
  resourceId: event.resourceId,
  result: event.result,
  ipAddress: event.ipAddress,
  userAgent: event.userAgent,
  payload: { ...event.payload },
  traceId: event.traceId,
});

export interface PagedAuditEvents {
  data: AuditEventReadModel[];
  total: number;
  page: number;
  limit: number;
}

export class SearchAuditEventsQuery extends Query<PagedAuditEvents> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly filter: AuditFilter,
    readonly page?: number,
    readonly limit?: number,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(SearchAuditEventsQuery)
export class SearchAuditEventsHandler
  implements IQueryHandler<SearchAuditEventsQuery, PagedAuditEvents>
{
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepositoryPort,
    @Inject(AUDIT_LOG_CONFIG) private readonly config: AuditLogConfig,
  ) {}

  async execute(query: SearchAuditEventsQuery): Promise<PagedAuditEvents> {
    const filter = query.filter;
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(
      Math.max(query.limit ?? this.config.defaultPageSize, 1),
      this.config.maxPageSize,
    );

    if (filter.from && filter.to && filter.from.getTime() > filter.to.getTime()) {
      // A silently empty result set for an inverted range reads as "nothing happened in that
      // window", which is the most dangerous answer this endpoint can give.
      throw new ValidationException('`from` must not be later than `to`', {
        from: filter.from.toISOString(),
        to: filter.to.toISOString(),
      });
    }

    const result = await this.audit.search(filter, page, limit);

    return {
      data: result.records.map(toReadModel),
      total: result.total,
      page,
      limit,
    };
  }
}

export interface VerifyAuditChainResult extends ChainVerification {
  /** Present when a single partition was verified; absent for a sweep. */
  readonly headHash?: string | null;
  /** How many partitions were walked. */
  readonly partitions: number;
}

export class VerifyAuditChainQuery extends Query<VerifyAuditChainResult> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly partitionKey?: string) {
    super();
  }
}

@Injectable()
@QueryHandler(VerifyAuditChainQuery)
export class VerifyAuditChainHandler
  implements IQueryHandler<VerifyAuditChainQuery, VerifyAuditChainResult>
{
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepositoryPort,
    @Inject(AUDIT_LOG_CONFIG) private readonly config: AuditLogConfig,
  ) {}

  /**
   * One partition, or a bounded sweep of every partition.
   *
   * @remarks The sweep is bounded twice — by `partitionKeys` and by `maxVerifyRecords` per
   * partition — because verification is O(records) and an unbounded walk is a way to make one
   * HTTP request hold a transaction open across the whole table. A sweep that ran out of
   * partitions reports `truncatedAt`, so "checked 100 and stopped" is never mistaken for
   * "checked everything and it is clean".
   */
  async execute(query: VerifyAuditChainQuery): Promise<VerifyAuditChainResult> {
    const keys = query.partitionKey
      ? [query.partitionKey]
      : await this.audit.partitionKeys(this.config.maxVerifyRecords);

    const reports = await Promise.all(
      keys.map((key) => this.audit.verify(key, this.config.maxVerifyRecords)),
    );

    // The first broken partition decides the answer. Reporting only the first is deliberate:
    // a sweep over a tampered log can have thousands of breaks, and a caller wants to know
    // that it is broken and where it starts, not a list of every row that moved.
    const broken = reports.find((report) => !report.ok);

    return {
      partitionKey: broken?.partitionKey ?? keys[0] ?? '',
      ok: reports.every((report) => report.ok),
      checked: reports.reduce((sum, report) => sum + report.checked, 0),
      brokenAt: broken?.brokenAt ?? null,
      reason: broken?.reason ?? null,
      truncatedAt: broken?.truncatedAt ?? null,
      partitions: reports.length,
    };
  }
}