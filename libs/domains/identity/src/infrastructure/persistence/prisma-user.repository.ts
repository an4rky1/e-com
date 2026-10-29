import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { OutboxService } from '@auth/infra/outbox';
import { Topics } from '@auth/contracts';
import type { IDomainEvent } from '@auth/core';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
  type UserSpecification,
} from '../../domain/ports/user-repository.port';
import { User } from '../../domain/user.aggregate';
import { IDENTITY_PRISMA } from '../../identity.config';

/**
 * The `user.registered` -> `platform.user.registered.v1` mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one function means adding an event cannot accidentally
 * invent a topic name that no consumer subscribes to.
 */
const TOPIC_FOR_EVENT: Record<string, string> = {
  'user.registered': Topics.USER_REGISTERED,
  'user.email_verified': Topics.USER_EMAIL_VERIFIED,
  'user.deleted': Topics.USER_DELETED,
};

@Injectable()
export class PrismaUserRepository implements UserRepositoryPort {
  private readonly logger = new Logger(PrismaUserRepository.name);

  constructor(
    @Inject(IDENTITY_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Writes the user and its events atomically.
   *
   * @remarks This is the transactional-outbox guarantee in its shortest form. The rows and
   * the event envelopes go in through `runInTransaction`, so either a consumer eventually
   * hears about the new user or nothing about it exists at all. Emitting to Kafka after a
   * separate commit would leave a window where the account is live and unannounced.
   */
  async save(user: User): Promise<void> {
    const events = user.clearDomainEvents();

    await this.prisma.runInTransaction(async (client) => {
      await client.users.upsert({
        where: { id: user.id },
        create: {
          id: user.id,
          email: user.email.value,
          display_name: user.displayName,
          locale: user.locale,
          status: user.status,
          email_verified: user.emailVerified,
          version: user.version,
          created_at: user.createdAt,
          updated_at: user.updatedAt,
          deleted_at: user.deletedAt,
          deleted_reason: user.deletedReason,
        },
        update: {
          email: user.email.value,
          display_name: user.displayName,
          locale: user.locale,
          status: user.status,
          email_verified: user.emailVerified,
          version: user.version,
          updated_at: user.updatedAt,
          deleted_at: user.deletedAt,
          deleted_reason: user.deletedReason,
        },
      });

      for (const event of events) {
        await this.enqueue(client, event, user.id);
      }
    });
  }

  /**
   * Writes one outbox row per domain event.
   *
   * @remarks `dedupKey` is what makes a redelivered command safe: the unique index on
   * `(dedup_key, type)` turns a second insert of the same fact into a no-op instead of a
   * duplicate `user.registered`.
   */
  private async enqueue(
    client: PrismaClient,
    event: IDomainEvent,
    userId: string,
  ): Promise<void> {
    const topic = TOPIC_FOR_EVENT[event.eventType];
    if (!topic) {
      // An unmapped event is a build-time oversight. Logging and continuing is deliberate:
      // failing the transaction would roll back a perfectly valid user registration over a
      // topic that has not been wired up yet.
      this.logger.warn(`No topic mapped for domain event "${event.eventType}"`);
      return;
    }

    const dedupKey = `${event.eventType}:${userId}:${event.version}`;
    const payload = readPayload(event);

    await client.outbox_events.createMany({
      data: [
        {
          id: event.eventId,
          type: event.eventType,
          aggregate_type: event.aggregateType,
          aggregate_id: userId,
          topic,
          // `payload` is a JSON column, so it needs Prisma's Json input type rather than a
          // plain Record; the cast is the documented boundary for that conversion.
          payload: {
            eventId: event.eventId,
            type: topic,
            schemaVersion: 1,
            occurredAt: event.occurredAt.toISOString(),
            aggregateId: userId,
            aggregateType: event.aggregateType,
            partitionKey: userId,
            payload,
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

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.tx.users.findUnique({ where: { id } });
    return row ? User.fromRow(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    // Matches the `lower(email)` unique index, so lookup semantics match what registration
    // enforces — otherwise `Bob@x.com` and `bob@x.com` could both be inserted.
    const row = await this.prisma.tx.users.findFirst({
      where: { email: email.trim().toLowerCase() },
    });
    return row ? User.fromRow(row) : null;
  }

  async existsByEmail(email: string): Promise<boolean> {
    const count = await this.prisma.tx.users.count({
      where: { email: email.trim().toLowerCase() },
    });
    return count > 0;
  }

  async findAuthIdentity(provider: string, subject: string): Promise<string | null> {
    const row = await this.prisma.tx.user_auth_identities.findUnique({
      where: { provider_subject: { provider, subject } },
      select: { user_id: true },
    });
    return row?.user_id ?? null;
  }

  async linkAuthIdentity(link: {
    readonly provider: string;
    readonly subject: string;
    readonly userId: string;
    readonly email?: string;
  }): Promise<void> {
    await this.prisma.tx.user_auth_identities.create({
      data: {
        id: crypto.randomUUID(),
        user_id: link.userId,
        provider: link.provider,
        subject: link.subject,
        email: link.email ?? null,
      },
    });
  }

  async find(spec: UserSpecification): Promise<User[]> {
    const rows = await this.prisma.tx.users.findMany({ orderBy: { created_at: 'desc' } });
    return rows.map(User.fromRow).filter((user) => spec.isSatisfiedBy(user));
  }

  async count(spec: UserSpecification): Promise<number> {
    // Evaluated against the aggregate so the domain's predicate stays the single definition
    // of "matches" — a second, SQL-side implementation would drift from it.
    const rows = await this.prisma.tx.users.findMany();
    return rows.map(User.fromRow).filter((user) => spec.isSatisfiedBy(user)).length;
  }
}

function readPayload(event: IDomainEvent): Record<string, unknown> {
  const candidate = event as unknown as { payload?: unknown };
  return typeof candidate.payload === 'object' && candidate.payload !== null
    ? (candidate.payload as Record<string, unknown>)
    : {};
}

export { USER_REPOSITORY };