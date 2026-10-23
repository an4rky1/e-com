/**
 * @fileoverview The api-gateway's public surface.
 *
 * @remarks An application, not a domain service: there is no aggregate, no repository and no
 * event. What is exported is what an app needs to boot the edge and what a test needs to
 * exercise it without one.
 */
export {
  GATEWAY_CONFIG,
  Defaults,
  gatewaySchema,
  peerAddressesOf,
  resolveGatewayConfig,
} from './gateway.config';
export type { GatewayConfig, GatewayEnvConfig } from './gateway.config';
export {
  GatewayChannelLifecycle,
  GatewayModule,
  createGatewayModule,
  type GatewayModuleOptions,
} from './gateway.module';
export { GatewayHealthIndicator } from './gateway.health';
export {
  GatewayService,
  type CurrentUser,
  type LoginInput,
  type LoginResult,
  type SessionSummary,
} from './application/facade/gateway.service';
export {
  ACCESS_CONTROL_CLIENT,
  AUTH_FLOW_CLIENT,
  CREDENTIAL_VAULT_CLIENT,
  FlowState,
  FURTHER_PROOF,
  IDENTITY_CLIENT,
  SESSION_CLIENT,
  TERMINAL_FAILURES,
  type AccessControlClientPort,
  type AccessTokenValidation,
  type AuthFlowClientPort,
  type AuthorizationDecision,
  type CredentialVaultClientPort,
  type FlowProgress,
  type GatewayUser,
  type GatewayUserInput,
  type IdentityClientPort,
  type SessionClientPort,
  type TokenPair,
} from './application/ports/peer-clients.port';
export type { GatewayPrincipal } from './application/ports/gateway-principal';
export {
  translatePeerFailure,
} from './infrastructure/grpc/peer-errors';
export { PeerCaller } from './infrastructure/grpc/peer-caller';
export {
  GrpcAccessControlClient,
  GrpcAuthFlowClient,
  GrpcCredentialVaultClient,
  GrpcIdentityClient,
  GrpcSessionClient,
} from './infrastructure/grpc/grpc-peer-clients';
export { AuthController } from './presentation/auth.controller';
export { UsersController } from './presentation/users.controller';
export { JwtAuthGuard } from './presentation/guards/jwt-auth.guard';
export { PermissionsGuard } from './presentation/guards/permissions.guard';
export { RateLimitGuard } from './presentation/guards/rate-limit.guard';
export { FeatureFlagGuard } from './presentation/guards/feature-flag.guard';
export {
  IS_PUBLIC_ROUTE,
  Public,
  REQUIRED_PERMISSIONS,
  RequirePermissions,
} from './presentation/decorators/route-metadata';
export { RATE_LIMIT, RateLimit } from './presentation/decorators/rate-limit';
export type { RateLimitOptions } from './presentation/decorators/rate-limit';
export { FEATURE_FLAG, FeatureFlag } from './presentation/decorators/feature-flag';
export {
  ClientIp,
  ClientUserAgent,
  CurrentPrincipal,
} from './presentation/decorators/current-principal.decorator';
export { bearerTokenOf, type GatewayRequest } from './presentation/gateway-request';
export {
  CreateUserRequestDto,
  LoginRequestDto,
  LogoutRequestDto,
  RefreshRequestDto,
  SetPasswordRequestDto,
  toTokenPairResponse,
  toUserResponse,
  type CurrentUserResponseDto,
  type LogoutResponseDto,
  type TokenPairResponseDto,
  type UserResponseDto,
} from './presentation/dto/gateway.dto';
