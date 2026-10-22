import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import type { IDomainEvent } from '@auth/ddd-core';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  SESSION_REPOSITORY,
  type RefreshTokenMatch,
  type SessionRepositoryPort,
  type SessionSpecification,
} from '../../domain/ports/session-repository.port';
import { Session } from '../../domain/session.aggregate';
import { TokenDigester } from '../../domain/value-objects/token-digester.vo';
import { SESSION_TOKEN_PRISMA } from '../../session-token.config';

/**
 * The domain-event -> topic mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one function means adding an event cannot accidentally
 * invent a topic name that no consumer subscribes to.
 */
const TOPIC_FOR_EVENT: Record<string, string> = {
  'session.issued': Topics.SESSION_ISSUED,
  'session.refreshed': Topics.SESSION_REFRESHED,
  'session.revoked': Topics.SESSION_REVOKED,
  'session.token_reuse_detected': Topics.SESSION_TOKEN_REUSE_DETECTED,
};

@Injectable()
export class PrismaSessionRepository implements SessionRepositoryPort {
  private readonly logger = new Logger(PrismaSessionRepository.name);

  constructor(
    @Inject(SESSION_TOKEN_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  /**
   * Writes the session, its tokens and its events atomically.
   *
   * @remarks This is the transactional-outbox guarantee in its shortest form. The rows and the
   * event envelopes go in through `runInTransaction`, so either a consumer eventually hears
   * about the session or nothing about it exists at all. Emitting to Kafka after a separate
   * commit would leave a window where a login succeeded and nobody was told.
   */
  async save(session: Session): Promise<void> {
    await this.saveMany([session]);
  }

  /**
   * One transaction for every session in the batch.
   *
   * @remarks `saveMany` is not a loop of `save`s: the reuse path has to leave *all* of a
   * family's sessions revoked, and a batch that committed one at a time could be interrupted
   * halfway through, leaving the stolen token's owner still signed in.
   */
  async saveMany(sessions: readonly Session[]): Promise<void> {
    if (sessions.length === 0) return;

    const pending = sessions.map((session) => ({ session, events: session.clearDomainEvents() }));

    await this.prisma.runInTransaction(async (client) => {
      for (const { session } of pending) {
        await this.upsertSession(client, session);

        for (const token of session.refreshTokens) {
          await this.upsertToken(client, session, token);
        }
      }

      for (const { session, events } of pending) {
        for (const event of events) {
          await this.enqueue(client, event, session.id.value);
        }
      }
    });
  }

  private async upsertSession(client: PrismaClient, session: Session): Promise<void> {
    const data = {
      user_id: session.userId,
      token_family_id: session.tokenFamilyId.value,
      device_id: session.deviceId,
      status: session.status,
      issued_at: session.issuedAt,
      expires_at: session.expiresAt,
      refresh_expires_at: session.refreshExpiresAt,
      revoked_at: session.revokedAt,
      revoke_reason: session.revokeReason,
      client_ip: session.clientIp,
      user_agent: session.userAgent,
      version: session.version,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    };

    // Upsert rather than update/create: a rotation is a second write to an existing row, and
    // deciding which of the two it is would mean a read the transaction could race.
    await client.sessions.upsert({
      where: { id: session.id.value },
      create: { id: session.id.value, ...data },
      update: data,
    });
  }

  private async upsertToken(
    client: PrismaClient,
    session: Session,
    token: Session['refreshTokens'][number],
  ): Promise<void> {
    const data = {
      family_id: token.familyId,
      token_type: token.tokenType,
      jti: token.jti,
      token_digest: token.digest,
      status: token.status,
      issued_at: token.issuedAt,
      expires_at: token.expiresAt,
      rotated_to_token_id: token.rotatedToTokenId,
      retired_at: token.retiredAt,
      revoked_at: token.revokedAt,
      version: token.version,
    };

    await client.refresh_tokens.upsert({
      where: { id: token.id },
      create: { id: token.id, session_id: session.id.value, ...data },
      update: data,
    });
  }

  /**
   * Writes one outbox row per domain event.
   *
   * @remarks `dedupKey` is what makes a redelivered command safe: the unique index on
   * `(dedup_key, type)` turns a second insert of the same fact into a no-op instead of a
   * duplicate `session.revoked`. The key ends in the aggregate version so two *different*
   * revocations of the same session are still two events.
   */
  private async enqueue(
    client: PrismaClient,
    event: IDomainEvent,
    sessionId: string,
  ): Promise<void> {
    const topic = TOPIC_FOR_EVENT[event.eventType];
    if (!topic) {
      // An unmapped event is a build-time oversight. Logging and continuing is deliberate:
      // failing the transaction would roll back a perfectly valid sign-in over a topic that
      // has not been wired up yet.
      this.logger.warn(`No topic mapped for domain event "${event.eventType}"`);
      return;
    }

    const dedupKey = `${event.eventType}:${sessionId}:${event.version}`;
    const payload = readPayload(event);

    await client.outbox_events.createMany({
      data: [
        {
          id: event.eventId,
          type: event.eventType,
          aggregate_type: event.aggregateType,
          aggregate_id: sessionId,
          topic,
          // `payload` is a JSON column, so it needs Prisma's Json input type rather than a
          // plain Record; the cast is the documented boundary for that conversion.
          payload: {
            eventId: event.eventId,
            type: topic,
            schemaVersion: 1,
            occurredAt: event.occurredAt.toISOString(),
            aggregateId: sessionId,
            aggregateType: event.aggregateType,
            partitionKey: sessionId,
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

  async findById(id: string): Promise<Session | null> {
    const row = await this.prisma.tx.sessions.findUnique({
      where: { id },
      include: { refresh_tokens: true },
    });
    return row ? Session.fromRow(row) : null;
  }

  async find(spec: SessionSpecification): Promise<Session[]> {
    const rows = await this.prisma.tx.sessions.findMany({
      include: { refresh_tokens: true },
      orderBy: { created_at: 'desc' },
    });
    return rows.map(Session.fromRow).filter((session) => spec.isSatisfiedBy(session));
  }

  async count(spec: SessionSpecification): Promise<number> {
    // Evaluated against the aggregate so the domain's predicate stays the single definition
    // of "matches" — a second, SQL-side implementation would drift from it.
    const rows = await this.prisma.tx.sessions.findMany({
      include: { refresh_tokens: true },
    });
    return rows.map(Session.fromRow).filter((session) => spec.isSatisfiedBy(session)).length;
  }

  async findActiveByUser(userId: string, exceptSessionId?: string): Promise<Session[]> {
    return this.prisma.tx.sessions.findMany({
      where: {
        user_id: userId,
        status: 'active',
        ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}),
      },
      include: { refresh_tokens: true },
      orderBy: { created_at: 'desc' },
    }).then((rows) => rows.map(Session.fromRow));
  }

  async findByFamilyId(tokenFamilyId: string): Promise<Session[]> {
    // No status filter: a session revoked a moment ago is still part of the family, and the
    // reuse path needs it so its pending tokens are flushed too.
    const rows = await this.prisma.tx.sessions.findMany({
      where: { token_family_id: tokenFamilyId },
      include: { refresh_tokens: true },
    });
    return rows.map(Session.fromRow);
  }

  /**
   * Finds a presented token by digest.
   *
   * @remarks The digest is not unique-indexed — one row per issued token, hundreds of
   * millions of them, and a unique index on a hex digest is not worth the write amplification.
   * Taking the first match is enough: digests are derived from 256-bit random values, so a
   * collision is not a thing that happens, and `jti` remains the token's identity.
   */
  async findRefreshTokenByDigest(digest: string): Promise<RefreshTokenMatch | null> {
    if (typeof digest !== 'string' || digest.length !== TokenDigester.DIGEST_LENGTH) {
      // Not even a query: anything this short cannot be one of our digests, and a
      // rejection here is cheaper than the round trip an attacker would otherwise cost.
      return null;
    }

    const row = await this.prisma.tx.refresh_tokens.findFirst({
      where: { token_digest: digest },
      include: { sessions: { include: { refresh_tokens: true } } },
    });

    if (!row) return null;

    const session = Session.fromRow(row.sessions);
    // Taken from the aggregate rather than constructed separately, so the caller mutates the
    // very instance it was handed rather than a copy that gets thrown away.
    const token = session.findRefreshToken(row.id);
    if (!token) return null;

    return { session, token };
  }
}

function readPayload(event: IDomainEvent): Record<string, unknown> {
  const candidate = event as unknown as { payload?: unknown };
  return typeof candidate.payload === 'object' && candidate.payload !== null
    ? (candidate.payload as Record<string, unknown>)
    : {};
}

export { SESSION_REPOSITORY };