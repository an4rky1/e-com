/**
 * @fileoverview gRPC transport port.
 *
 * @remarks Application code injects this interface, never `ClientGrpcProxy`. That keeps the
 * Nest transport in infrastructure, and makes a unit test a plain object literal instead of
 * an open socket with fake timers.
 */

export type ConnectivityState =
  | 'IDLE'
  | 'CONNECTING'
  | 'READY'
  | 'TRANSIENT_FAILURE'
  | 'SHUTDOWN';

export interface GrpcCallOptions {
  /** Absolute deadline in epoch millis. Exceeding it aborts the call. */
  deadline: number;
  metadata?: Record<string, string>;
}

export interface GrpcChannel {
  unary<TRequest extends object, TResponse>(
    method: string,
    request: TRequest,
    options: GrpcCallOptions,
  ): Promise<TResponse>;

  getState(): ConnectivityState;

  close(): Promise<void>;
}

/** gRPC status codes this platform reacts to by name. */
export const GrpcStatus = {
  OK: 'OK',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  DEADLINE_EXCEEDED: 'DEADLINE_EXCEEDED',
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  FAILED_PRECONDITION: 'FAILED_PRECONDITION',
  ABORTED: 'ABORTED',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  UNIMPLEMENTED: 'UNIMPLEMENTED',
  INTERNAL: 'INTERNAL',
  UNAVAILABLE: 'UNAVAILABLE',
  DATA_LOSS: 'DATA_LOSS',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
} as const;

export type GrpcStatusCode =
  (typeof GrpcStatus)[keyof typeof GrpcStatus];

/** Codes worth another attempt: the dependency is busy, not broken. */
export const TRANSIENT_CODES: ReadonlySet<GrpcStatusCode> = new Set([
  GrpcStatus.UNAVAILABLE,
  GrpcStatus.DEADLINE_EXCEEDED,
  GrpcStatus.RESOURCE_EXHAUSTED,
  GrpcStatus.UNKNOWN,
  GrpcStatus.ABORTED,
]);

/** Codes that will fail identically however many times they are retried. */
export const FATAL_CODES: ReadonlySet<GrpcStatusCode> = new Set([
  GrpcStatus.CANCELLED,
  GrpcStatus.INVALID_ARGUMENT,
  GrpcStatus.NOT_FOUND,
  GrpcStatus.ALREADY_EXISTS,
  GrpcStatus.PERMISSION_DENIED,
  GrpcStatus.FAILED_PRECONDITION,
  GrpcStatus.UNIMPLEMENTED,
  GrpcStatus.INTERNAL,
  GrpcStatus.UNAUTHENTICATED,
]);

/**
 * Methods that may be retried.
 *
 * @remarks Adding an entry is a declaration that repeating the call is side-effect free.
 * `Get*`/`List*`/`Check*` qualify; anything that creates, rotates or revokes never does.
 * This is the registry that keeps a token rotation from being applied twice.
 */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  '/identity.v1.IdentityService/GetUser',
  '/identity.v1.IdentityService/GetUserByEmail',
  '/identity.v1.IdentityService/Authenticate',
  '/access_control.v1.AccessControlService/GetPermissions',
  '/access_control.v1.AccessControlService/CheckPermission',
  '/access_control.v1.AccessControlService/EvaluatePolicy',
  '/session.v1.SessionService/ValidateAccessToken',
  '/account_security.v1.AccountSecurityService/AssessLoginRisk',
  '/account_security.v1.AccountSecurityService/ListDevices',
  // Shop reads.
  '/catalog.v1.CatalogService/GetProduct',
  '/catalog.v1.CatalogService/ListByCategory',
  '/catalog.v1.CatalogService/GetPricing',
  '/cart.v1.CartService/GetCart',
  '/cart.v1.CartService/GetCheckoutLines',
  '/cart.v1.CartService/ValidateForCheckout',
  '/inventory.v1.InventoryService/GetAvailable',
  '/billing.v1.BillingService/GetInvoice',
  '/billing.v1.BillingService/PreviewTotals',
  '/order.v1.OrderService/GetOrder',
  '/order.v1.OrderService/ListUserOrders',
  // Shop writes that are idempotent by contract: a redelivered reserve for the same
  // order, a charge with the same business key or a release for an order with nothing
  // reserved must all answer exactly as the first delivery did.
  '/cart.v1.CartService/ClearCart',
  '/inventory.v1.InventoryService/Reserve',
  '/inventory.v1.InventoryService/Release',
  '/inventory.v1.InventoryService/AdjustStock',
  '/billing.v1.BillingService/ChargeOrder',
  '/billing.v1.BillingService/RefundOrder',
  // A redelivered webhook whose status already matches answers without a write, so a
  // transport retry of the same delivery is free — the aggregate owns the idempotency.
  '/billing.v1.BillingService/HandlePaymentWebhook',
]);

export type RetryDecision =
  | { retry: true; delayMs: number; reason: 'transient' | 'pushback' }
  | {
      retry: false;
      reason: 'fatal_code' | 'not_idempotent' | 'budget_exhausted';
    };

/**
 * Time-budgeted retry policy.
 *
 * @remarks The budget is per-RPC wall time, not an attempt count. An attempt count lets a
 * fast-failing call burn twenty retries inside a 50ms budget and a slow one give up after
 * two at 10s each — neither matches what the caller actually needs.
 */
export class GrpcRetryRegistry {
  constructor(
    private readonly maxRetryAttempts = 0,
    private readonly retryBudgetMs = 1_000,
    private readonly initialBackoffMs = 50,
    private readonly maxBackoffMs = 1_000,
  ) {}

  decide(
    method: string,
    code: GrpcStatusCode,
    spentMs: number,
    attempt: number,
    serverPushbackMs?: number,
  ): RetryDecision {
    if (FATAL_CODES.has(code)) {
      return { retry: false, reason: 'fatal_code' };
    }

    if (!IDEMPOTENT_METHODS.has(method)) {
      return { retry: false, reason: 'not_idempotent' };
    }

    if (attempt >= this.maxRetryAttempts) {
      return { retry: false, reason: 'budget_exhausted' };
    }

    if (spentMs >= this.retryBudgetMs) {
      return { retry: false, reason: 'budget_exhausted' };
    }

    if (serverPushbackMs !== undefined && serverPushbackMs > 0) {
      // The server knows its own load; its advice outranks the local backoff curve.
      return { retry: true, delayMs: serverPushbackMs, reason: 'pushback' };
    }

    const capped = Math.min(
      this.initialBackoffMs * 2 ** attempt,
      this.maxBackoffMs,
    );
    // Full jitter: without it, every retrying caller picks the same delay and re-arrives
    // together.
    const delayMs = Math.floor(capped / 2 + Math.random() * (capped / 2));

    return { retry: true, delayMs, reason: 'transient' };
  }
}