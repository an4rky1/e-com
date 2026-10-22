/**
 * @fileoverview The Kafka-driven entry point: what this service *does*, which is consume.
 *
 * @remarks This service produces nothing on a user request. It has no REST or gRPC inbound
 * surface at all — every notification it sends exists because some other service announced a
 * fact. That is what makes idempotency the central concern here rather than an afterthought:
 * the only thing standing between the broker's at-least-once delivery and a user receiving two
 * welcome emails is the claim taken in {@link NotificationEventProcessor.process}.
 *
 * @remarks Nothing in this file throws for bad input. A payload that cannot be understood is
 * dead-lettered with a reason, because a handler that raises on a poison message takes its
 * partition down with it and every event behind that message stops being processed. The
 * *only* failures that propagate are the ones a retry could fix, and those release the claim
 * first.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConsumedMessage } from '@auth/infra/kafka';
import { DomainError } from '@auth/ddd-core';
import {
  CONSUMER_CLAIM_STORE,
  claimKeyFor,
  type ConsumerClaimStorePort,
} from '../../domain/ports/consumer-claim.port';
import {
  NOTIFICATION_DISPATCHER,
  type NotificationDispatcherPort,
} from '../ports/notification-dispatcher.port';
import { resolveRoute, routeFor } from '../../domain/event-routing';
import {
  toSendNotificationCommand,
  type SendNotificationResult,
} from '../commands/notification.commands';

/** The envelope fields this service reads. Everything else in a message is ignored. */
interface Envelope {
  readonly eventId: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The terminal outcomes. A consumer that reported "something happened" and left the caller to
 * guess whether it should commit an offset is a consumer whose offsets are wrong.
 */
export const ConsumerOutcomeKind = {
  /** A notification was dispatched. Safe to commit the offset. */
  PROCESSED: 'processed',
  /** Somebody already holds the claim; this delivery is a duplicate. Safe to commit. */
  DUPLICATE: 'duplicate',
  /** The message cannot be understood and never will be. Safe to commit. */
  DEAD_LETTERED: 'dead_lettered',
  /**
   * Processing failed for a reason a retry could fix.
   *
   * @remarks The claim has *already* been released by the time this is returned. The caller
   * must let the broker redeliver — a redelivery with the claim still held would be discarded
   * as a duplicate and the notification lost for good.
   */
  RELEASED: 'released',
} as const;

export type ConsumerOutcomeKind =
  (typeof ConsumerOutcomeKind)[keyof typeof ConsumerOutcomeKind];

export type ConsumerOutcome =
  | {
      readonly kind: typeof ConsumerOutcomeKind.PROCESSED;
      readonly notificationId: string;
      readonly template: string;
      readonly result: SendNotificationResult;
    }
  | { readonly kind: typeof ConsumerOutcomeKind.DUPLICATE; readonly claimKey: string }
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
 * @remarks Validates *structure*, not meaning. It cannot tell a `UserRegisteredPayload` from a
 * `SessionReuseDetectedPayload` — both are records — so an event whose payload is the wrong
 * shape for its template is caught by the template's Zod schema instead, one layer down.
 *
 * @returns `null` for anything unreadable. No throw: the caller dead-letters.
 */
export function parseEnvelope(payload: unknown): Envelope | null {
  if (typeof payload !== 'object' || payload === null) return null;

  const record = payload as Record<string, unknown>;
  const eventId = record['eventId'];
  const type = record['type'];
  const body = record['payload'];

  if (typeof eventId !== 'string' || eventId.trim().length === 0) return null;
  if (typeof type !== 'string' || type.trim().length === 0) return null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  return {
    eventId: eventId.trim(),
    type: type.trim(),
    payload: body as Record<string, unknown>,
  };
}

@Injectable()
export class NotificationEventProcessor {
  private readonly logger = new Logger(NotificationEventProcessor.name);

  constructor(
    @Inject(CONSUMER_CLAIM_STORE) private readonly claims: ConsumerClaimStorePort,
    @Inject(NOTIFICATION_DISPATCHER) private readonly dispatcher: NotificationDispatcherPort,
  ) {}

  /**
   * The whole consumer.
   *
   * @remarks The claim is taken *before* the routing decision, and it is kept for the
   * dead-letter branches. That looks backwards — why claim something you are about to reject?
   * — and it is deliberate: a dead-lettered message is processed. Keeping the claim is what
   * stops a replay of the same poison message from filling the dead-letter topic with copies
   * of itself, and it costs nothing because a message that fails its schema fails identically
   * on every redelivery.
   *
   * @remarks Conversely the claim is released the moment anything throws. The alternative —
   * keeping it — turns a 30-second database blip into a permanently lost notification, and the
   * loss is invisible: no error, no event, just a user who never got the email.
   */
  async process(message: ConsumedMessage<unknown>): Promise<ConsumerOutcome> {
    const envelope = parseEnvelope(message.payload);
    if (!envelope) {
      return {
        kind: 'dead_lettered',
        reason: 'malformed-envelope',
        detail: 'payload is not an IntegrationEvent with an eventId, type and object payload',
      };
    }

    const claimKey = claimKeyFor(message.topic, envelope.eventId);
    const claim = await this.claims.claim(claimKey, { traceId: message.traceId });

    if (!claim.claimed) {
      this.logger.log(
        `skipping ${message.topic}/${envelope.eventId}: already claimed (attempt ${message.attempt})`,
      );
      return { kind: 'duplicate', claimKey };
    }

    const route = routeFor(message.topic);
    if (!route) {
      // A topic this service subscribes to but has no route for. Subscribing to it is only
      // meaningful if something is done with it, so this is a wiring bug and it is named as
      // one rather than quietly acknowledged.
      return {
        kind: 'dead_lettered',
        reason: 'no-route',
        detail: `no notification route for topic ${message.topic}`,
      };
    }

    const resolution = resolveRoute(route, envelope.payload);
    if (!resolution.ok) {
      return {
        kind: 'dead_lettered',
        reason: resolution.reason,
        ...(resolution.detail ? { detail: resolution.detail } : {}),
      };
    }

    try {
      const result = await this.dispatcher.send(
        toSendNotificationCommand({
          ...resolution.instruction,
          correlationId: message.traceId,
        }),
      );

      return {
        kind: 'processed',
        notificationId: result.notificationId,
        template: result.template,
        result,
      };
    } catch (error) {
      // A `DomainError` here is the template's Zod schema refusing the variables, and that is
      // permanent: the same payload fails identically on every redelivery. Keeping the claim
      // and dead-lettering it is what turns "a retry loop that never converges" into "a named
      // reason on a topic somebody reads".
      if (error instanceof DomainError) {
        this.logger.warn(
          `dead-lettering ${message.topic}/${envelope.eventId}: ${error.message}`,
        );
        return {
          kind: 'dead_lettered',
          reason: 'template-rejected',
          detail: error.message,
        };
      }

      const detail = describe(error);
      await this.releaseQuietly(claimKey, detail);

      return { kind: 'released', reason: 'dispatch-failed', detail };
    }
  }

  /**
   * Reclaims claims whose owner never came back.
   *
   * @remarks On a schedule, from the consumer's own bootstrap. Without it a pod killed between
   * claiming and releasing holds the claim until its TTL, and the event sits undelivered for
   * as long as that is. The claim's TTL is the backstop; this is the fast path.
   */
  async sweepAbandonedClaims(olderThan: Date = new Date()): Promise<number> {
    const released = await this.claims.releaseAbandoned(olderThan);
    if (released > 0) {
      this.logger.warn(`released ${released} abandoned consumer claim(s)`);
    }
    return released;
  }

  /**
   * A failed release must not replace the original failure.
   *
   * @remarks If the release throws, the caller would see *that* error, decide the dispatch had
   * failed for a different reason, and act on that — while the claim it just lost track of is
   * still held and the notification is now permanently suppressed. Swallowing and logging
   * keeps the original reason, which is the one that describes what actually happened.
   */
  private async releaseQuietly(claimKey: string, detail: string): Promise<void> {
    try {
      const released = await this.claims.release(claimKey);
      if (!released) {
        this.logger.warn(`claim ${claimKey} was already gone when released`);
      }
    } catch (error) {
      this.logger.error(
        `failed to release claim ${claimKey} after ${detail}: ${describe(error)}`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}