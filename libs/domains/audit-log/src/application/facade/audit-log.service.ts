/**
 * @fileoverview The single object the transport layer talks to.
 *
 * @remarks Thin on purpose. Every rule that belongs to this service — the claim, the chain, the
 * redaction boundary — is exercised through the handler and the processor regardless of which
 * caller gets here, so a facade that added logic would be the one piece of this service with
 * no test behind it.
 */
import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  toRecordAuditEventCommand,
  type RecordAuditEventInput,
} from '../commands/record-audit-event.command';
import {
  SearchAuditEventsQuery,
  VerifyAuditChainQuery,
  type PagedAuditEvents,
  type VerifyAuditChainResult,
} from '../queries/audit.queries';
import type { AuditFilter } from '../../domain/ports/audit-repository.port';

@Injectable()
export class AuditLogService {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Records one fact.
   *
   * @remarks Present for a caller that is not the Kafka consumer — a future operator action, or
   * a replay tool. The consumer goes through {@link AuditEventProcessor} instead, because it
   * also has to make the offset decision.
   */
  async record(input: RecordAuditEventInput): Promise<{ id: string; appended: boolean }> {
    return this.commandBus.execute(toRecordAuditEventCommand(input));
  }

  async search(
    filter: AuditFilter,
    page?: number,
    limit?: number,
  ): Promise<PagedAuditEvents> {
    return this.queryBus.execute(new SearchAuditEventsQuery(filter, page, limit));
  }

  async verify(partitionKey?: string): Promise<VerifyAuditChainResult> {
    return this.queryBus.execute(new VerifyAuditChainQuery(partitionKey));
  }
}