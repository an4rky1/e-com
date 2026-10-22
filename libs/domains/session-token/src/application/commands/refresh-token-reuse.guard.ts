import { Inject, Injectable, Logger } from '@nestjs/common';
import { TokenReuseDetectedException } from '@auth/platform/error-handling';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../../domain/ports/session-repository.port';
import { Session } from '../../domain/session.aggregate';
import {
  SESSION_TOKEN_CONFIG,
  type SessionTokenConfig,
} from '../../session-token.config';

/**
 * The response to a refresh token that has already been consumed.
 *
 * @remarks Separate from the command handler because this is the one part of rotation whose
 * value is entirely in *when* it runs: the family has to be revoked and committed before the
 * caller is told anything, and that ordering is invisible inside a handler method.
 *
 * @remarks Deliberately not a CQRS handler. It is a collaborator of one, not an entry point.
 */
@Injectable()
export class RefreshTokenReuseGuard {
  private readonly logger = new Logger(RefreshTokenReuseGuard.name);

  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
    @Inject(SESSION_TOKEN_CONFIG) private readonly config: SessionTokenConfig,
  ) {}

  /**
   * Revokes every session descended from the stolen token, then rejects the caller.
   *
   * @remarks The revocation and the rejection are deliberately in that order, and the exception
   * is raised *after* the transaction commits. Raising it inside would roll the family back —
   * leaving the attacker's session alive while the user is told they were signed out.
   *
   * @returns never — the caller always receives {@link TokenReuseDetectedException}.
   */
  async revokeFamilyAndReport(input: {
    session: Session;
    presentedTokenId: string;
    now?: Date;
  }): Promise<never> {
    const now = input.now ?? new Date();
    const { session } = input;
    const family = await this.sessions.findByFamilyId(session.tokenFamilyId.value);

    const revoked = this.config.reuseRevokesFamily
      ? Session.revokeFamilyOnReuse({
          sessions: family,
          tokenFamilyId: session.tokenFamilyId,
          ownerSessionId: session.id.value,
          presentedTokenId: input.presentedTokenId,
          now,
        })
      : [];

    this.logger.error(
      `Refresh token replay detected for session ${session.id.value} (family ${session.tokenFamilyId.value}); ` +
        `${revoked.length} session(s) revoked`,
    );

    if (revoked.length > 0) {
      // Every sibling and all of their `session.revoked` events in one transaction: anything
      // less and a failure mid-sweep would leave part of the family alive.
      await this.sessions.saveMany(revoked);
    }

    throw new TokenReuseDetectedException('refresh token has already been used', {
      sessionId: session.id.value,
      tokenFamilyId: session.tokenFamilyId.value,
      presentedTokenId: input.presentedTokenId,
      revokedSessions: revoked.length,
    });
  }
}