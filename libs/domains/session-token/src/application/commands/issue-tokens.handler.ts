import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../../domain/ports/session-repository.port';
import { Session } from '../../domain/session.aggregate';
import { RefreshToken } from '../../domain/value-objects/refresh-token.vo';
import { AccessTokenCodec } from '../../domain/value-objects/access-token.vo';
import {
  SESSION_TOKEN_CONFIG,
  type SessionTokenConfig,
} from '../../session-token.config';
import {
  IssueTokensCommand,
  type IssuedTokenPair,
} from './issue-tokens.command';
import { toAppException } from './session-error-mapping';

/**
 * The single write path for issuing tokens.
 *
 * @remarks Commands are the only place mutations happen, so authorisation, auditing and
 * event publication have exactly one hook rather than one per entry point.
 */
@Injectable()
@CommandHandler(IssueTokensCommand)
export class IssueTokensHandler
  implements ICommandHandler<IssueTokensCommand, IssuedTokenPair>
{
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(SESSION_TOKEN_CONFIG) private readonly config: SessionTokenConfig,
  ) {}

  async execute(command: IssueTokensCommand): Promise<IssuedTokenPair> {
    const now = new Date();
    const refreshToken = RefreshToken.mint();

    let session: Session;
    try {
      session = Session.issue({
        userId: command.userId,
        accessTokenTtlSec: this.config.accessTokenTtlSec,
        refreshTokenTtlSec: this.config.refreshTokenTtlSec,
        refreshToken: { token: refreshToken },
        deviceId: command.deviceId ?? null,
        clientIp: command.ipAddress ?? null,
        userAgent: command.userAgent ?? null,
        now,
      });
    } catch (error) {
      throw toAppException(error);
    }

    // The repository writes the session, its refresh token and its `session.issued` event in
    // one transaction, so the plaintext below is never returned for a session that failed to
    // persist.
    await this.sessions.save(session);

    return {
      sessionId: session.id.value,
      tokenFamilyId: session.tokenFamilyId.value,
      accessToken: AccessTokenCodec.sign(
        {
          userId: session.userId,
          sessionId: session.id.value,
          tokenFamilyId: session.tokenFamilyId.value,
          email: command.email,
          roles: command.roles ?? [],
          permissions: command.permissions ?? [],
          issuedAt: now,
          expiresAt: session.expiresAt,
        },
        this.config.accessTokenSigningKey,
      ),
      refreshToken: refreshToken.value,
      expiresIn: this.config.accessTokenTtlSec,
      expiresAt: session.expiresAt.toISOString(),
    };
  }
}