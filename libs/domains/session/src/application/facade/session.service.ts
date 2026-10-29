import { Injectable } from '@nestjs/common';
// Value import on purpose: these are constructor-injected classes, and a type-only import
// would erase them before `design:paramtypes` could name them.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  toIssueTokensCommand,
  type IssuedTokenPair,
  type IssueTokensCommand,
} from '../commands/issue-tokens.command';
import {
  toRotateTokensCommand,
  type RotateTokensCommand,
} from '../commands/rotate-tokens.command';
import {
  RevokeAllSessionsCommand,
  RevokeSessionCommand,
  type RevokeAllSessionsResult,
} from '../commands/revoke-session.command';
import {
  toValidateAccessTokenCommand,
  type AccessTokenValidation,
  type ValidateAccessTokenCommand,
} from '../commands/validate-access-token.command';
import {
  GetSessionByIdQuery,
  type SessionReadModel,
} from '../queries/session.queries';

/**
 * The only public surface of the session module.
 *
 * @remarks Controllers, gRPC handlers and other services depend on this class and nothing
 * else. They therefore cannot reach the repository, the CQRS bus or the aggregate — which is
 * what makes the module's internals replaceable without touching a single caller.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  issueTokens(input: {
    userId: string;
    email: string;
    roles?: string[];
    permissions?: string[];
    deviceId?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<IssuedTokenPair> {
    return this.commandBus.execute<IssuedTokenPair>(
      toIssueTokensCommand(input) as IssueTokensCommand,
    );
  }

  rotateTokens(input: {
    refreshToken: string;
    ipAddress?: string;
    deviceId?: string;
  }): Promise<IssuedTokenPair> {
    return this.commandBus.execute<IssuedTokenPair>(
      toRotateTokensCommand(input) as RotateTokensCommand,
    );
  }

  // Constructed, not object-literalled: `CommandBus` resolves a handler from the command's
  // *class*, so a plain object reaches it as the string "Object" and dies with
  // `No handler found for the command: "Object"` — reported by the caller as an opaque 500
  // from a method that looks like it should work.
  revokeSession(sessionId: string, reason?: string): Promise<void> {
    return this.commandBus.execute<void>(
      new RevokeSessionCommand(sessionId, reason),
    );
  }

  revokeAllSessions(input: {
    userId: string;
    reason?: string;
    exceptSessionId?: string;
  }): Promise<RevokeAllSessionsResult> {
    return this.commandBus.execute(
      new RevokeAllSessionsCommand(input.userId, input.reason, input.exceptSessionId),
    );
  }

  /**
   * Never rejects for a token it does not recognise.
   *
   * @remarks A `false` result is the answer, not an error — every caller on the request path
   * asks this question about tokens that may well be stale.
   */
  validateAccessToken(accessToken: string): Promise<AccessTokenValidation> {
    return this.commandBus.execute<AccessTokenValidation>(
      toValidateAccessTokenCommand(accessToken) as ValidateAccessTokenCommand,
    );
  }

  getSessionById(sessionId: string): Promise<SessionReadModel> {
    return this.queryBus.execute(new GetSessionByIdQuery(sessionId));
  }
}

export { RevokeSessionCommand, RevokeAllSessionsCommand, GetSessionByIdQuery };
export type { SessionReadModel, RevokeAllSessionsResult, AccessTokenValidation };