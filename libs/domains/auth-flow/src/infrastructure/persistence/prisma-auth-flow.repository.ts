/**
 * @fileoverview Prisma-backed storage for flows, their audit trail and their outbox.
 *
 * @remarks The three writes go in through one transaction, and that is the whole point of the
 * class. A flow that reached `completed` without its `auth_flow.step_completed` event would
 * leave every downstream consumer — account-security, audit-log — believing nobody ever signed
 * in; a flow that reached `completed` without its step rows would be unexplainable. Both are
 * worse than the login not happening at all, and both are prevented only by committing the
 * row, the steps and the envelopes together.
 *
 * @remarks Steps are appended, never rewritten: only the entries the row does not already hold
 * are inserted, so the `bigserial` ids a previous investigation quoted still resolve.
 */
import { Inject, Injectable } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { DOMAIN_EVENT_SINK, type DomainEventSink } from '@auth/infra/events';
import type { PrismaClient } from '../../generated/prisma/client';
import { AuthFlow, type AuthFlowStepRow } from '../../domain/auth-flow.aggregate';
import {
  AUTH_FLOW_REPOSITORY,
  type AuthFlowRepositoryPort,
} from '../../domain/ports/auth-flow-repository.port';
import { AUTH_FLOW_PRISMA } from '../../auth-flow.config';

@Injectable()
export class PrismaAuthFlowRepository implements AuthFlowRepositoryPort {
  constructor(
    @Inject(AUTH_FLOW_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    @Inject(DOMAIN_EVENT_SINK) private readonly sink: DomainEventSink,
  ) {}

  async save(flow: AuthFlow): Promise<void> {
    const events = flow.clearDomainEvents();

    await this.sink.run(this.prisma, events, async (client) => {
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

export { AUTH_FLOW_REPOSITORY, type AuthFlowStepRow };