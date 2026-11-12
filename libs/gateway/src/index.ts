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
  type RegisterInput,
  type SessionSummary,
} from './application/facade/gateway.service';
export {
  StorefrontService,
  type CheckoutCreateInput,
  type CheckoutPreviewInput,
  type CheckoutPreviewResult,
} from './application/facade/storefront.service';
export { OAuthService } from './application/oauth/oauth.service';
export { OAUTH_HTTP, type OAuthHttpPort } from './application/oauth/oauth.port';
export {
  OAUTH_STATE_TTL_MS,
  signOAuthState,
  verifyOAuthState,
  type OAuthStateClaims,
} from './application/oauth/oauth-state';
export {
  TELEGRAM_AUTH_FUTURE_TOLERANCE_SEC,
  TELEGRAM_AUTH_MAX_AGE_SEC,
  verifyTelegramAuth,
  type TelegramAuthProfile,
} from './application/oauth/telegram-auth';
export {
  ACCESS_CONTROL_CLIENT,
  AUTH_FLOW_CLIENT,
  BILLING_CLIENT,
  CART_CLIENT,
  CATALOG_CLIENT,
  CREDENTIAL_VAULT_CLIENT,
  FlowState,
  FURTHER_PROOF,
  IDENTITY_CLIENT,
  ORDER_CLIENT,
  SESSION_CLIENT,
  TERMINAL_FAILURES,
  type AccessControlClientPort,
  type AuthFlowClientPort,
  type AuthorizationDecision,
  type BillingClientPort,
  type CartClientPort,
  type CartIdentityInput,
  type CatalogClientPort,
  type CredentialVaultClientPort,
  type FlowProgress,
  type GatewayCartView,
  type GatewayCatalogProduct,
  type GatewayCheckoutLines,
  type GatewayCheckoutValidation,
  type GatewayInvoiceView,
  type GatewayOrderView,
  type GatewayUser,
  type GatewayUserInput,
  type IdentityClientPort,
  type OrderClientPort,
  type SessionClientPort,
  type ShopMoney,
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
  GrpcBillingClient,
  GrpcCartClient,
  GrpcCatalogClient,
  GrpcCredentialVaultClient,
  GrpcIdentityClient,
  GrpcOrderClient,
  GrpcSessionClient,
} from './infrastructure/grpc/grpc-peer-clients';
export { FetchOAuthHttp } from './infrastructure/oauth/fetch-oauth-http';
export { AuthController } from './presentation/auth.controller';
export { UsersController } from './presentation/users.controller';
export { CatalogController } from './presentation/catalog.controller';
export { CartController } from './presentation/cart.controller';
export { CheckoutController } from './presentation/checkout.controller';
export { OrdersController } from './presentation/orders.controller';
export { WebhooksController } from './presentation/webhooks.controller';
export { IdempotencyInterceptor } from './presentation/interceptors/idempotency.interceptor';
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
export { IDEMPOTENT, Idempotent } from './presentation/decorators/idempotent';
export { FEATURE_FLAG, FeatureFlag } from './presentation/decorators/feature-flag';
export {
  ClientIp,
  ClientUserAgent,
  CurrentPrincipal,
} from './presentation/decorators/current-principal.decorator';
export {
  bearerTokenOf,
  clientIpOf,
  type GatewayRequest,
} from './presentation/gateway-request';
export {
  CreateUserRequestDto,
  LoginRequestDto,
  LogoutRequestDto,
  RefreshRequestDto,
  RegisterRequestDto,
  SetPasswordRequestDto,
  toTokenPairResponse,
  toUserResponse,
  type CurrentUserResponseDto,
  type LogoutResponseDto,
  type OAuthProvidersResponseDto,
  type TokenPairResponseDto,
  type UserResponseDto,
} from './presentation/dto/gateway.dto';
export {
  AddCartItemDto,
  CancelOrderDto,
  CatalogCreateProductDto,
  CatalogSetPriceDto,
  CheckoutCreateDto,
  CheckoutPreviewDto,
  RemoveCartItemDto,
  ShopMoneyDto,
  UpdateCartItemDto,
} from './presentation/dto/storefront.dto';
