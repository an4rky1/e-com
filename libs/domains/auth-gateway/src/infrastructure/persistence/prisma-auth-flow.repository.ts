/**
 * @fileoverview Prisma-backed storage for flows, their audit trail and their outbox.
 *
 * @remarks The three writes go in through one `runInTransaction`, and that is the whole point
 * of the class. A flow that reached `completed` without its `auth_flow.step_completed` event
 * would leave every downstream consumer — account-security, audit-log — believing nobody ever
 * signed in; a flow that reached `completed` without its step rows would be unexplainable. Both
 * are worse than the login not happening at all, and both are prevented only by committing the
 * row, the steps and the envelopes together.
 *
 * @remarks Steps are appended, never rewritten: only the entries the row does not already hold
 * are inserted, so the `bigserial` ids a previous investigation quoted still resolve.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import type { IDomainEvent } from '@auth/core';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { AuthFlow, type AuthFlowStepRow } from '../../domain/auth-flow.aggregate';
import {
  AUTH_FLOW_REPOSITORY,
  type AuthFlowRepositoryPort,
} from '../../domain/ports/auth-flow-repository.port';
import { AUTH_GATEWAY_PRISMA } from '../../auth-gateway.config';

/**
 * The `auth_flow.*` domain event -> platform topic mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one table means adding an event cannot accidentally
 * invent a topic no consumer subscribes to.
 */
const TOPIC_FOR_EVENT: Record<string, string> = {
  'auth_flow.started': Topics.AUTH_FLOW_STARTED,
  'auth_flow.step_completed': Topics.AUTH_FLOW_STEP_COMPLETED,
  'auth_flow.completed': Topics.AUTH_FLOW_COMPLETED,
  'auth_flow.failed': Topics.AUTH_FLOW_FAILED,
};

@Injectable()
export class PrismaAuthFlowRepository implements AuthFlowRepositoryPort {
  private readonly logger = new Logger(PrismaAuthFlowRepository.name);

  constructor(
    @Inject(AUTH_GATEWAY_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  async save(flow: AuthFlow): Promise<void> {
    const events = flow.clearDomainEvents();

    await this.prisma.runInTransaction(async (client) => {
      await client.auth_flows.upsert({
        where: { id: flow.id.value },
        create: {
          id: flow.id.value,
          strategy: flow.flow,
          status: flow.state,
          user_id: flow.userId,
          device_id: flow.deviceId,
          client_ip: flow.clientIp,
          user_agent: flow.userAgent,
          attempt_count: flow.attemptCount,
          max_attempts: flow.maxAttempts,
          started_at: flow.startedAt,
          updated_at: flow.updatedAt,
          expires_at: flow.expiresAt,
          completed_at: flow.completedAt,
          failure_reason: flow.failureReason,
          abort_reason: flow.abortReason,
          version: flow.version,
        },
        update: {
          strategy: flow.flow,
          status: flow.state,
          user_id: flow.userId,
          device_id: flow.deviceId,
          client_ip: flow.clientIp,
          user_agent: flow.userAgent,
          attempt_count: flow.attemptCount,
          max_attempts: flow.maxAttempts,
          updated_at: flow.updatedAt,
          expires_at: flow.expiresAt,
          completed_at: flow.completedAt,
          failure_reason: flow.failureReason,
          abort_reason: flow.abortReason,
          version: flow.version,
        },
      });

      await this.appendSteps(client, flow);
      for (const event of events) {
        await this.enqueue(client, event, flow.id.value);
      }
    });
  }

  /**
   * Writes only the steps the table does not already hold.
   *
   * @remarks `slice(existing)` rather than a delete-and-reinsert: re-inserting would give the
   * same step a new `bigserial` id on every save, so an operator quoting `auth_flow_steps.id`
   * from an incident report would be quoting a row that no longer exists.
   */
  private async appendSteps(client: PrismaClient, flow: AuthFlow): Promise<void> {
    const existing = await client.auth_flow_steps.count({
      where: { flow_id: flow.id.value },
    });

    const fresh = flow.steps.slice(existing);
    if (fresh.length === 0) return;

    await client.auth_flow_steps.createMany({
      data: fresh.map((step) => ({
        flow_id: flow.id.value,
        from_status: step.from,
        to_status: step.to,
        occurred_at: step.occurredAt,
      })),
    });
  }

  /**
   * One outbox row per domain event.
   *
   * @remarks `dedup_key` is what makes a redelivered `AdvanceFlow` safe: the unique index on
   * `(dedup_key, type)` turns a second insert of the same fact into a no-op rather than a
   * duplicate `auth_flow.completed`.
   */
  private async enqueue(
    client: PrismaClient,
    event: IDomainEvent,
    flowId: string,
  ): Promise<void> {
    const topic = TOPIC_FOR_EVENT[event.eventType];
    if (!topic) {
      // An unmapped event is a build-time oversight. Logging and continuing is deliberate:
      // failing the transaction would roll back a perfectly valid sign-in over a topic that has
      // not been wired up yet.
      this.logger.warn(`No topic mapped for domain event "${event.eventType}"`);
      return;
    }

    const dedupKey = `${event.eventType}:${flowId}:${event.version}`;

    await client.outbox_events.createMany({
      data: [
        {
          id: event.eventId,
          type: event.eventType,
          aggregate_type: event.aggregateType,
          aggregate_id: flowId,
          topic,
          // `payload` is a JSON column, so it needs Prisma's Json input type rather than a
          // plain Record; the cast is the documented boundary for that conversion.
          payload: {
            eventId: event.eventId,
            type: topic,
            schemaVersion: 1,
            occurredAt: event.occurredAt.toISOString(),
            aggregateId: flowId,
            aggregateType: event.aggregateType,
            partitionKey: flowId,
            payload: readPayload(event),
          } as unknown as Prisma.InputJsonValue,
          dedup_key: dedupKey,
          status: 'pending',
          attempts: 0,
          next_attempt_at: new Date(),
          trace_id: event.correlationId ?? crypto.randomUUID(),
        },
      ],
      skipDuplicates: true,
    });
  }

  async findById(id: string): Promise<AuthFlow | null> {
    const row = await this.prisma.tx.auth_flows.findUnique({
      where: { id },
      include: { auth_flow_steps: { orderBy: { occurred_at: 'asc' } } },
    });
    return row ? AuthFlow.fromRow({ ...row, auth_flow_steps: row.auth_flow_steps }) : null;
  }

  async countActive(now: Date): Promise<number> {
    return this.prisma.tx.auth_flows.count({
      where: {
        expires_at: { gt: now },
        status: {
          in: ['awaiting_credential', 'awaiting_2fa', 'awaiting_step_up'],
        },
      },
    });
  }
}

/**
 * The event's payload, or an empty object.
 *
 * @remarks Structural rather than a class check on purpose: the events are declared in another
 * module that this repository must not depend on, and an event with no payload is not an error
 * worth failing a sign-in over.
 */
function readPayload(event: IDomainEvent): Record<string, unknown> {
  const candidate = event as unknown as { payload?: unknown };
  return typeof candidate.payload === 'object' && candidate.payload !== null
    ? (candidate.payload as Record<string, unknown>)
    : {};
}

export { AUTH_FLOW_REPOSITORY, type AuthFlowStepRow };