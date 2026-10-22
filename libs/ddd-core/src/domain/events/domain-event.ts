/**
 * @fileoverview Domain events: facts about something that already happened inside one
 * aggregate boundary.
 *
 * Why the distinction matters: a domain event is a statement to the *same* aggregate's
 * collaborators ("this user's email was just verified"). It is not a message to another
 * service. Crossing a process boundary is what turns it into an integration event, and
 * that promotion happens at the outbox — see {@link IDomainEvent} versus the envelope in
 * `@auth/contracts`. Publishing a domain event straight to Kafka collapses the two and
 * makes the aggregate's internals a wire format.
 */

export interface IDomainEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  /** Aggregate version this event produced; orders events within the aggregate. */
  readonly version: number;
  /** Causality: carries the trace id so a domain event stays attached to its request. */
  readonly correlationId?: string;
}

export abstract class DomainEvent implements IDomainEvent {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly version: number;

  constructor(
    readonly aggregateId: string,
    readonly aggregateType: string,
    readonly eventType: string,
    version = 1,
    correlationId?: string,
  ) {
    this.eventId = globalThis.crypto.randomUUID();
    this.occurredAt = new Date();
    this.version = version;
    this.correlationId = correlationId;
  }

  readonly correlationId?: string;
}

export interface IDomainEventHandler<TEvent extends IDomainEvent> {
  handle(event: TEvent): Promise<void>;
}