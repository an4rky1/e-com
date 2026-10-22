import { Inject, Injectable } from '@nestjs/common';
// Value imports for `Command`: the commands are classes, and `CommandHandler` must receive
// the class rather than a string key or a plain object.
import { Command, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../../domain/ports/session-repository.port';
import { Session } from '../../domain/session.aggregate';
import { toAppException } from './session-error-mapping';

export class RevokeSessionCommand extends Command<void> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly sessionId: string,
    readonly reason?: string,
  ) {
    super();
  }
}

@Injectable()
@CommandHandler(RevokeSessionCommand)
export class RevokeSessionHandler
  implements ICommandHandler<RevokeSessionCommand, void>
{
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
  ) {}

  async execute(command: RevokeSessionCommand): Promise<void> {
    const session = await this.sessions.findById(command.sessionId);
    if (!session) {
      throw new ResourceNotFoundException('session not found', {
        sessionId: command.sessionId,
      });
    }

    try {
      session.revoke(command.reason ?? 'revoked');
    } catch (error) {
      throw toAppException(error);
    }

    await this.sessions.save(session);
  }
}

export interface RevokeAllSessionsResult {
  readonly revokedCount: number;
  /** Sessions deliberately left signed in — normally just the caller's own. */
  readonly exceptSessionId: string | null;
}

export class RevokeAllSessionsCommand extends Command<RevokeAllSessionsResult> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly reason?: string,
    /** Keeps the caller's current session alive: "sign out everywhere else". */
    readonly exceptSessionId?: string,
  ) {
    super();
  }
}

@Injectable()
@CommandHandler(RevokeAllSessionsCommand)
export class RevokeAllSessionsHandler
  implements ICommandHandler<RevokeAllSessionsCommand, RevokeAllSessionsResult>
{
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepositoryPort,
  ) {}

  async execute(command: RevokeAllSessionsCommand): Promise<RevokeAllSessionsResult> {
    const exceptSessionId = command.exceptSessionId ?? null;

    // The caller's own session is excluded in the query, not afterwards: it must never be
    // loaded, let alone revoked.
    const owned = await this.sessions.findActiveByUser(command.userId, exceptSessionId ?? undefined);
    const revoked = Session.revokeAllExcept(
      owned,
      exceptSessionId,
      command.reason ?? 'revoked_all',
    );

    if (revoked.length > 0) {
      // Every sibling and every one of their events in one transaction. Revoking three of a
      // user's five devices and then failing on the fourth would leave them unable to say
      // which devices are still trusted.
      await this.sessions.saveMany(revoked);
    }

    return { revokedCount: revoked.length, exceptSessionId };
  }
}