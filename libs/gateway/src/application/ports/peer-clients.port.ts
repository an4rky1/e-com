/**
 * @fileoverview The five peers this edge stands in front of, expressed as ports.
 *
 * @remarks Everything the gateway can ask the rest of the platform is in this file, and
 * nothing else in `libs/gateway` is allowed to name a gRPC method path, a proto package or a
 * service class. That is what makes "the gateway proxies, it does not participate" a property
 * of the module rather than a convention somebody has to remember: a use case that needs a
 * sixth answer has nowhere to get it without a new port, which is a review conversation
 * instead of a silent coupling.
 *
 * @remarks Each token is a `Symbol`. A string token is a typo away from colliding with another
 * provider and compiles cleanly; a symbol only resolves to the binding that produced it.
 */

/** auth-flow: "walk this person through the flow". Owns the state machine. */
export const AUTH_FLOW_CLIENT = Symbol('AUTH_FLOW_CLIENT');

/** identity: "who is this user". Owns the account record. */
export const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** access-control: "what may this user do". Owns every authorization answer. */
export const ACCESS_CONTROL_CLIENT = Symbol('ACCESS_CONTROL_CLIENT');

/** session: "what did we issue, and is it still valid". Owns the tokens. */
export const SESSION_CLIENT = Symbol('SESSION_CLIENT');

/** credential-vault: "prove you are this user". Owns the secrets. */
export const CREDENTIAL_VAULT_CLIENT = Symbol('CREDENTIAL_VAULT_CLIENT');

/** catalog: "what can be bought". Owns the product document. */
export const CATALOG_CLIENT = Symbol('CATALOG_CLIENT');

/** cart: "what has this shopper picked". Owns the in-progress basket. */
export const CART_CLIENT = Symbol('CART_CLIENT');

/** order: "what was placed". Owns the order state machine and the checkout saga. */
export const ORDER_CLIENT = Symbol('ORDER_CLIENT');

/** billing: "what does this cost". Owns totals, invoices and the charge path. */
export const BILLING_CLIENT = Symbol('BILLING_CLIENT');

// ---- shared shapes -----------------------------------------------------------------

/**
 * A user, as identity describes one.
 *
 * @remarks A projection rather than identity's own `UserResponse`. The gateway copies nothing
 * out of a domain library — it cannot, by construction — so this shape is written from the
 * proto alone, and drift shows up as a compile error rather than as a field that quietly
 * stopped arriving.
 */
export interface GatewayUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
  readonly emailVerified: boolean;
  readonly deleted: boolean;
  readonly createdAt: string;
}

export interface GatewayUserInput {
  readonly email: string;
  readonly displayName?: string;
  readonly locale?: string;
  readonly source?: string;
  /**
   * Caller-chosen id for the new account; absent lets identity generate one. Registration
   * pre-chooses it so the password is stored against the id the account will have — see
   * `GatewayService.register` for why the credential has to come first.
   */
  readonly id?: string;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly sessionId: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

// ---- flow states -------------------------------------------------------------------

/**
 * Where an auth flow can be, per `auth_flow.proto`.
 *
 * @remarks `as const` rather than a TypeScript `enum`. The wire carries the string, and an
 * `enum` would add a second, structurally different spelling of the same nine values that the
 * compiler is happy to let drift from the proto.
 */
export const FlowState = {
  AWAITING_CREDENTIAL: 'awaiting_credential',
  AWAITING_2FA: 'awaiting_2fa',
  AWAITING_STEP_UP: 'awaiting_step_up',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const;

export type FlowState = (typeof FlowState)[keyof typeof FlowState];

/** States that mean "the flow is over, and it did not issue a token". */
export const TERMINAL_FAILURES: ReadonlySet<FlowState> = new Set([
  FlowState.FAILED,
  FlowState.EXPIRED,
  FlowState.CANCELLED,
]);

/** States that mean "a credential was right; now prove something else". */
export const FURTHER_PROOF: ReadonlySet<FlowState> = new Set([
  FlowState.AWAITING_2FA,
  FlowState.AWAITING_STEP_UP,
]);

export interface FlowProgress {
  readonly flowId: string;
  /**
   * Kept as the wire's own string rather than narrowed to {@link FlowState}.
   *
   * @remarks auth-flow is free to add a state without a gateway deploy, and a narrowing
   * cast would quietly report an unknown state as `failed` — telling a caller with a valid
   * password that they were wrong. An unrecognised state falls through to "no token issued",
   * which is the only thing this edge can honestly claim about it.
   */
  readonly state: string;
  readonly flow: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly sessionId?: string;
  readonly expiresIn?: number;
  /** Authored for the user; safe to relay, unlike anything the gateway composes itself. */
  readonly message?: string;
  /** A refusal that ran the account out of attempts, reported by account-security. */
  readonly locked?: boolean;
  readonly retryAfterSeconds?: number;
}

// ---- ports -------------------------------------------------------------------------

export interface AuthFlowClientPort {
  startFlow(input: {
    email: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<FlowProgress>;

  /**
   * @remarks `credential` is a password, an OTP or a backup code depending on where the flow
   * currently is. The port deliberately calls it by that name: it is the one field on this
   * edge whose meaning changes per call, and a name that said "password" would be a lie
   * three lines from an MFA step.
   */
  advanceFlow(input: {
    flowId: string;
    credential: string;
    ipAddress?: string;
  }): Promise<FlowProgress>;
}

export interface IdentityClientPort {
  createUser(input: GatewayUserInput): Promise<GatewayUser>;
  /**
   * The browser's placeholder account: renewed when `userId` still names a live guest row,
   * minted fresh otherwise.
   *
   * @remarks Passing the previous id is a hint, not a claim — identity is where the "is this
   * still a guest?" check happens, so this edge never decides who the id belongs to.
   */
  acquireGuestUser(userId?: string): Promise<GatewayUser>;
  getUser(userId: string): Promise<GatewayUser>;
  /**
   * Resolves a provider account to the local user behind it — link, link-by-address, or
   * create — in the one round trip identity needs to make that decision.
   *
   * @remarks The gateway carries what the provider vouched for and nothing else; which of the
   * three outcomes happens is identity's rule, made where the linkage lives.
   */
  resolveOauthUser(input: {
    provider: string;
    subject: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
  }): Promise<{ user: GatewayUser; created: boolean }>;
}

/** A role as access-control reports it, independent of any HTTP shape. */
export interface AccessControlRole {
  readonly name: string;
  readonly permissions: readonly string[];
  readonly description: string | null;
  readonly isSystem: boolean;
}

export interface AccessControlRolePage {
  readonly roles: readonly AccessControlRole[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

export interface AccessControlClientPort {
  getPermissions(userId: string): Promise<{
    roles: readonly string[];
    permissions: readonly string[];
  }>;
  checkPermission(input: {
    userId: string;
    permission: string;
  }): Promise<AuthorizationDecision>;
  /**
   * Adds a role to a user, idempotently, and answers with the whole role set.
   *
   * @remarks The whole set rather than the delta: a caller that applied a partial list would
   * have to reconcile two answers, and would get it wrong exactly when a grant matters. A
   * role the user already holds is not an error — access-control returns the unchanged set.
   *
   * @remarks Used at the three places an account comes into existence (registration, plain
   * user creation and an OAuth first sign-in), and by the administrative grant route. A
   * retry must not create a second assignment in any of them.
   */
  grantRole(input: {
    userId: string;
    role: string;
    grantedBy?: string;
  }): Promise<readonly string[]>;
  /**
   * Removes a role from a user, idempotently, and answers with the whole remaining set.
   *
   * @remarks Revoking a role the user does not hold is not an error: an operator retrying a
   * revoke after a lost response must not get a 404 for work that is already done.
   */
  revokeRole(input: { userId: string; role: string }): Promise<readonly string[]>;
  /**
   * The role catalogue, for the administrative read that precedes a grant.
   *
   * @remarks Separate from `getPermissions`, which answers for one user and is on the hot
   * path. This one is paged and searched, and includes the seeded roles so an operator can
   * see what the baseline actually confers.
   */
  listRoles(input?: {
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<AccessControlRolePage>;
}

export interface SessionClientPort {
  /**
   * Mints a brand-new session for a user who has just proved something else — a fresh
   * password or a provider handshake — rather than rotating an existing one.
   *
   * @remarks No roles or permissions are passed: what a token's claims are worth at
   * *validation* time is session's answer to make, not this edge's snapshot of it at
   * issue time — the same reason `me` reads access-control instead of the token's claims.
   */
  issueTokens(input: {
    userId: string;
    email: string;
    ipAddress?: string;
  }): Promise<TokenPair>;
  rotateTokens(input: {
    refreshToken: string;
    ipAddress?: string;
  }): Promise<TokenPair & { readonly reuseDetected: boolean }>;
  revokeSession(input: {
    sessionId: string;
    reason: string;
  }): Promise<boolean>;
  revokeAllSessions(input: {
    userId: string;
    reason: string;
    exceptSessionId?: string;
  }): Promise<number>;
}

export interface CredentialVaultClientPort {
  setPassword(input: {
    userId: string;
    newPassword: string;
  }): Promise<{ readonly credentialId: string }>;
  /**
   * Drops every credential a user holds.
   *
   * @remarks The registration path needs it as compensation: the password is stored against
   * the id the account will have, and an address identity then refuses leaves a credential
   * nobody may reach — which must not outlive the refusal, even though nothing could log in
   * with it.
   */
  revokeAll(input: { userId: string; reason?: string }): Promise<number>;
}

// ---- shop ports ----------------------------------------------------------------------

/** Minor units as a string: int64 does not survive a JSON number at 53 bits. */
export interface ShopMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface GatewayCatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly categoryPath: readonly string[];
  readonly variants: readonly {
    readonly sku: string;
    readonly price: ShopMoney;
    readonly attrs?: Record<string, string>;
    readonly active: boolean;
  }[];
  readonly mediaKeys: readonly string[];
  readonly active: boolean;
  readonly version: number;
  readonly priceRangeMin?: ShopMoney;
  readonly priceRangeMax?: ShopMoney;
}

export interface CatalogClientPort {
  listByCategory(input: {
    categoryPath: readonly string[];
    page: number;
    pageSize: number;
  }): Promise<{ products: readonly GatewayCatalogProduct[]; total: number }>;
  searchByText(input: {
    text: string;
    page: number;
    pageSize: number;
  }): Promise<{ products: readonly GatewayCatalogProduct[]; total: number }>;
  getProduct(id: string): Promise<GatewayCatalogProduct>;
  createProduct(input: {
    name: string;
    description: string;
    categoryPath: readonly string[];
    variants: readonly {
      sku: string;
      price: ShopMoney;
      attrs?: Record<string, string>;
    }[];
    mediaKeys?: readonly string[];
  }): Promise<GatewayCatalogProduct>;
  setVariantPrice(input: {
    productId: string;
    sku: string;
    price: ShopMoney;
  }): Promise<GatewayCatalogProduct>;
}

export interface GatewayCartItem {
  readonly sku: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: ShopMoney;
  readonly totalPrice: ShopMoney;
  readonly addedAt: string;
  readonly updatedAt: string;
  readonly priceChanged: boolean;
}

export interface GatewayCartView {
  readonly sessionId: string;
  readonly userId: string;
  readonly items: readonly GatewayCartItem[];
  readonly status: string;
  readonly itemCount: number;
  readonly subtotal: ShopMoney;
  readonly total: ShopMoney;
  readonly currency: string;
  readonly expiresAt: string;
  readonly version: number;
}

export interface GatewayCheckoutLines {
  readonly lines: readonly {
    readonly sku: string;
    readonly productId: string;
    readonly name: string;
    readonly quantity: number;
    readonly unitPrice: ShopMoney;
  }[];
  readonly subtotal: ShopMoney;
  readonly currency: string;
  readonly version: number;
}

export interface GatewayCheckoutValidation {
  readonly valid: boolean;
  readonly unavailableSkus: readonly string[];
  readonly priceChanges: readonly {
    readonly sku: string;
    readonly oldPrice: ShopMoney;
    readonly newPrice: ShopMoney;
  }[];
}

/** Cart identity is taken from the JWT, never from the body. */
export interface CartIdentityInput {
  readonly userId: string;
  readonly sessionId: string;
}

export interface CartClientPort {
  getCart(identity: CartIdentityInput): Promise<GatewayCartView>;
  addItem(
    identity: CartIdentityInput,
    input: { sku: string; quantity: number },
  ): Promise<GatewayCartView>;
  updateItemQty(
    identity: CartIdentityInput,
    input: { sku: string; quantity: number },
  ): Promise<GatewayCartView>;
  removeItem(
    identity: CartIdentityInput,
    input: { sku: string },
  ): Promise<GatewayCartView>;
  clearCart(identity: CartIdentityInput): Promise<GatewayCartView>;
  /**
   * Folds the guest basket `guestSessionId` names into the cart this identity addresses.
   *
   * @remarks `merged: false` means there was no guest basket — an ordinary answer, never a
   * failure — so the caller retries nothing and reports nothing for it.
   */
  mergeGuestCart(
    identity: CartIdentityInput,
    guestSessionId: string,
  ): Promise<{ merged: boolean }>;
  getCheckoutLines(identity: CartIdentityInput): Promise<GatewayCheckoutLines>;
  validateForCheckout(identity: CartIdentityInput): Promise<GatewayCheckoutValidation>;
}

export interface GatewayOrderView {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly lines: readonly {
    readonly sku: string;
    readonly productId: string;
    readonly name: string;
    readonly quantity: number;
    readonly unitPrice: ShopMoney;
    readonly totalPrice: ShopMoney;
  }[];
  readonly subtotal: ShopMoney;
  readonly total: ShopMoney;
  readonly currency: string;
  readonly paymentId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly cancelReason: string;
}

export interface OrderClientPort {
  createOrder(input: {
    userId: string;
    sessionId: string;
    idempotencyKey: string;
    /** The jurisdiction billing priced the preview at; charge reconciles against it. */
    customerCountry: string;
    /** The coupon the preview discounted with; billing refuses an unknown one. */
    couponCode: string;
    currency: string;
    paymentMethodToken?: string;
  }): Promise<GatewayOrderView>;
  getOrder(input: { orderId: string; userId: string }): Promise<GatewayOrderView>;
  listUserOrders(input: {
    userId: string;
    page: number;
    pageSize: number;
  }): Promise<{ orders: readonly GatewayOrderView[]; total: number }>;
  cancelOrder(input: {
    orderId: string;
    userId: string;
    reason: string;
  }): Promise<GatewayOrderView>;
}

export interface GatewayInvoiceView {
  readonly invoiceId: string;
  readonly orderId: string;
  readonly status: string;
  readonly lines: readonly {
    readonly sku: string;
    readonly quantity: number;
    readonly unitPrice: ShopMoney;
    readonly lineSubtotal: ShopMoney;
    readonly tax: ShopMoney;
  }[];
  readonly subtotal: ShopMoney;
  readonly discount: ShopMoney;
  readonly taxTotal: ShopMoney;
  readonly shipping: ShopMoney;
  readonly total: ShopMoney;
  readonly currency: string;
  readonly couponCode: string;
  readonly issuedAt: string;
}

export interface BillingClientPort {
  previewTotals(input: {
    customerCountry: string;
    couponCode: string;
    lines: readonly { sku: string; quantity: number; unitPrice: ShopMoney }[];
    currency: string;
  }): Promise<GatewayInvoiceView>;
  /**
   * Forwards one provider webhook to billing, which verifies the signature.
   *
   * @remarks The edge never parses or trusts the body: it hands billing the exact bytes
   * and the signature header, because "was this authentic" is a money question and this
   * service owns no secret that could answer it.
   */
  handlePaymentWebhook(input: {
    rawBody: string;
    signature: string;
  }): Promise<{ outcome: string; paymentId: string; status: string }>;
}
