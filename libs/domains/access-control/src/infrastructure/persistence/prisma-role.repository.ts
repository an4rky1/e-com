import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
// Value import: the outbox is constructor-injected, and `emitDecoratorMetadata`
// reads the emitted value binding — a type-only import erases the DI token.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { OutboxService } from '@auth/infra/outbox';
import type { PrismaClient } from '../../generated/prisma/client';
import {
  ROLE_REPOSITORY,
  type RoleRepositoryPort,
} from '../../domain/ports/role-repository.port';
import { Role } from '../../domain/role.aggregate';
import { ACCESS_CONTROL_PRISMA } from '../../access-control.config';
import { enqueueEvents, type TopicMap } from './outbox-enqueue';

/**
 * Domain events for a role *definition*.
 *
 * @remarks Empty on purpose. A role being created is a change to configuration, not to any
 * user's access, and the catalogue has no topic for it — mapping `role.created` onto
 * `platform.role.granted.v1` would tell every consumer that somebody gained access when
 * nobody did. The events still exist, so a consumer that needs them can be given a topic
 * without changing an aggregate.
 */
const ROLE_TOPICS: TopicMap = {};

@Injectable()
export class PrismaRoleRepository implements RoleRepositoryPort {
  private readonly logger = new Logger(PrismaRoleRepository.name);

  constructor(
    @Inject(ACCESS_CONTROL_PRISMA)
    private readonly prisma: PrismaService<PrismaClient>,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Writes the role and its events atomically.
   *
   * @remarks Upsert rather than create: the role name is the natural key, and a re-run seed
   * that declares an extra permission must converge instead of failing on the primary key.
   */
  async save(role: Role): Promise<void> {
    const events = role.clearDomainEvents();

    const data = {
      permissions: role.permissions.map((permission) => permission.value),
      description: role.description,
      is_system: role.isSystem,
      updated_at: role.updatedAt,
    };

    await this.prisma.runInTransaction(async (client) => {
      await client.roles.upsert({
        where: { name: role.id },
        create: { name: role.id, created_at: role.createdAt, ...data },
        update: data,
      });

      await enqueueEvents(events, {
        outbox: this.outbox,
        logger: this.logger,
        topics: ROLE_TOPICS,
      });
    });
  }

  async delete(role: Role): Promise<void> {
    const events = role.clearDomainEvents();

    await this.prisma.runInTransaction(async (client) => {
      // Cascades to `role_assignments` and `policies` by foreign key, so deleting a role is
      // a bulk revocation. That is exactly why `Role.remove` refuses system roles.
      await client.roles.delete({ where: { name: role.id } });

      await enqueueEvents(events, {
        outbox: this.outbox,
        logger: this.logger,
        topics: ROLE_TOPICS,
      });
    });
  }

  async findByName(name: string): Promise<Role | null> {
    const row = await this.prisma.tx.roles.findUnique({
      where: { name: name.trim().toLowerCase() },
    });
    return row ? Role.fromRow(row) : null;
  }

  async findByNames(names: readonly string[]): Promise<Role[]> {
    if (names.length === 0) return [];
    const rows = await this.prisma.tx.roles.findMany({
      where: { name: { in: [...names] } },
      orderBy: { name: 'asc' },
    });
    return rows.map(Role.fromRow);
  }

  async existsByName(name: string): Promise<boolean> {
    const count = await this.prisma.tx.roles.count({
      where: { name: name.trim().toLowerCase() },
    });
    return count > 0;
  }

  async findAll(): Promise<Role[]> {
    const rows = await this.prisma.tx.roles.findMany({ orderBy: { name: 'asc' } });
    return rows.map(Role.fromRow);
  }

  async count(): Promise<number> {
    return this.prisma.tx.roles.count();
  }
}

export { ROLE_REPOSITORY };