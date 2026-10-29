export {
  Defaults,
  SESSION_CONFIG,
  SESSION_PRISMA,
  sessionSchema,
} from './session.config';
export type { SessionConfig, SessionEnvConfig } from './session.config';
export {
  toIssueTokensCommand,
  type IssuedTokenPair,
  type IssueTokensCommand,
} from './application/commands/issue-tokens.command';
export { IssueTokensHandler } from './application/commands/issue-tokens.handler';
export {
  toRotateTokensCommand,
  type RotateTokensCommand,
} from './application/commands/rotate-tokens.command';
export { RotateTokensHandler } from './application/commands/rotate-tokens.handler';
export { RefreshTokenReuseGuard } from './application/commands/refresh-token-reuse.guard';
export {
  RevokeAllSessionsHandler,
  RevokeSessionHandler,
  type RevokeAllSessionsCommand,
  type RevokeAllSessionsResult,
  type RevokeSessionCommand,
} from './application/commands/revoke-session.command';
export {
  toValidateAccessTokenCommand,
  type AccessTokenValidation,
  type ValidateAccessTokenCommand,
} from './application/commands/validate-access-token.command';
export { ValidateAccessTokenHandler } from './application/commands/validate-access-token.handler';
export { toAppException } from './application/commands/session-error-mapping';
export {
  GetSessionByIdHandler,
  toReadModel,
  type GetSessionByIdQuery,
  type SessionReadModel,
} from './application/queries/session.queries';
export { SessionService } from './application/facade/session.service';
export {
  EXPIRED_REVOKE_REASON,
  REUSE_REVOKE_REASON,
  SESSION_AGGREGATE,
  Session,
  SessionIssued,
  SessionRevoked,
  SessionReuseDetected,
  SessionRefreshed,
  isSessionEvent,
  type SessionEvent,
  type SessionProps,
} from './domain/session.aggregate';
export {
  IssuedRefreshToken,
  type NewRefreshToken,
  type RefreshTokenProps,
} from './domain/refresh-token.entity';
export {
  SessionRuleViolation,
  SessionRefusal,
  isSessionRuleViolation,
} from './domain/session.errors';
export {
  SessionStatus,
  TERMINAL_STATUSES,
  USABLE_STATUSES,
  isSessionStatus,
} from './domain/value-objects/session-status.vo';
export {
  CONSUMED_TOKEN_STATUSES,
  TokenStatus,
  TokenType,
  isTokenStatus,
} from './domain/value-objects/token-status.vo';
export { SessionId } from './domain/value-objects/session-id.vo';
export { TokenFamilyId } from './domain/value-objects/token-family-id.vo';
export {
  REFRESH_TOKEN_BYTES,
  REFRESH_TOKEN_MIN_LENGTH,
  RefreshToken,
} from './domain/value-objects/refresh-token.vo';
export { TokenDigester } from './domain/value-objects/token-digester.vo';
export {
  AccessTokenCodec,
  AccessTokenFailure,
  type AccessTokenClaims,
  type AccessTokenIssueInput,
} from '@auth/contracts';
export {
  ActiveSessions,
  ByStatus,
  ByUser,
  SESSION_REPOSITORY,
  SessionSpecification,
  type RefreshTokenMatch,
  type SessionRepositoryPort,
} from './domain/ports/session-repository.port';
export { PrismaSessionRepository } from './infrastructure/persistence/prisma-session.repository';
export { SessionHealthIndicator } from './session.health';
export { SessionModule, createSessionModule } from './session.module';
export { SessionController } from './presentation/session.controller';
export { SessionGrpcController } from './presentation/grpc/session.grpc.controller';
export {
  AccessTokenValidationResponseDto,
  IssueTokensRequestDto,
  IssuedTokensResponseDto,
  RevokeAllSessionsRequestDto,
  RotateTokensRequestDto,
  SessionResponseDto,
  ValidateAccessTokenRequestDto,
  toSessionResponse,
  toValidationResponse,
} from './presentation/dto/session.dto';