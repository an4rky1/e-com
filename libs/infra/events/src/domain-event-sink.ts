/**
 * @fileoverview The one place a saved aggregate's domain events split into the two planes.
 *
 * A repository calls {@link DomainEventSink.run} instead of opening a transaction itself:
 *
 * 1. inside the transaction — state from `work`, then one outbox row per **integration**
 *    event, committed atomically with the state that produced it;
 * 2. after the commit — every drained event, integration or not, goes to the in-process
 *    {@link IDomainEventBus} so this service's own handlers can react.
 *
 * The order matters. Dispatching in-process handlers before the commit lets a handler read
 * state that a rollback then erases; dispatching only "some" events would make handlers
 * depend on Kafka classification. Best-effort after the commit is the only honest semantic
 * for an in-process reaction, and the durable guarantee was already secured in step 1.
 */

import { Logger } from '@nestjs/common';
import type { IDomainEvent, IDomainEventBus } from '@auth/core';
import type { OutboxService } from '@auth/infra/outbox';
import { classify, type EventRegistry, type IntegrationEventRoute } from './domain-event-registry';

/** DI token for the sink repositories inject. */
export const DOMAIN_EVENT_SINK = Symbol('DOMAIN_EVENT_SINK');

/**
 * The slice of a Prisma service the sink needs.
 *
 * @remarks Structural, so every service's `PrismaService<SomethingClient>` satisfies it
 * without the events lib depending on a generated client. `runInTransaction` is what makes
 * "state and outbox rows commit together" a property of the caller's own transaction rather
 * than a second connection that could commit independently.
 */
export interface TransactionRunner<TClient> {
  runInTransaction<TResult>(fn: (client: TClient) => Promise<TResult>): Promise<TResult>;
}

export class DomainEventSink {
  private readonly logger = new Logger(DomainEventSink.name);

  constructor(
    private readonly bus: IDomainEventBus,
    private readonly outbox: OutboxService,
    private readonly registry: EventRegistry,
  ) {}

  /**
   * Runs `work` in one transaction and records its outcome on both planes.
   *
   * @param events - drained from the aggregate **before** the call; the sink never reaches
   * into an aggregate, so a repository stays the owner of the drain.
   */
  async run<TClient, TResult>(
    uow: TransactionRunner<TClient>,
    events: readonly IDomainEvent[],
    work: (client: TClient) => Promise<TResult>,
  ): Promise<TResult> {
    const result = await uow.runInTransaction(async (client) => {
      const value = await work(client);
      await this.enqueue(events);
      return value;
    });

    await this.dispatch(events);
    return result;
  }

  /**
   * Appends outbox rows inside the caller's transaction.
   *
   * @remarks `dedupKey` is `<type>:<aggregateId>:<version>` — the aggregate version, not a
   * clock or a uuid. Re-running the same command reproduces the same version, the unique
   * index on `(dedup_key, type)` turns the second insert into a no-op, and a retry can never
   * become a duplicate message.
   */
  private async enqueue(events: readonly IDomainEvent[]): Promise<void> {
    for (const event of events) {
      const verdict = classify(this.registry, event.eventType);

      if (verdict.kind === 'integration') {
        const payload = payloadOf(event, verdict.route);
        // Inside the transaction by design: a guard that refuses throws, and the throw
        // rolls back the state change together with the row it must not announce.
        this.registry.guardPayload?.(payload, event);

        await this.outbox.publish(verdict.route.topic, payload, {
          aggregateId: event.aggregateId,
          aggregateType: event.aggregateType,
          partitionKey: verdict.route.partitionKey?.(event) ?? event.aggregateId,
          dedupKey: `${event.eventType}:${event.aggregateId}:${event.version}`,
          traceId: event.correlationId,
          eventId: event.eventId,
          occurredAt: event.occurredAt.toISOString(),
        });
        continue;
      }

      if (verdict.kind === 'unclassified') {
        // Deliberately not a throw: failing the transaction would roll back a perfectly
        // valid state change over a registry entry someone forgot. The completeness spec
        // is what makes this loud; at runtime the fact stays in-process and logged.
        this.logger.warn(
          `Domain event "${event.eventType}" is in no registry list; staying in-process`,
        );
      }
    }
  }

  private async dispatch(events: readonly IDomainEvent[]): Promise<void> {
    if (events.length === 0) return;

    try {
      await this.bus.publishAll(events);
    } catch (error) {
      // Post-commit: the state and the Kafka guarantee are already durable here, so an
      // in-process failure is logged and swallowed rather than reported as a failed command.
      this.logger.error(
        `In-process dispatch failed for ${events.length} event(s): ${String(error)}`,
      );
    }
  }
}

function payloadOf(
  event: IDomainEvent,
  route: IntegrationEventRoute,
): Record<string, unknown> {
  if (route.toPayload) return route.toPayload(event);

  // Domain events without a payload exist; the envelope still needs the key present.
  const candidate = event as unknown as { payload?: unknown };
  return typeof candidate.payload === 'object' && candidate.payload !== null
    ? (candidate.payload as Record<string, unknown>)
    : {};
}
