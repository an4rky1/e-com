/**
 * @fileoverview Ports the checkout and cancel sagas call as a client.
 *
 * @remarks Each peer is a port in the domain layer so the saga never names a gRPC channel,
 * a proto path or a Nest transport. The infrastructure adapters implement these against
 * {@link GrpcChannel}; tests use in-memory doubles.
 *
 * @remarks Three peers, three jobs. Cart is read (and cleared) once at creation; inventory
 * reserves and releases stock; billing charges and refunds. Order never reaches into any
 * of their tables — the only coupling is this contract.
 */
import type {
  ChargeOrderRequest,
  ChargeOrderResponse,
  CheckoutLines,
  RefundOrderRequest,
  RefundOrderResponse,
  ReleaseResponse,
  ReserveResponse,
  ValidateForCheckoutResponse,
} from '@auth/contracts';

/** DI token for the cart peer. */
export const CART_PEER = Symbol('CART_PEER');

/** DI token for the inventory peer. */
export const INVENTORY_PEER = Symbol('INVENTORY_PEER');

/** DI token for the billing peer. */
export const BILLING_PEER = Symbol('BILLING_PEER');

/** One line as inventory expects to reserve it. */
export interface PeerReserveLine {
  readonly sku: string;
  readonly qty: number;
}

export interface CartPeerPort {
  /** Pre-checkout validation: unavailable SKUs and price drift since add-time. */
  validateForCheckout(sessionId: string, userId: string): Promise<ValidateForCheckoutResponse>;

  /** Snapshot of the lines the order copies when it creates an order. */
  getCheckoutLines(sessionId: string, userId: string): Promise<CheckoutLines>;

  /** Empties the basket after a successful checkout. Idempotent by contract. */
  clearCart(sessionId: string, userId: string): Promise<void>;
}

export interface InventoryPeerPort {
  /**
   * Atomically reserves stock. Idempotent per order: a redelivered reserve for the same
   * order answers exactly as the first delivery did.
   */
  reserve(orderId: string, lines: readonly PeerReserveLine[], warehouseId: string): Promise<ReserveResponse>;

  /** Releases a reservation. Idempotent: nothing reserved answers `releasedLines: 0`. */
  release(orderId: string, warehouseId: string): Promise<ReleaseResponse>;
}

export interface BillingPeerPort {
  /**
   * Charges an order. Idempotent per business key: the same key returns the same result
   * and never a second charge.
   */
  charge(request: ChargeOrderRequest): Promise<ChargeOrderResponse>;

  /**
   * Refunds a payment. Idempotent per business key: a retried cancel answers with the
   * same refund instead of a second one.
   */
  refund(request: RefundOrderRequest): Promise<RefundOrderResponse>;
}
