/**
 * @fileoverview The Kafka-driven entry point: what this service *does*, which is consume.
 *
 * @remarks This service records nobody's actions on request. Every record it holds exists
 * because some other service announced a security-relevant fact. That is what makes three
 * concerns central here rather than afterthoughts, and all three are about the gap between
 * "handled" and "committed":
 *
 * - a redelivery must not append a second record (the idempotency claim);
 * - a failure to store must *throw*, so the broker redelivers, because an audit gap is worse
 *   than a late audit row;
 * - a payload that can never be understood must be dead-lettered, not retried forever, because
 *   one poison message otherwise takes its whole partition down.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConsumedMessage } from '@auth/infra/kafka';
import { DomainError } from '@auth/ddd-core';
import { redact } from '@auth/platform/error-handling';
import { routeFor, resultFor, stringOfField, type AuditRoute } from '../../domain/audit-routing';
import { ActorType, UNKNOWN_RESOURCE_ID } from '../../domain/value-objects/audit-result.vo';
import {
  IDEMPOTENCY_STORE,
  idempotencyKeyFor,
  type IdempotencyStorePort,
} from '../../domain/ports/idempotency-store.port';
import { AUDIT_RECORDER, type AuditRecorderPort } from '../ports/audit-recorder.port';

/** The envelope fields this service reads. Everything else in a message is ignored. */
export interface Envelope {
  readonly eventId: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The terminal outcomes. A consumer that reported "something happened" and left the caller to
 * guess whether it should commit an offset is a consumer whose offsets are wrong.
 */
export const ConsumerOutcomeKind = {
  /** A record was appended. Safe to commit the offset. */
  RECORDED: 'recorded',
  /** The redelivery of an event already recorded. Safe to commit. */
  DUPLICATE: 'duplicate',
  /** The message cannot be understood and never will be. Safe to commit. */
  DEAD_LETTERED: 'dead_lettered',
  /**
   * Storing failed for a reason a retry could fix.
   *
   * @remarks The caller must let the broker redeliver. An audit log with a hole in it is worse
   * than one with a late row in it, and the only mechanism that closes the hole is the offset
   * not committing.
   */
  RELEASED: 'released',
} as const;

export type ConsumerOutcomeKind =
  (typeof ConsumerOutcomeKind)[keyof typeof ConsumerOutcomeKind];

export type ConsumerOutcome =
  | { readonly kind: typeof ConsumerOutcomeKind.RECORDED; readonly auditEventId: string }
  | { readonly kind: typeof ConsumerOutcomeKind.DUPLICATE; readonly idempotencyKey: string }
  | {
      readonly kind: typeof ConsumerOutcomeKind.DEAD_LETTERED;
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly kind: typeof ConsumerOutcomeKind.RELEASED;
      readonly reason: string;
      readonly detail?: string;
    };

/**
 * Narrows a Kafka payload to the envelope this service can use.
 *
 * @remarks Validates *structure*, not meaning. It cannot tell a `SessionRevokedPayload` from a
 * `RoleGrantedPayload` — both are records — so a payload that is structurally fine but says
 * nothing this service routes is caught one layer down, by the route table.
 *
 * @returns `null` for anything unreadable. No throw: the caller dead-letters.
 */
export function parseEnvelope(payload: unknown): Envelope | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const record = payload as Record<string, unknown>;
  const eventId = record['eventId'];
  const type = record['type'];
  const occurredAt = record['occurredAt'];
  const aggregateId = record['aggregateId'];
  const body = record['payload'];

  if (typeof eventId !== 'string' || eventId.trim().length === 0) return null;
  if (typeof type !== 'string' || type.trim().length === 0) return null;
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) return null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  return {
    eventId: eventId.trim(),
    type: type.trim(),
    aggregateId:
      typeof aggregateId === 'string' && aggregateId.trim().length > 0
        ? aggregateId.trim()
        : UNKNOWN_RESOURCE_ID,
    occurredAt,
    payload: body as Record<string, unknown>,
  };
}

/** Who did it, and to what. A failure here is a message this service cannot attribute. */
export interface RoutedActor {
  readonly actorId: string | null;
  readonly actorType: ActorType;
  readonly resourceId: string;
}

export type RoutedInput = RoutedActor & { readonly error?: undefined } | { readonly error: string };

/**
 * Reads the subject and the target out of a routed payload.
 *
 * @remarks The subject is deliberately not `aggregateId`. For most topics the two are the same
 * user, but a `credential.failed` event's aggregate is the credential being tried and its
 * aggregate id is a hash, not a person; attributing the attempt to that hash would make
 * "which accounts is this attacker hitting" unanswerable from the log.
 */
export function toRoutedInput(route: AuditRoute, envelope: Envelope): RoutedInput {
  const payload = envelope.payload;

  // `grantedBy` is checked first on the role topics: a role granted by an administrator is an
  // administrative act, and recording it as the recipient's own action is how privilege
  // escalation disappears from the log.
  const actorId =
    stringOfField(payload, ['grantedBy']) ?? stringOfField(payload, route.actorFields);

  if (actorId === undefined && !route.actorOptional) {
    // A topic that cannot be audited without naming a subject, arriving without one. Storing
    // it anyway would attribute the event to nobody; refusing it puts it on a topic somebody
    // reads, which is the answer an operator needs.
    return { error: `no actor in the payload of ${envelope.type}` };
  }

  return {
    actorId: actorId ?? null,
    actorType: actorId === undefined ? ActorType.ANONYMOUS : ActorType.USER,
    resourceId: stringOfField(payload, route.resourceFields) ?? envelope.aggregateId,
  };
}

/**
 * Strips secrets from the stored payload.
 *
 * @remarks Delegates to the platform's `SENSITIVE_FIELDS` deny-list rather than keeping a
 * second copy. A second list drifts: it is one more place to add a field when somebody adds
 * one, and a field in one list and not the other is a secret that is redacted in logs and
 * stored in plaintext in the one store nobody prunes.
 */
export function redactPayload(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const cleaned = redact(payload);
  return typeof cleaned === 'object' && cleaned !== null && !Array.isArray(cleaned)
    ? (cleaned as Record<string, unknown>)
    : { value: cleaned };
}

@Injectable()
export class AuditEventProcessor {
  private readonly logger = new Logger(AuditEventProcessor.name);

  constructor(
    @Inject(AUDIT_RECORDER) private readonly recorder: AuditRecorderPort,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStorePort,
  ) {}

  async process(message: ConsumedMessage<unknown>): Promise<ConsumerOutcome> {
    const envelope = parseEnvelope(message.payload);
    if (!envelope) {
      return {
        kind: ConsumerOutcomeKind.DEAD_LETTERED,
        reason: 'malformed-envelope',
        detail:
          'payload is not an IntegrationEvent with an eventId, type, occurredAt and object payload',
      };
    }

    const route = routeFor(message.topic);
    if (!route) {
      // A topic this service subscribes to but has no route for. Subscribing to it is only
      // meaningful if something is done with it, so this is a wiring bug and it is named as
      // one rather than quietly acknowledged.
      return {
        kind: ConsumerOutcomeKind.DEAD_LETTERED,
        reason: 'no-route',
        detail: `no audit route for topic ${message.topic}`,
      };
    }

    const routed = toRoutedInput(route, envelope);
    if ('error' in routed) {
      return {
        kind: ConsumerOutcomeKind.DEAD_LETTERED,
        reason: 'unattributable-actor',
        detail: routed.error,
      };
    }

    const payload = envelope.payload;
    const idempotencyKey = idempotencyKeyFor(message.topic, envelope.eventId);

    try {
      const recorded = await this.recorder.record({
        idempotencyKey,
        actorId: routed.actorId,
        actorType: routed.actorType,
        action: route.action,
        resourceType: route.resourceType,
        resourceId: routed.resourceId,
        result: resultFor(route, payload),
        occurredAt: new Date(envelope.occurredAt),
        ipAddress: stringOfField(payload, ['ipAddress']) ?? null,
        userAgent: stringOfField(payload, ['userAgent', 'deviceFingerprint']) ?? null,
        // Redacted before it is stored, never after: a value that was written and then scrubbed
        // has already been in a transaction log, a WAL and a backup.
        payload: redactPayload(payload),
        traceId: message.traceId ?? crypto.randomUUID(),
      });

      return recorded.appended
        ? { kind: ConsumerOutcomeKind.RECORDED, auditEventId: recorded.id }
        : { kind: ConsumerOutcomeKind.DUPLICATE, idempotencyKey };
    } catch (error) {
      // A `DomainError` is permanent by construction — this service raised it because the
      // record can never be chained — and keeping the claim is what turns "a retry loop that
      // never converges" into "a named reason on a topic somebody reads".
      if (error instanceof DomainError) {
        this.logger.warn(`dead-lettering ${message.topic}/${envelope.eventId}: ${error.message}`);
        return {
          kind: ConsumerOutcomeKind.DEAD_LETTERED,
          reason: 'record-rejected',
          detail: error.message,
        };
      }

      // Everything else is assumed transient. The claim was already released by the handler;
      // reporting `released` is what makes the broker hand the message back rather than commit
      // an offset over an event that was never recorded.
      const detail = describe(error);
      this.logger.error(`failed to record ${message.topic}/${envelope.eventId}: ${detail}`);
      return { kind: ConsumerOutcomeKind.RELEASED, reason: 'record-failed', detail };
    }
  }

  /**
   * Reclaims claims whose owner never came back.
   *
   * @remarks On a schedule, from the consumer's own bootstrap. Without it a pod killed between
   * claiming and releasing holds the claim until its TTL, and the event sits unaudited for as
   * long as that is. The TTL is the backstop; this is the fast path.
   */
  async sweepAbandonedClaims(olderThan: Date = new Date()): Promise<number> {
    const released = await this.idempotency.releaseAbandoned(olderThan);
    if (released > 0) {
      this.logger.warn(`released ${released} abandoned consumer claim(s)`);
    }
    return released;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}