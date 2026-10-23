import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
// Value import: constructor-injected; the type-only form erases its DI token.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { OutboxService } from '@auth/infra/outbox';
import { Topics } from '@auth/contracts';
import type { IDomainEvent } from '@auth/core';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  type RoleAssignmentRepositoryPort,
} from '../../domain/ports/role-assignment-repository.port';
import { RoleAssignment } from '../../domain/role-assignment.aggregate';
import { ACCESS_CONTROL_PRISMA } from '../../access-control.config';
import { enqueueEvents, type TopicMap } from './outbox-enqueue';

/** The only two facts this service publishes about a person. */
const ASSIGNMENT_TOPICS: TopicMap = {
  'role.granted': Topics.ROLE_GRANTED,
  'role.revoked': Topics.ROLE_REVOKED,
};

@Injectable()
export class PrismaRoleAssignmentRepository
  implements RoleAssignmentRepositoryPort
{
  private readonly logger = new Logger(PrismaRoleAssignmentRepository.name);

  constructor(
    @Inject(ACCESS_CONTROL_PRISMA)
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Writes the assignment and its events atomically.
   *
   * @remarks This is the transactional-outbox guarantee in its shortest form. The row and the
   * `role.granted` envelope go in through `runInTransaction`, so either a consumer eventually
   * hears that the user gained access or nothing about it exists at all. Publishing to Kafka
   * after a separate commit leaves a window in which the database says the user is an admin
   * and every downstream token still says they are not.
   */
  async save(assignment: RoleAssignment): Promise<void> {
    const events = assignment.clearDomainEvents();

    const data = {
      user_id: assignment.userId,
      role: assignment.role.value,
      granted_by: assignment.grantedBy,
      granted_at: assignment.grantedAt,
      expires_at: assignment.expiresAt,
      revoked_at: assignment.revokedAt,
    };

    await this.prisma.runInTransaction(async (client) => {
      await client.role_assignments.upsert({
        where: { id: assignment.id },
        create: { id: assignment.id, ...data },
        update: data,
      });

      await enqueueEvents(events, {
        outbox: this.outbox,
        logger: this.logger,
        topics: ASSIGNMENT_TOPICS,
        // Ordered per *user*, not per assignment: a grant and a revoke of two different
        // roles are two aggregates, and a consumer applying them out of order can end up with
        // a permission set nobody ever authorised.
        partitionKey: (event) => readUserId(event) ?? event.aggregateId,
      });
    });
  }

  async findById(id: string): Promise<RoleAssignment | null> {
    const row = await this.prisma.tx.role_assignments.findUnique({ where: { id } });
    return row ? RoleAssignment.fromRow(row) : null;
  }

  /**
   * The live grant of this role to this user.
   *
   * @remarks Revoked and expired rows are excluded in the query rather than in the
   * aggregate, so the "already granted" check costs one indexed lookup and stays correct even
   * if a row's `expires_at` passed while nobody called `revoke`.
   */
  async findActiveByUserAndRole(
    userId: string,
    role: string,
  ): Promise<RoleAssignment | null> {
    const row = await this.prisma.tx.role_assignments.findFirst({
      where: {
        user_id: userId,
        role: role.trim().toLowerCase(),
        ...liveAt(new Date()),
      },
    });
    return row ? RoleAssignment.fromRow(row) : null;
  }

  async findActiveByUser(userId: string): Promise<RoleAssignment[]> {
    const rows = await this.prisma.tx.role_assignments.findMany({
      where: { user_id: userId, ...liveAt(new Date()) },
      orderBy: { role: 'asc' },
    });
    return rows.map(RoleAssignment.fromRow);
  }

  async countActiveByUser(userId: string): Promise<number> {
    return this.prisma.tx.role_assignments.count({
      where: { user_id: userId, ...liveAt(new Date()) },
    });
  }
}

/** Never revoked, and either no deadline or a deadline still in the future. */
function liveAt(at: Date): Prisma.role_assignmentsWhereInput {
  return {
    revoked_at: null,
    OR: [{ expires_at: null }, { expires_at: { gt: at } }],
  };
}

/** The grant/revoke events carry the subject, which is what consumers order by. */
function readUserId(event: IDomainEvent): string | null {
  const candidate = event as unknown as { payload?: { userId?: unknown } };
  const userId = candidate.payload?.userId;
  return typeof userId === 'string' ? userId : null;
}

export { ROLE_ASSIGNMENT_REPOSITORY };