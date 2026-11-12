import { Inject, Injectable } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { DOMAIN_EVENT_SINK, type DomainEventSink } from '@auth/infra/events';
import type { PrismaClient } from '../../generated/prisma/client';
import {
  SESSION_REPOSITORY,
  type RefreshTokenMatch,
  type SessionRepositoryPort,
  type SessionSpecification,
} from '../../domain/ports/session-repository.port';
import { Session } from '../../domain/session.aggregate';
import { TokenDigester } from '../../domain/value-objects/token-digester.vo';
import { SESSION_PRISMA } from '../../session.config';

@Injectable()
export class PrismaSessionRepository implements SessionRepositoryPort {
  constructor(
    @Inject(SESSION_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    @Inject(DOMAIN_EVENT_SINK) private readonly sink: DomainEventSink,
  ) {}

  /**
   * Writes the session, its tokens and its events atomically.
   *
   * @remarks The sink owns the transaction, so the rows and the outbox rows for the mapped
   * events commit together, and this service's handlers hear the facts only after that
   * commit. Either a consumer eventually hears about the session or nothing about it exists
   * at all — emitting to Kafka after a separate commit would leave a window where a login
   * succeeded and nobody was told.
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
    const events = pending.flatMap(({ events }) => events);

    await this.sink.run(this.prisma, events, async (client) => {
      for (const { session } of pending) {
        await this.upsertSession(client, session);

        for (const token of session.refreshTokens) {
          await this.upsertToken(client, session, token);
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

export { SESSION_REPOSITORY };