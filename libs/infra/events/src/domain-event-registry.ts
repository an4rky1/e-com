/**
 * @fileoverview How one service classifies its domain events.
 *
 * A domain event is a fact inside one aggregate; whether that fact also concerns other
 * services is a separate, deliberate decision. The registry makes that decision explicit
 * and machine-checkable: `integration` events leave through the outbox, `internal` events
 * stay in-process, and an event in neither list is a wiring bug rather than a silent drop.
 *
 * One event type maps to exactly one topic. Two topics for one fact would need two
 * consumers to agree on deduplication, which no amount of registry cleverness buys.
 */

import type { IDomainEvent } from '@auth/core';

/** The road out of the process for one integration event: topic, message shape, ordering. */
export interface IntegrationEventRoute {
  /** Contract topic from `@auth/contracts`, e.g. `platform.user.registered.v1`. */
  readonly topic: string;

  /**
   * How the domain fact becomes a wire payload.
   *
   * @remarks Defaults to the event's own `payload` object; override only when the consumer's
   * contract needs a different shape than the aggregate naturally records.
   */
  readonly toPayload?: (event: IDomainEvent) => Record<string, unknown>;

  /**
   * Ordering key for the Kafka partition.
   *
   * @remarks Defaults to the aggregate id: everything one aggregate says must land on one
   * partition or concurrent state changes reorder for consumers.
   */
  readonly partitionKey?: (event: IDomainEvent) => string;
}

export interface EventRegistry {
  /** Domain event type -> the topic it is published on. Absent here means "never Kafka". */
  readonly integration: Readonly<Record<string, IntegrationEventRoute>>;

  /**
   * Domain event types deliberately kept in-process.
   *
   * @remarks An explicit list, not a comment: the completeness spec asserts every event a
   * service's aggregates raise appears in one of the two lists.
   */
  readonly internal: readonly string[];

  /**
   * Service-wide payload policy, applied to every integration payload before it is written.
   *
   * @remarks A guard, not a convention: a later edit that adds a secret "for just this one
   * consumer" would otherwise ship a credential to a topic whose retention is measured in
   * days. Throwing is the point — it happens inside the caller's transaction, so a refused
   * payload rolls the state change back together with the row rather than announcing an event
   * under a shape nobody should have seen.
   */
  readonly guardPayload?: (payload: Record<string, unknown>, event: IDomainEvent) => void;
}

export type RegistryVerdict =
  | { readonly kind: 'integration'; readonly route: IntegrationEventRoute }
  | { readonly kind: 'internal' }
  | { readonly kind: 'unclassified' };

/** Resolves which road a single event takes. Exported so specs and the sink agree on the rule. */
export function classify(
  registry: EventRegistry,
  eventType: string,
): RegistryVerdict {
  const route = registry.integration[eventType];
  if (route) return { kind: 'integration', route };
  if (registry.internal.includes(eventType)) return { kind: 'internal' };
  return { kind: 'unclassified' };
}
