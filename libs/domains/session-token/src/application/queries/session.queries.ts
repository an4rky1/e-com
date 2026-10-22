import { Inject, Injectable } from '@nestjs/common';
// Value imports: the query is a class, because `@nestjs/cqrs` resolves handlers from
// `query.constructor`.
import { Command, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../../domain/ports/session-repository.port';
import type { Session } from '../../domain/session.aggregate';

// ---- read model -----------------------------------------------------------------

/**
 * What an operator or a gateway is allowed to see about a session.
 *
 * @remarks Built by a pure mapper rather than serialising the aggregate. The aggregate holds
 * refresh-token *digests* and an event buffer; handing it to a response serialiser is how
 * internal fields end up on the wire and later become de facto API.
 */
export interface SessionReadModel {
  id: string;
  userId: string;
  tokenFamilyId: string;
  deviceId: string | null;
  status: string;
  issuedAt: Date;
  expiresAt: Date;
  refreshExpiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  clientIp: string | null;
  userAgent: string | null;
  version: number;
  /** Never the digests — only how many tokens exist and which one is still usable. */
  refreshTokenCount: number;
  activeRefreshTokenId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const toReadModel = (session: Session): SessionReadModel => ({
  id: session.id.value,
  userId: session.userId,
  tokenFamilyId: session.tokenFamilyId.value,
  deviceId: session.deviceId,
  status: session.status,
  issuedAt: session.issuedAt,
  expiresAt: session.expiresAt,
  refreshExpiresAt: session.refreshExpiresAt,
  revokedAt: session.revokedAt,
  revokeReason: session.revokeReason,
  clientIp: session.clientIp,
  userAgent: session.userAgent,
  version: session.version,
  refreshTokenCount: session.refreshTokens.length,
  activeRefreshTokenId: session.activeRefreshToken?.id ?? null,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

// ---- queries --------------------------------------------------------------------

export class GetSessionByIdQuery extends Command<SessionReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(
    readonly sessionId: string,
  ) {
    super();
  }
}

@Injectable()
@QueryHandler(GetSessionByIdQuery)
export class GetSessionByIdHandler
  implements IQueryHandler<GetSessionByIdQuery, SessionReadModel>
{
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
  ) {}

  async execute(query: GetSessionByIdQuery): Promise<SessionReadModel> {
    const session = await this.sessions.findById(query.sessionId);
    if (!session) {
      throw new ResourceNotFoundException('session not found', {
        sessionId: query.sessionId,
      });
    }
    return toReadModel(session);
  }
}