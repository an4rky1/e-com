import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../../domain/ports/session-repository.port';
import { AccessTokenCodec } from '../../domain/value-objects/access-token.vo';
import {
  SESSION_TOKEN_CONFIG,
  type SessionTokenConfig,
} from '../../session-token.config';
import {
  ValidateAccessTokenCommand,
  type AccessTokenValidation,
} from './validate-access-token.command';

/**
 * Answers "is this access token usable right now".
 *
 * @remarks Two independent questions, asked in order: is the token cryptographically ours and
 * unexpired, and is the session it names still alive. Both must be yes. Reporting them
 * separately matters — a caller whose session was revoked should be signed out, whereas a
 * caller with a forged token is an attack, and conflating the two produces either silent
 * sign-outs or silent acceptance.
 */
@Injectable()
@CommandHandler(ValidateAccessTokenCommand)
export class ValidateAccessTokenHandler
  implements ICommandHandler<ValidateAccessTokenCommand, AccessTokenValidation>
{
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(SESSION_TOKEN_CONFIG) private readonly config: SessionTokenConfig,
  ) {}

  async execute(command: ValidateAccessTokenCommand): Promise<AccessTokenValidation> {
    const now = new Date();

    const verified = AccessTokenCodec.verify(
      command.accessToken,
      this.config.accessTokenSigningKey,
    );
    if (verified.isFailure) {
      // No exception: "is this token valid?" has a false answer, and a throw would force
      // every caller into a try/catch for the ordinary case of an expired browser tab.
      return rejection();
    }

    const claims = verified.unwrapOrThrow();
    if (claims.exp + this.config.clockSkewSec <= Math.floor(now.getTime() / 1_000)) {
      return rejection('token_expired');
    }

    const session = await this.sessions.findById(claims.sid);
    if (!session) {
      // The signature was ours, so this is a token for a session that no longer exists — a
      // row deleted out from under a live token, which is worth reporting as "revoked".
      return rejection('session_not_found');
    }

    if (!session.isActive || session.isExpiredAt(now)) {
      return { ...claimsOf(claims), valid: false, revocationReason: session.revokeReason ?? 'revoked' };
    }

    return { ...claimsOf(claims), valid: true, revocationReason: '' };
  }
}

function claimsOf(claims: {
  sub: string;
  sid: string;
  email: string;
  roles: readonly string[];
  perms: readonly string[];
}): Omit<AccessTokenValidation, 'valid' | 'revocationReason'> {
  return {
    userId: claims.sub,
    sessionId: claims.sid,
    email: claims.email,
    roles: [...claims.roles],
    permissions: [...claims.perms],
  };
}

function rejection(revocationReason = ''): AccessTokenValidation {
  return {
    valid: false,
    userId: '',
    email: '',
    roles: [],
    permissions: [],
    sessionId: '',
    revocationReason,
  };
}