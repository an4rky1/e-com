import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
// Value import: constructor-injected; the type-only form erases its DI token.
import { OutboxService } from '@auth/infra/outbox';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  POLICY_REPOSITORY,
  type PolicyRepositoryPort,
} from '../../domain/ports/policy-repository.port';
import { Policy } from '../../domain/policy.aggregate';
import type { PolicyCondition } from '../../domain/value-objects/policy-condition.vo';
import { ACCESS_CONTROL_PRISMA } from '../../access-control.config';
import { enqueueEvents, type TopicMap } from './outbox-enqueue';

/**
 * Domain events for an ABAC rule.
 *
 * @remarks Empty for the same reason as the role definition's: nothing subscribes to "a rule
 * was written" today, and inventing a topic would create a contract with no consumer.
 */
const POLICY_TOPICS: TopicMap = {};

@Injectable()
export class PrismaPolicyRepository implements PolicyRepositoryPort {
  private readonly logger = new Logger(PrismaPolicyRepository.name);

  constructor(
    @Inject(ACCESS_CONTROL_PRISMA)
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly outbox: OutboxService,
  ) {}

  async save(policy: Policy): Promise<void> {
    const events = policy.clearDomainEvents();

    const data = {
      role: policy.role.value,
      permission: policy.permission.value,
      effect: policy.effect,
      conditions: toJsonConditions(policy.conditions),
      priority: policy.priority,
      resource_type: policy.resourceType,
      description: policy.description,
    };

    await this.prisma.runInTransaction(async (client) => {
      await client.policies.upsert({
        where: { id: policy.id },
        create: { id: policy.id, created_at: policy.createdAt, ...data },
        update: data,
      });

      await enqueueEvents(events, {
        outbox: this.outbox,
        logger: this.logger,
        topics: POLICY_TOPICS,
      });
    });
  }

  async delete(policy: Policy): Promise<void> {
    const events = policy.clearDomainEvents();

    await this.prisma.runInTransaction(async (client) => {
      await client.policies.delete({ where: { id: policy.id } });

      await enqueueEvents(events, {
        outbox: this.outbox,
        logger: this.logger,
        topics: POLICY_TOPICS,
      });
    });
  }

  async findById(id: string): Promise<Policy | null> {
    const row = await this.prisma.tx.policies.findUnique({ where: { id } });
    return row ? Policy.fromRow(row) : null;
  }

  async findByRole(role: string): Promise<Policy[]> {
    return this.findByRoles([role]);
  }

  async findByRoles(roles: readonly string[]): Promise<Policy[]> {
    if (roles.length === 0) return [];
    const rows = await this.prisma.tx.policies.findMany({
      where: { role: { in: [...roles] } },
      orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
    });
    return rows.map(Policy.fromRow);
  }

  async findAll(): Promise<Policy[]> {
    const rows = await this.prisma.tx.policies.findMany({
      orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
    });
    return rows.map(Policy.fromRow);
  }

  async countByRole(role: string): Promise<number> {
    return this.prisma.tx.policies.count({
      where: { role: role.trim().toLowerCase() },
    });
  }

  async count(): Promise<number> {
    return this.prisma.tx.policies.count();
  }
}

/**
 * `conditions` is a JSON column.
 *
 * @remarks The double cast is the documented boundary for Prisma's JSON input type: the
 * column accepts any JSON document, the type accepts only values Prisma can prove are one,
 * and a read-only `PolicyCondition[]` is not one of them.
 */
function toJsonConditions(
  conditions: readonly PolicyCondition[],
): Prisma.InputJsonValue {
  return conditions.map((condition) => ({
    attribute: condition.attribute,
    operator: condition.operator,
    value: Array.isArray(condition.value) ? [...condition.value] : condition.value,
  })) as unknown as Prisma.InputJsonValue;
}

export { POLICY_REPOSITORY };