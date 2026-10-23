/**
 * @fileoverview Claim, chain, append, release.
 *
 * @remarks The order of the three steps is the whole design. The claim is taken first so a
 * redelivery is refused rather than stored twice; the append happens second, inside the
 * repository's transaction, so the record and its chain head commit together; and the claim is
 * released only when the append failed for a reason a retry could fix — a lock wait, a dropped
 * connection. Anything else leaves the claim held, because a retry of a permanently-failing
 * message must not loop.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { DomainError, EntityId } from '@auth/core';
// Value import: `@CommandHandler` reads the emitted value binding, so a type-only
// import erases the command token and the handler never registers.
import { RecordAuditEventCommand } from './record-audit-event.command';
import {
  AUDIT_REPOSITORY,
  AppendOutcome,
  type AuditRepositoryPort,
} from '../../domain/ports/audit-repository.port';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStorePort,
} from '../../domain/ports/idempotency-store.port';
import { AuditEvent } from '../../domain/audit-event.aggregate';
import { partitionKeyFor } from '../../domain/value-objects/audit-partition.vo';
import { UNKNOWN_ACTOR_ID, UNKNOWN_RESOURCE_ID } from '../../domain/value-objects/audit-result.vo';
import { AUDIT_LOG_CONFIG, type AuditLogConfig } from '../../audit-log.config';

@Injectable()
@CommandHandler(RecordAuditEventCommand)
export class RecordAuditEventHandler
  implements ICommandHandler<RecordAuditEventCommand, { id: string; appended: boolean }>
{
  private readonly logger = new Logger(RecordAuditEventHandler.name);

  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepositoryPort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStorePort,
    @Inject(AUDIT_LOG_CONFIG) private readonly config: AuditLogConfig,
  ) {}

  async execute(command: RecordAuditEventCommand): Promise<{ id: string; appended: boolean }> {
    const { input } = command;

    // A partition key and a record id are decided before the claim, because they are part of
    // what the claim records as "already handled". A retry must produce the same answer, or
    // the redelivery would land in a different partition from the original.
    const id = EntityId.create<'AuditEventId'>();
    const actorId = input.actorId?.trim() || UNKNOWN_ACTOR_ID;
    const partitionKey = partitionKeyFor(
      this.config.partitionStrategy,
      input.actorType,
      actorId,
      input.occurredAt,
    );

    const claim = await this.idempotency.claim(
      input.idempotencyKey,
      { partitionKey, auditEventId: id },
      { traceId: input.traceId },
    );

    if (!claim.claimed) {
      this.logger.debug(`skipping ${input.idempotencyKey}: already recorded`);
      return { id, appended: false };
    }

    const event = AuditEvent.record({
      id,
      partitionKey,
      // Overwritten by the repository once the head row is locked; a placeholder that is
      // never persisted, because the repository is the only thing that knows the position.
      sequence: 0,
      occurredAt: input.occurredAt,
      receivedAt: new Date(),
      actorId,
      actorType: input.actorType,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId?.trim() || UNKNOWN_RESOURCE_ID,
      result: input.result,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      payload: input.payload,
      traceId: input.traceId,
    });

    try {
      const outcome = await this.audit.append(event);

      if (outcome === AppendOutcome.UNSUPPORTED_PARTITION) {
        // Permanent, and fatal to the claim: this record will never exist, and a retry would
        // compute the same key. Reported as a domain error so the consumer dead-letters it
        // rather than redelivering forever.
        throw new DomainError('CONFLICTING_STATE', 'the audit partition cannot be chained', {
          partitionKey,
        });
      }

      return { id, appended: outcome === AppendOutcome.APPENDED };
    } catch (error) {
      if (error instanceof DomainError) throw error;

      // Anything else is transient by assumption — a deadlock, a timeout, a dropped socket.
      // The claim goes back so the redelivery is not refused as a duplicate; an audit gap is
      // worse than a late audit row, and a held claim would turn a blip into a permanent hole.
      await this.releaseQuietly(input.idempotencyKey, describe(error));
      throw error;
    }
  }

  /**
   * A failed release must not replace the original failure.
   *
   * @remarks If the release throws, the caller would see *that* error and act on it, while
   * the claim it just lost track of is still held and the event is permanently unaudited.
   */
  private async releaseQuietly(key: string, detail: string): Promise<void> {
    try {
      await this.idempotency.release(key);
    } catch (error) {
      this.logger.error(
        `failed to release claim ${key} after ${detail}: ${describe(error)}`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}