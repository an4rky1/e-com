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

/** auth-gateway: "walk this person through the flow". Owns the state machine. */
export const AUTH_FLOW_CLIENT = Symbol('AUTH_FLOW_CLIENT');

/** identity: "who is this user". Owns the account record. */
export const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** access-control: "what may this user do". Owns every authorization answer. */
export const ACCESS_CONTROL_CLIENT = Symbol('ACCESS_CONTROL_CLIENT');

/** session-token: "what did we issue, and is it still valid". Owns the tokens. */
export const SESSION_CLIENT = Symbol('SESSION_CLIENT');

/** credential-vault: "prove you are this user". Owns the secrets. */
export const CREDENTIAL_VAULT_CLIENT = Symbol('CREDENTIAL_VAULT_CLIENT');

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
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly sessionId: string;
}

export interface AccessTokenValidation {
  readonly valid: boolean;
  readonly userId: string;
  readonly email: string;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly sessionId: string;
  readonly revocationReason: string;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

// ---- flow states -------------------------------------------------------------------

/**
 * Where an auth flow can be, per `auth_gateway.proto`.
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
   * @remarks auth-gateway is free to add a state without a gateway deploy, and a narrowing
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
  getUser(userId: string): Promise<GatewayUser>;
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
}

export interface SessionClientPort {
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
  validateAccessToken(accessToken: string): Promise<AccessTokenValidation>;
}

export interface CredentialVaultClientPort {
  setPassword(input: {
    userId: string;
    newPassword: string;
  }): Promise<{ readonly credentialId: string }>;
}
