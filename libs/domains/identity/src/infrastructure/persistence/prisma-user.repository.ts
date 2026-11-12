import { Inject, Injectable } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { DOMAIN_EVENT_SINK, type DomainEventSink } from '@auth/infra/events';
import type { PrismaClient } from '../../generated/prisma/client';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
  type UserSpecification,
} from '../../domain/ports/user-repository.port';
import { User } from '../../domain/user.aggregate';
import { IDENTITY_PRISMA } from '../../identity.config';

@Injectable()
export class PrismaUserRepository implements UserRepositoryPort {
  constructor(
    @Inject(IDENTITY_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    @Inject(DOMAIN_EVENT_SINK) private readonly sink: DomainEventSink,
  ) {}

  /**
   * Writes the user and its events atomically.
   *
   * @remarks The sink opens the transaction, so the row and the `outbox_events` rows for the
   * mapped events commit together, and the drained events reach this service's own handlers
   * only after that commit. Either a consumer eventually hears about the new user or nothing
   * about it exists at all — emitting to Kafka after a separate commit would leave a window
   * where the account is live and unannounced.
   */
  async save(user: User): Promise<void> {
    const events = user.clearDomainEvents();

    await this.sink.run(this.prisma, events, async (client) => {
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

export { USER_REPOSITORY };