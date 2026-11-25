/**
 * @fileoverview Typed client and server contracts for the gRPC surface.
 *
 * Why hand-written instead of generated: the generated interfaces would come from
 * `@grpc/proto-loader` codegen, which the workspace does not run. These mirror the `.proto`
 * files in `libs/contracts/proto` one-to-one — if you change a proto, change the interface
 * in the same commit or the compiler will not catch the drift for you.
 */

// ---- identity.v1 --------------------------------------------------------------

export interface GetUserRequest {
  userId: string;
}
export interface GetUserByEmailRequest {
  email: string;
}
export interface CreateUserRequest {
  email: string;
  displayName: string;
  locale: string;
  source: string;
  /** True when the address already came vouched for (OAuth); absent means pending. */
  emailVerified?: boolean;
  /**
   * Caller-chosen id for the new account; absent lets identity generate one. Registration
   * pre-chooses it so its credential is stored against the id the account will have.
   */
  id?: string;
}
export interface CreateUserResponse {
  user?: UserResponse;
}
export interface AcquireGuestUserRequest {
  /**
   * The guest account this browser held before; absent on a first visit. Honoured only
   * when the row behind it is still a guest — anything else mints a new placeholder.
   */
  userId?: string;
}
export interface AcquireGuestUserResponse {
  user?: UserResponse;
}
export interface ResolveOauthUserRequest {
  provider: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
}
export interface ResolveOauthUserResponse {
  user?: UserResponse;
  created: boolean;
}
export interface AuthenticateRequest {
  accessToken?: string;
  sessionId?: string;
  apiKey?: string;
}
export interface AuthenticateResponse {
  authenticated: boolean;
  user?: UserResponse;
  strategy: string;
  sessionId: string;
}
export interface UserResponse {
  id: string;
  email: string;
  displayName: string;
  status: string;
  emailVerified: boolean;
  roles: string[];
  deleted: boolean;
  createdAt: string;
}
export interface UpdateUserStatusRequest {
  userId: string;
  status: string;
  reason: string;
}

export interface IdentityGrpcClient {
  GetUser(request: GetUserRequest): Promise<UserResponse>;
  GetUserByEmail(request: GetUserByEmailRequest): Promise<UserResponse>;
  CreateUser(request: CreateUserRequest): Promise<CreateUserResponse>;
  AcquireGuestUser(request: AcquireGuestUserRequest): Promise<AcquireGuestUserResponse>;
  ResolveOauthUser(request: ResolveOauthUserRequest): Promise<ResolveOauthUserResponse>;
  Authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse>;
  UpdateUserStatus(request: UpdateUserStatusRequest): Promise<UserResponse>;
}

// ---- access_control.v1 --------------------------------------------------------

export interface GetPermissionsRequest {
  userId: string;
}
export interface GetPermissionsResponse {
  roles: string[];
  permissions: string[];
}
export interface CheckPermissionRequest {
  userId: string;
  permission: string;
  context?: Record<string, string>;
}
export interface CheckPermissionResponse {
  allowed: boolean;
  reason: string;
}
export interface GrantRoleRequest {
  userId: string;
  role: string;
  grantedBy?: string;
}
export interface GrantRoleResponse {
  roles: string[];
}
export interface RevokeRoleRequest {
  userId: string;
  role: string;
}
export interface EvaluatePolicyRequest {
  userId: string;
  policy: string;
  resource?: Record<string, string>;
  context?: Record<string, string>;
}
export interface EvaluatePolicyResponse {
  allowed: boolean;
  reason: string;
}
export interface ListRolesRequest {
  /** Case-insensitive fragment matched against the name and its permissions; empty lists all. */
  search?: string;
  page?: number;
  limit?: number;
}
export interface RoleSummary {
  name: string;
  permissions: string[];
  /** Empty when the role has no description: proto3 has no null string. */
  description: string;
  isSystem: boolean;
}
export interface ListRolesResponse {
  roles: RoleSummary[];
  total: number;
  page: number;
  limit: number;
}

export interface AccessControlGrpcClient {
  GetPermissions(request: GetPermissionsRequest): Promise<GetPermissionsResponse>;
  CheckPermission(request: CheckPermissionRequest): Promise<CheckPermissionResponse>;
  GrantRole(request: GrantRoleRequest): Promise<GrantRoleResponse>;
  RevokeRole(request: RevokeRoleRequest): Promise<GrantRoleResponse>;
  EvaluatePolicy(request: EvaluatePolicyRequest): Promise<EvaluatePolicyResponse>;
  ListRoles(request: ListRolesRequest): Promise<ListRolesResponse>;
}

// ---- credential_vault.v1 ------------------------------------------------------

export interface VerifyPasswordRequest {
  userId: string;
  password: string;
  allowRehash?: boolean;
}
export interface VerifyPasswordResponse {
  valid: boolean;
  needsRehash: boolean;
  failedAttempts: number;
}
export interface SetPasswordRequest {
  userId: string;
  newPassword: string;
}
export interface SetPasswordResponse {
  ok: boolean;
  credentialId: string;
}

export interface CredentialVaultGrpcClient {
  VerifyPassword(request: VerifyPasswordRequest): Promise<VerifyPasswordResponse>;
  SetPassword(request: SetPasswordRequest): Promise<SetPasswordResponse>;
  RevokeAllCredentials(request: { userId: string; reason: string }): Promise<{ revokedCount: number }>;
}

// ---- session.v1 ---------------------------------------------------------

export interface IssueTokensRequest {
  userId: string;
  email: string;
  roles?: string[];
  permissions?: string[];
  deviceId?: string;
  ipAddress?: string;
}
export interface IssueTokensResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}
export interface RotateTokensRequest {
  refreshToken: string;
  ipAddress?: string;
  deviceId?: string;
}
export interface RotateTokensResponse extends IssueTokensResponse {
  reuseDetected: boolean;
}
export interface ValidateAccessTokenResponse {
  valid: boolean;
  userId: string;
  email: string;
  roles: string[];
  permissions: string[];
  sessionId: string;
  revocationReason: string;
}

export interface SessionGrpcClient {
  IssueTokens(request: IssueTokensRequest): Promise<IssueTokensResponse>;
  RotateTokens(request: RotateTokensRequest): Promise<RotateTokensResponse>;
  RevokeSession(request: { sessionId: string; reason: string }): Promise<{ ok: boolean }>;
  RevokeAllSessions(
    request: { userId: string; reason: string; exceptSessionId?: string },
  ): Promise<{ revokedCount: number }>;
  ValidateAccessToken(
    request: { accessToken: string },
  ): Promise<ValidateAccessTokenResponse>;
}

// ---- auth_flow.v1 ----------------------------------------------------------

export interface StartFlowRequest {
  flow: string;
  email: string;
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
  metadata?: Record<string, string>;
}
export interface AdvanceFlowRequest {
  flowId: string;
  credential: string;
  ipAddress?: string;
  deviceFingerprint?: string;
}
export interface FlowResponse {
  flowId: string;
  state: string;
  flow: string;
  accessToken?: string;
  refreshToken?: string;
  sessionId?: string;
  expiresIn?: number;
  message?: string;
  retryable?: boolean;
  locked?: boolean;
  retryAfterSeconds?: number;
}

export interface AuthFlowGrpcClient {
  StartFlow(request: StartFlowRequest): Promise<FlowResponse>;
  AdvanceFlow(request: AdvanceFlowRequest): Promise<FlowResponse>;
  GetFlow(request: { flowId: string }): Promise<FlowResponse>;
  CancelFlow(request: { flowId: string; reason: string }): Promise<FlowResponse>;
}

// ---- account_security.v1 ------------------------------------------------------

export interface RecordLoginAttemptRequest {
  userId?: string;
  email?: string;
  succeeded: boolean;
  ipAddress?: string;
  userAgent?: string;
  deviceFingerprint?: string;
}
export interface RecordLoginAttemptResponse {
  locked: boolean;
  failedAttempts: number;
  lockedUntil: number;
  securityEventId: string;
  retryAfterSeconds: number;
}
export interface RiskAssessmentResponse {
  score: number;
  level: string;
  factors: string[];
  recommendations: string[];
}

export interface AccountSecurityGrpcClient {
  RecordLoginAttempt(request: RecordLoginAttemptRequest): Promise<RecordLoginAttemptResponse>;
  AssessLoginRisk(request: Omit<RecordLoginAttemptRequest, 'succeeded'>): Promise<RiskAssessmentResponse>;
  ListDevices(request: { userId: string }): Promise<{ devices: Record<string, unknown>[] }>;
  RevokeDevice(request: { userId: string; deviceId: string }): Promise<{ ok: boolean }>;
}
// ---- catalog.v1 -------------------------------------------------------------

/** Minor units as a string: int64 does not survive a JSON number at 53 bits. */
export interface ShopMoney {
  amountMinor: string;
  currency: string;
}

export interface CatalogVariant {
  sku: string;
  price: ShopMoney;
  attrs?: Record<string, string>;
  active: boolean;
}

export interface CatalogProduct {
  id: string;
  name: string;
  description: string;
  categoryPath: readonly string[];
  variants: readonly CatalogVariant[];
  mediaKeys: readonly string[];
  active: boolean;
  version: number;
  priceRangeMin?: ShopMoney;
  priceRangeMax?: ShopMoney;
}

export interface CreateCatalogVariant {
  sku: string;
  price: ShopMoney;
  attrs?: Record<string, string>;
}

export interface CreateProductRequest {
  name: string;
  description: string;
  categoryPath: string[];
  variants: CreateCatalogVariant[];
  mediaKeys?: string[];
}

export interface SetVariantPriceRequest {
  productId: string;
  sku: string;
  price: ShopMoney;
}

export interface ArchiveProductRequest {
  productId: string;
  reason: string;
}

export interface ListByCategoryRequest {
  categoryPath: string[];
  page: number;
  pageSize: number;
}

export interface SearchProductsRequest {
  /** Case-insensitive fragment matched against the product name and description. */
  text: string;
  page: number;
  pageSize: number;
}

export interface ProductList {
  products: readonly CatalogProduct[];
  total: number;
}

export interface GetPricingRequest {
  skus: string[];
}

export interface PricedSku {
  sku: string;
  productId: string;
  price: ShopMoney;
  active: boolean;
}

export interface GetPricingResponse {
  prices: PricedSku[];
}

export interface CatalogGrpcClient {
  GetProduct(request: { id: string }): Promise<CatalogProduct>;
  ListByCategory(request: ListByCategoryRequest): Promise<ProductList>;
  SearchProducts(request: SearchProductsRequest): Promise<ProductList>;
  GetPricing(request: GetPricingRequest): Promise<GetPricingResponse>;
  CreateProduct(request: CreateProductRequest): Promise<CatalogProduct>;
  SetVariantPrice(request: SetVariantPriceRequest): Promise<CatalogProduct>;
  ArchiveProduct(request: ArchiveProductRequest): Promise<CatalogProduct>;
}

// ---- cart.v1 ---------------------------------------------------------------

export interface CartItemView {
  sku: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: ShopMoney;
  totalPrice: ShopMoney;
  addedAt: string;
  updatedAt: string;
  priceChanged: boolean;
}

export interface CartView {
  sessionId: string;
  userId: string;
  items: readonly CartItemView[];
  status: string;
  itemCount: number;
  subtotal: ShopMoney;
  total: ShopMoney;
  currency: string;
  expiresAt: string;
  version: number;
}

export interface GetCartRequest {
  sessionId: string;
  userId: string;
}

export interface AddItemRequest {
  sessionId: string;
  userId: string;
  sku: string;
  quantity: number;
}

export interface UpdateItemQtyRequest {
  sessionId: string;
  userId: string;
  sku: string;
  quantity: number;
}

export interface RemoveItemRequest {
  sessionId: string;
  userId: string;
  sku: string;
}

export interface ClearCartRequest {
  sessionId: string;
  userId: string;
}

/**
 * The explicit guest-cart merge: fold `guestSessionId`'s basket into the cart this
 * identity addresses, then drop the guest document.
 */
export interface MergeGuestCartRequest {
  sessionId: string;
  userId: string;
  guestSessionId: string;
}

export interface MergeGuestCartResponse {
  /** True only when at least one line was folded in. */
  merged: boolean;
}

export interface CheckoutLine {
  sku: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: ShopMoney;
}

export interface CheckoutLines {
  lines: readonly CheckoutLine[];
  subtotal: ShopMoney;
  currency: string;
  version: number;
}

export interface ValidateForCheckoutResponse {
  valid: boolean;
  unavailableSkus: readonly string[];
  priceChanges: readonly { sku: string; oldPrice: ShopMoney; newPrice: ShopMoney }[];
}

export interface CartGrpcClient {
  GetCart(request: GetCartRequest): Promise<CartView>;
  AddItem(request: AddItemRequest): Promise<CartView>;
  UpdateItemQty(request: UpdateItemQtyRequest): Promise<CartView>;
  RemoveItem(request: RemoveItemRequest): Promise<CartView>;
  ClearCart(request: ClearCartRequest): Promise<CartView>;
  MergeGuestCart(request: MergeGuestCartRequest): Promise<MergeGuestCartResponse>;
  GetCheckoutLines(request: GetCartRequest): Promise<CheckoutLines>;
  ValidateForCheckout(request: GetCartRequest): Promise<ValidateForCheckoutResponse>;
}

// ---- inventory.v1 ----------------------------------------------------------

export interface ReserveLine {
  sku: string;
  qty: number;
}

export interface ReserveRequest {
  orderId: string;
  lines: ReserveLine[];
  warehouseId: string;
}

export interface ReservedLine {
  sku: string;
  qty: number;
  reservationId: string;
}

export interface RejectedLine {
  sku: string;
  qty: number;
  reason: string;
}

export interface ReserveResponse {
  fullyAccepted: boolean;
  reserved: ReservedLine[];
  rejected: RejectedLine[];
}

export interface ReleaseRequest {
  orderId: string;
  warehouseId: string;
}

export interface ReleaseResponse {
  releasedLines: number;
}

export interface ShipRequest {
  orderId: string;
  lines: ReserveLine[];
  warehouseId: string;
}

export interface AdjustStockRequest {
  sku: string;
  delta: number;
  warehouseId: string;
  reason: string;
  adjustmentId: string;
}

export interface AdjustStockResponse {
  onHand: number;
  available: number;
}

export interface GetAvailableRequest {
  sku: string;
  warehouseId: string;
}

export interface GetAvailableResponse {
  sku: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  safety: number;
  available: number;
}

export interface InventoryGrpcClient {
  Reserve(request: ReserveRequest): Promise<ReserveResponse>;
  Release(request: ReleaseRequest): Promise<ReleaseResponse>;
  Ship(request: ShipRequest): Promise<{ shipped: boolean }>;
  AdjustStock(request: AdjustStockRequest): Promise<AdjustStockResponse>;
  GetAvailable(request: GetAvailableRequest): Promise<GetAvailableResponse>;
}

// ---- billing.v1 ------------------------------------------------------------

export interface ChargeLine {
  sku: string;
  quantity: number;
  unitPrice: ShopMoney;
}

export interface ChargeOrderRequest {
  orderId: string;
  /** Business-derived: `order:{orderId}:charge:{step}` — never a random UUID. */
  idempotencyKey: string;
  amount: ShopMoney;
  paymentMethodToken: string;
  customerId: string;
  /** The lines the amount was computed from; billing recomputes and refuses a mismatch. */
  lines: ChargeLine[];
  /** Tax (and shipping) jurisdiction for the recomputation; empty means the configured default. */
  customerCountry: string;
  /** Coupon the customer named, if any; unknown or inactive codes are refused. */
  couponCode?: string;
}

export interface NextAction {
  type: string;
  redirectUrl: string;
  sdkPayload: string;
}

export interface ChargeOrderResponse {
  paymentId: string;
  status: string;
  nextAction?: NextAction;
  failureCode: string;
}

export interface RefundOrderRequest {
  orderId: string;
  paymentId: string;
  /** Empty means a full refund. */
  amount?: ShopMoney;
  reason: string;
  idempotencyKey: string;
}

export interface RefundOrderResponse {
  refundId: string;
  status: string;
  refundedTotal: ShopMoney;
}

export interface InvoiceLineView {
  sku: string;
  quantity: number;
  unitPrice: ShopMoney;
  lineSubtotal: ShopMoney;
  tax: ShopMoney;
}

export interface InvoiceView {
  invoiceId: string;
  orderId: string;
  status: string;
  lines: readonly InvoiceLineView[];
  subtotal: ShopMoney;
  discount: ShopMoney;
  taxTotal: ShopMoney;
  /** Flat delivery charge; part of the gross the coupon applies to. */
  shipping: ShopMoney;
  total: ShopMoney;
  currency: string;
  couponCode: string;
  issuedAt: string;
}

export interface PreviewTotalsLine {
  sku: string;
  quantity: number;
  unitPrice: ShopMoney;
}

export interface PreviewTotalsRequest {
  customerCountry: string;
  couponCode: string;
  lines: PreviewTotalsLine[];
  currency: string;
}

export interface PreviewTotalsResponse {
  invoice: InvoiceView;
}

export interface HandlePaymentWebhookRequest {
  /** The provider's raw JSON body, byte-for-byte as received. */
  rawBody: string;
  /** `t=<unix-seconds>,v1=<hex-hmac>` — verified by billing, never by the edge. */
  signature: string;
}

export interface HandlePaymentWebhookResponse {
  /** `applied` | `duplicate` | `ignored`. */
  outcome: string;
  paymentId: string;
  status: string;
}

export interface BillingGrpcClient {
  ChargeOrder(request: ChargeOrderRequest): Promise<ChargeOrderResponse>;
  RefundOrder(request: RefundOrderRequest): Promise<RefundOrderResponse>;
  GetInvoice(request: { orderId: string }): Promise<InvoiceView>;
  PreviewTotals(request: PreviewTotalsRequest): Promise<PreviewTotalsResponse>;
  HandlePaymentWebhook(
    request: HandlePaymentWebhookRequest,
  ): Promise<HandlePaymentWebhookResponse>;
}

// ---- order.v1 --------------------------------------------------------------

export interface OrderLineView {
  sku: string;
  productId: string;
  name: string;
  quantity: number;
  unitPrice: ShopMoney;
  totalPrice: ShopMoney;
}

export interface OrderView {
  id: string;
  userId: string;
  status: string;
  lines: readonly OrderLineView[];
  subtotal: ShopMoney;
  total: ShopMoney;
  currency: string;
  paymentId: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  cancelReason: string;
}

export interface CreateOrderRequest {
  userId: string;
  sessionId: string;
  /** Caller-chosen, carried in the Idempotency-Key header. Required. */
  idempotencyKey: string;
  currency: string;
  /** Opaque PSP token for the checkout charge; empty means the default test instrument. */
  paymentMethodToken?: string;
  /** The jurisdiction the preview was priced at; empty means billing's default. */
  customerCountry?: string;
  /** The coupon the preview discounted with; billing refuses an unknown one. */
  couponCode?: string;
}

export interface ListUserOrdersRequest {
  userId: string;
  page: number;
  pageSize: number;
}

export interface ListUserOrdersResponse {
  orders: readonly OrderView[];
  total: number;
}

export interface CancelOrderRequest {
  orderId: string;
  userId: string;
  reason: string;
}

export interface OrderGrpcClient {
  CreateOrder(request: CreateOrderRequest): Promise<OrderView>;
  GetOrder(request: { orderId: string; userId: string }): Promise<OrderView>;
  ListUserOrders(request: ListUserOrdersRequest): Promise<ListUserOrdersResponse>;
  CancelOrder(request: CancelOrderRequest): Promise<OrderView>;
}
