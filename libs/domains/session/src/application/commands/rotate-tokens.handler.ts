import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { TokenInvalidException } from '@auth/platform/error-handling';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../../domain/ports/session-repository.port';
import { AccessTokenCodec } from '@auth/contracts';
import { RefreshToken } from '../../domain/value-objects/refresh-token.vo';
import { TokenDigester } from '../../domain/value-objects/token-digester.vo';
import { SESSION_CONFIG } from '../../session.config';
import type { SessionConfig } from '../../session.config';
import type { IssuedTokenPair } from './issue-tokens.command';
// Value import on purpose: the guard is resolved by type, not by `@Inject`, so
// `design:paramtypes` has to name it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { RefreshTokenReuseGuard } from './refresh-token-reuse.guard';
import {
  RotateTokensCommand,
} from './rotate-tokens.command';
import { toAppException } from './session-error-mapping';

/**
 * Exchanges a refresh token for a fresh pair.
 *
 * @remarks A consumed token never reaches `rotate`: it is handed to
 * {@link RefreshTokenReuseGuard}, which treats it as theft and never returns.
 */
@Injectable()
@CommandHandler(RotateTokensCommand)
export class RotateTokensHandler
  implements ICommandHandler<RotateTokensCommand, IssuedTokenPair>
{
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(SESSION_CONFIG) private readonly config: SessionConfig,
    private readonly reuseGuard: RefreshTokenReuseGuard,
  ) {}

  async execute(command: RotateTokensCommand): Promise<IssuedTokenPair> {
    const presented = RefreshToken.tryCreate(command.refreshToken);
    if (presented.isFailure) {
      // Refused without a query: anything this short was never issued by this service, and a
      // lookup an attacker can trigger for free is a lookup worth skipping.
      throw new TokenInvalidException('refresh token is not recognised', {
        reason: 'malformed',
      });
    }

    const digest = TokenDigester.digest(presented.unwrapOrThrow());
    const match = await this.sessions.findRefreshTokenByDigest(digest);

    if (!match) {
      // An unknown digest is a wrong token, not a stolen one: nothing was ever issued that the
      // caller could have replayed.
      throw new TokenInvalidException('refresh token is not recognised', {
        tokenDigest: digest,
      });
    }

    if (match.token.isConsumed()) {
      await this.reuseGuard.revokeFamilyAndReport({
        session: match.session,
        presentedTokenId: match.token.id,
      });
    }

    const now = new Date();
    const nextRefreshToken = RefreshToken.mint();

    try {
      match.session.rotate({
        presentedTokenId: match.token.id,
        next: { token: nextRefreshToken },
        now,
      });
    } catch (error) {
      throw toAppException(error);
    }

    // One transaction covers the consumed token, its successor and `session.refreshed`: a
    // rotation that published the event without committing the swap would tell every consumer
    // about a token that is still usable.
    await this.sessions.save(match.session);

    // Rotation cannot reproduce the caller's email or role list: `sessions` stores neither, and
    // this service deliberately does not query identity for data it does not own. A consumer
    // that needs them resolves them through identity's `Authenticate`.
    return {
      sessionId: match.session.id.value,
      tokenFamilyId: match.session.tokenFamilyId.value,
      accessToken: AccessTokenCodec.sign(
        {
          userId: match.session.userId,
          sessionId: match.session.id.value,
          tokenFamilyId: match.session.tokenFamilyId.value,
          email: '',
          issuedAt: now,
          expiresAt: match.session.expiresAt,
        },
        this.config.accessTokenSigningKey,
      ),
      refreshToken: nextRefreshToken.value,
      expiresIn: this.config.accessTokenTtlSec,
      expiresAt: match.session.expiresAt.toISOString(),
    };
  }
}