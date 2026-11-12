/**
 * @fileoverview In-memory doubles for the order ports.
 *
 * @remarks Hand-written rather than auto-mocked: a mock asserts on the calls a test
 * *expects*, while the question these suites keep asking is "what would be stored, and
 * what would be published" — and only the resulting state answers that.
 *
 * @remarks The repository stores **rehydrated rows**, not the aggregates it was handed.
 * That is load-bearing: an assertion about `status` then proves the transition reached
 * storage, rather than proving it is sitting in an object the handler still holds. It also
 * runs `fromRow` on every read, which is where a column renamed on one side only would
 * show up.
 *
 * @remarks The peer doubles record every call so a saga test can assert the *order* of
 * forward and compensating steps — which is the whole point of a saga.
 */
import type { IDomainEvent } from '@auth/core';
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
import { Order, type OrderLineRow, type OrderRow } from '../../src/domain/order.aggregate';
import type {
  OrderPage,
  OrderRepositoryPort,
} from '../../src/domain/ports/order-repository.port';
import type {
  BillingPeerPort,
  CartPeerPort,
  InventoryPeerPort,
  PeerReserveLine,
} from '../../src/domain/ports/peer-ports';

export const USER_ID = 'user-1';
export const SESSION_ID = 'session-1';
export const ORDER_ID = '0f1e2d3c-4b5a-4697-8899-aabbccddeeff';
export const WAREHOUSE = 'main';
export const IDEMPOTENCY_KEY = 'key-1';
export const PAYMENT_ID = 'pay-1';

/** One row the repository would have written to `outbox_events`. */
export interface CapturedOutboxEvent {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly dedupKey: string;
}

/** Config for tests: the real defaults, without touching `process.env`. */
export const testOrderConfig = {
  defaultWarehouse: WAREHOUSE,
  maxPageSize: 100,
  defaultPageSize: 20,
  grpcDeadlineMs: 5_000,
} as const;

export class InMemoryOrderRepository implements OrderRepositoryPort {
  /** Stored rows keyed by id — rehydrated on every read. */
  private readonly rows = new Map<string, { header: OrderRow; lines: OrderLineRow[] }>();

  /** Every aggregate handed to a write, in call order. */
  readonly saved: string[] = [];

  readonly outbox: CapturedOutboxEvent[] = [];

  async save(order: Order): Promise<void> {
    const events = order.clearDomainEvents();
    const header = order.toRow();
    const lines = order.toLineRows();

    this.rows.set(order.id, { header, lines });
    this.saved.push(order.id);

    for (const event of events) {
      this.outbox.push({
        eventType: event.eventType,
        aggregateId: event.aggregateId,
        version: event.version,
        dedupKey: `${event.eventType}:${event.aggregateId}:${event.version}`,
      });
    }
  }

  async findById(orderId: string): Promise<Order | null> {
    const stored = this.rows.get(orderId);
    return stored ? Order.fromRow(stored.header, stored.lines) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    for (const { header, lines } of this.rows.values()) {
      if (header.idempotency_key === key) return Order.fromRow(header, lines);
    }
    return null;
  }

  async listForUser(userId: string, page: number, pageSize: number): Promise<OrderPage> {
    const all = [...this.rows.values()]
      .filter(({ header }) => header.user_id === userId)
      .sort((a, b) => b.header.created_at.getTime() - a.header.created_at.getTime());

    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    return {
      orders: slice.map(({ header, lines }) => Order.fromRow(header, lines)),
      total: all.length,
    };
  }

  async probe(): Promise<number> {
    return 0;
  }
}

/** Scripted cart peer: returns fixed validation/lines and records every call. */
export class FakeCartPeer implements CartPeerPort {
  readonly calls: string[] = [];

  constructor(
    private readonly validation: ValidateForCheckoutResponse = {
      valid: true,
      unavailableSkus: [],
      priceChanges: [],
    },
    private readonly lines: CheckoutLines = {
      lines: [
        {
          sku: 'SKU-1',
          productId: 'prod-1',
          name: 'Widget',
          quantity: 2,
          unitPrice: { amountMinor: '500', currency: 'USD' },
        },
      ],
      subtotal: { amountMinor: '1000', currency: 'USD' },
      currency: 'USD',
      version: 1,
    },
  ) {}

  async validateForCheckout(): Promise<ValidateForCheckoutResponse> {
    this.calls.push('validate');
    return this.validation;
  }

  async getCheckoutLines(): Promise<CheckoutLines> {
    this.calls.push('lines');
    return this.lines;
  }

  async clearCart(): Promise<void> {
    this.calls.push('clear');
  }
}

export interface InventoryScript {
  fullyAccepted?: boolean;
  rejected?: { sku: string; qty: number; reason: string }[];
}

/** Scripted inventory peer. */
export class FakeInventoryPeer implements InventoryPeerPort {
  readonly calls: { method: string; orderId: string }[] = [];
  releaseCount = 0;

  constructor(private readonly script: InventoryScript = {}) {}

  async reserve(orderId: string, _lines: readonly PeerReserveLine[]): Promise<ReserveResponse> {
    this.calls.push({ method: 'reserve', orderId });
    const fullyAccepted = this.script.fullyAccepted ?? true;
    return {
      fullyAccepted,
      reserved: fullyAccepted
        ? [{ sku: 'SKU-1', qty: 2, reservationId: 'res-1' }]
        : [],
      rejected: fullyAccepted ? [] : (this.script.rejected ?? [
        { sku: 'SKU-1', qty: 2, reason: 'insufficient_stock' },
      ]),
    };
  }

  async release(orderId: string): Promise<ReleaseResponse> {
    this.calls.push({ method: 'release', orderId });
    this.releaseCount += 1;
    return { releasedLines: this.releaseCount === 1 ? 2 : 0 };
  }
}

export type ChargeStatus = 'succeeded' | 'failed' | 'requires_action' | 'processing';

/** Scripted billing peer. */
export class FakeBillingPeer implements BillingPeerPort {
  readonly charges: ChargeOrderRequest[] = [];
  readonly refunds: RefundOrderRequest[] = [];
  chargeCount = 0;

  constructor(
    private readonly status: ChargeStatus = 'succeeded',
    private readonly failureCode = 'card_declined',
  ) {}

  async charge(request: ChargeOrderRequest): Promise<ChargeOrderResponse> {
    this.charges.push(request);
    this.chargeCount += 1;

    if (this.status === 'failed') {
      return {
        paymentId: '',
        status: 'failed',
        failureCode: this.failureCode,
      };
    }

    if (this.status === 'requires_action') {
      return {
        paymentId: `psp_ch_${this.chargeCount}`,
        status: 'requires_action',
        nextAction: { type: 'redirect', redirectUrl: 'https://psp.test/3ds', sdkPayload: '' },
        failureCode: '',
      };
    }

    if (this.status === 'processing') {
      return { paymentId: `psp_ch_${this.chargeCount}`, status: 'processing', failureCode: '' };
    }

    return { paymentId: PAYMENT_ID, status: 'succeeded', failureCode: '' };
  }

  async refund(request: RefundOrderRequest): Promise<RefundOrderResponse> {
    this.refunds.push(request);
    return {
      refundId: `psp_rf_${this.refunds.length}`,
      status: 'succeeded',
      refundedTotal: { amountMinor: '1000', currency: 'USD' },
    };
  }
}

/** Collects domain events from an aggregate after a mutation. */
export function drainEvents(aggregate: { clearDomainEvents(): IDomainEvent[] }): IDomainEvent[] {
  return aggregate.clearDomainEvents();
}
