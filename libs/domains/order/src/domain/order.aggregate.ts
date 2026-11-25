/**
 * @fileoverview The order aggregate: the state machine that owns an order's lifecycle.
 *
 * @remarks Order owns its own state machine and nothing else — not money (billing charges),
 * not stock (inventory reserves), not the cart (read once, at creation, and copied into a
 * snapshot the order keeps for itself). Every line is frozen at creation: a later catalogue
 * price change or product rename must never rewrite what the customer already agreed to pay.
 *
 * @remarks Transitions are explicit and one-directional. The set of legal moves is a table,
 * not a pile of `if`s scattered across handlers, so "can I cancel a shipped order?" has one
 * answer and a test can assert the whole graph.
 */
import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/core';
import { InvalidStateTransitionException, ValidationException } from '@auth/platform/error-handling';
import type { OrderLinePayload, OrderPayload } from '@auth/contracts';

/** Aggregate/event identity constants — the prefix that scopes every order event. */
export const ORDER_AGGREGATE = 'Order';

/**
 * The lifecycle statuses, exactly as `order.proto` spells them.
 *
 * @remarks `draft` is the pre-checkout placeholder the saga writes before reserving stock;
 * `pending_payment` means stock is held and the charge is in flight or awaiting 3DS;
 * `canceled` is terminal and carries the reason.
 */
export const OrderStatus = {
  DRAFT: 'draft',
  PENDING_PAYMENT: 'pending_payment',
  PAID: 'paid',
  CONFIRMED: 'confirmed',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  CANCELED: 'canceled',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Reason a cancelled order reports when its caller did not name one. */
export const DEFAULT_CANCEL_REASON = OrderStatus.CANCELED;

/**
 * The transition graph. One table, one truth.
 *
 * @remarks `shipped` and beyond are forward-only: once goods leave the warehouse a
 * cancellation would be a lie to whoever already has the package. `canceled` and
 * `completed` are absorbing — nothing leaves them.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  [OrderStatus.DRAFT]: [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELED],
  [OrderStatus.PENDING_PAYMENT]: [OrderStatus.PAID, OrderStatus.CANCELED],
  [OrderStatus.PAID]: [OrderStatus.CONFIRMED, OrderStatus.CANCELED],
  [OrderStatus.CONFIRMED]: [OrderStatus.SHIPPED, OrderStatus.CANCELED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELED]: [],
};

/** Statuses from which a user-initiated cancel is legal. */
const CANCELABLE: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.DRAFT,
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.CONFIRMED,
]);

/** Statuses that imply stock was reserved by the checkout saga. */
const STOCK_HELD: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.CONFIRMED,
]);

/** Statuses that imply a successful charge may need refunding. */
const MAYBE_CHARGED: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PAID,
  OrderStatus.CONFIRMED,
]);

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  TRANSITIONS[from]?.includes(to) ?? false;

export const isCancelable = (status: OrderStatus): boolean => CANCELABLE.has(status);
export const isStockHeld = (status: OrderStatus): boolean => STOCK_HELD.has(status);
export const mayBeCharged = (status: OrderStatus): boolean => MAYBE_CHARGED.has(status);

/** One frozen line of an order. Prices are minor units and never recomputed. */
export interface OrderLine {
  readonly sku: string;
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly totalPriceMinor: number;
}

export interface OrderProps {
  userId: string;
  sessionId: string | null;
  status: OrderStatus;
  currency: string;
  subtotalMinor: number;
  totalMinor: number;
  paymentId: string | null;
  cancelReason: string | null;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  lines: OrderLine[];
  /** Position in the event stream. Not a row column; there is no optimistic lock on this table. */
  version: number;
}

/** Carried on `order.created`. */
export interface OrderCreatedPayload extends OrderPayload {
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
}

/** Carried on `order.paid`. */
export interface OrderPaidPayload extends OrderPayload {
  readonly paymentId: string;
}

/** Carried on `order.canceled`. */
export interface OrderCanceledPayload extends OrderPayload {
  readonly reason: string;
}

export class OrderCreated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: OrderCreatedPayload,
    version = 1,
  ) {
    super(aggregateId, ORDER_AGGREGATE, 'order.created', version);
  }
}

export class OrderPaid extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: OrderPaidPayload,
    version = 1,
  ) {
    super(aggregateId, ORDER_AGGREGATE, 'order.paid', version);
  }
}

export class OrderConfirmed extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: OrderPayload,
    version = 1,
  ) {
    super(aggregateId, ORDER_AGGREGATE, 'order.confirmed', version);
  }
}

export class OrderCanceled extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: OrderCanceledPayload,
    version = 1,
  ) {
    super(aggregateId, ORDER_AGGREGATE, 'order.canceled', version);
  }
}

/**
 * One `orders` row, exactly as the column names spell it.
 *
 * @remarks Declared here rather than in the repository so `fromRow` and `toRow` agree by
 * construction, and so an in-memory double in a test can be built without importing Prisma.
 */
export interface OrderRow {
  id: string;
  user_id: string;
  session_id: string | null;
  status: string;
  currency: string;
  subtotal_minor: number;
  total_minor: number;
  payment_id: string | null;
  cancel_reason: string | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** One `order_lines` row. */
export interface OrderLineRow {
  id: string;
  order_id: string;
  sku: string;
  product_id: string;
  name: string;
  quantity: number;
  unit_price_minor: number;
  total_price_minor: number;
}

/**
 * One order.
 *
 * @remarks The aggregate is the consistency boundary for the header *and* its lines *and*
 * its events. Persisting a status change without its `order.paid` event would leave a
 * consumer permanently behind; persisting them separately is how that happens.
 */
export class Order extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: OrderProps,
    createdAt: Date,
    updatedAt: Date = createdAt,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * Creates an order from a cart snapshot.
   *
   * @remarks Lines must be non-empty: an order with nothing on it is not a purchase, and
   * accepting one would put a zero-total row in the ledger that reconcilers must explain.
   *
   * @remarks Totals are computed here from the frozen lines, never taken from the caller
   * beyond the unit prices themselves: a caller that could set `totalMinor` directly could
   * order $100 of goods for $1.
   */
  static create(input: {
    id?: string;
    userId: string;
    sessionId?: string | null;
    currency: string;
    lines: readonly Omit<OrderLine, 'totalPriceMinor'>[];
    idempotencyKey?: string | null;
    requestFingerprint?: string | null;
    now?: Date;
  }): Order {
    Ensure.notEmpty(input.userId, 'userId');
    Ensure.notEmpty(input.currency, 'currency');
    Ensure.isTrue(
      input.lines.length > 0,
      'order must have at least one line',
      'INVALID_VALUE',
    );

    const currency = input.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationException('currency must be a 3-letter ISO-4217 code', {
        currency: input.currency,
      });
    }

    const now = input.now ?? new Date();
    const lines: OrderLine[] = input.lines.map((line) => {
      Ensure.notEmpty(line.sku, 'sku');
      Ensure.notEmpty(line.productId, 'productId');
      Ensure.notEmpty(line.name, 'name');
      Ensure.positive(line.quantity, 'quantity');
      Ensure.nonNegative(line.unitPriceMinor, 'unitPriceMinor');
      return { ...line, totalPriceMinor: line.unitPriceMinor * line.quantity };
    });

    const subtotalMinor = lines.reduce((sum, line) => sum + line.totalPriceMinor, 0);
    // No tax, no discount at the order layer: billing owns those. The order's `total` is
    // the sum of its frozen lines; the invoice may add tax on top at charge time.
    const totalMinor = subtotalMinor;

    const order = new Order(
      input.id ?? crypto.randomUUID(),
      {
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        status: OrderStatus.DRAFT,
        currency,
        subtotalMinor,
        totalMinor,
        paymentId: null,
        cancelReason: null,
        idempotencyKey: input.idempotencyKey ?? null,
        requestFingerprint: input.requestFingerprint ?? null,
        lines,
        version: 1,
      },
      now,
    );

    order.addDomainEvent(
      new OrderCreated(order.id, order.toPayload(OrderStatus.DRAFT), order.props.version),
    );

    return order;
  }

  /**
   * Rehydration from persistence. Does not emit events — the write already happened.
   *
   * @remarks `version` starts at zero because it is not a column: the position in this
   * order's event stream is not persisted, so a rehydrated order starts counting from its
   * next transition.
   */
  static fromRow(row: OrderRow, lines: readonly OrderLineRow[]): Order {
    return new Order(
      row.id,
      {
        userId: row.user_id,
        sessionId: row.session_id,
        status: row.status as OrderStatus,
        currency: row.currency,
        subtotalMinor: row.subtotal_minor,
        totalMinor: row.total_minor,
        paymentId: row.payment_id,
        cancelReason: row.cancel_reason,
        idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint,
        lines: lines.map(toLine),
        version: 0,
      },
      row.created_at,
      row.updated_at,
    );
  }

  /** The same aggregate, flattened the way persistence hands it back. */
  toRow(): OrderRow {
    return {
      id: this.id,
      user_id: this.props.userId,
      session_id: this.props.sessionId,
      status: this.props.status,
      currency: this.props.currency,
      subtotal_minor: this.props.subtotalMinor,
      total_minor: this.props.totalMinor,
      payment_id: this.props.paymentId,
      cancel_reason: this.props.cancelReason,
      idempotency_key: this.props.idempotencyKey,
      request_fingerprint: this.props.requestFingerprint,
      version: this.props.version,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  /** The frozen lines, ready for an `order_lines` insert. */
  toLineRows(): OrderLineRow[] {
    return this.props.lines.map((line) => ({
      id: crypto.randomUUID(),
      order_id: this.id,
      sku: line.sku,
      product_id: line.productId,
      name: line.name,
      quantity: line.quantity,
      unit_price_minor: line.unitPriceMinor,
      total_price_minor: line.totalPriceMinor,
    }));
  }

  get userId(): string {
    return this.props.userId;
  }

  get sessionId(): string | null {
    return this.props.sessionId;
  }

  get status(): OrderStatus {
    return this.props.status;
  }

  get currency(): string {
    return this.props.currency;
  }

  get subtotalMinor(): number {
    return this.props.subtotalMinor;
  }

  get totalMinor(): number {
    return this.props.totalMinor;
  }

  get paymentId(): string | null {
    return this.props.paymentId;
  }

  get cancelReason(): string | null {
    return this.props.cancelReason;
  }

  get idempotencyKey(): string | null {
    return this.props.idempotencyKey;
  }

  get requestFingerprint(): string | null {
    return this.props.requestFingerprint;
  }

  get lines(): readonly OrderLine[] {
    return this.props.lines;
  }

  /**
   * Position in this order's event stream.
   *
   * @remarks Shadows `AggregateRoot.version`, which counts *buffered* events and therefore
   * reads `0` immediately after `clearDomainEvents()` — which would make two different
   * events share a `dedup_key` and the second one be silently swallowed as a duplicate.
   */
  override get version(): number {
    return this.props.version;
  }

  get isCancelable(): boolean {
    return isCancelable(this.props.status);
  }

  get isStockHeld(): boolean {
    return isStockHeld(this.props.status);
  }

  get mayBeCharged(): boolean {
    return mayBeCharged(this.props.status);
  }

  /** Asserts `to` is legal from the current status and performs the move. */
  private transition(to: OrderStatus, now: Date): void {
    if (!canTransition(this.props.status, to)) {
      throw new InvalidStateTransitionException(
        `order cannot go from ${this.props.status} to ${to}`,
        { from: this.props.status, to },
      );
    }
    this.props.status = to;
    this.bump(now);
  }

  /**
   * Marks the order as awaiting (or holding) payment after stock was reserved.
   *
   * @remarks Stock is reserved before the charge, never after: a charge with no stock would
   * take money for goods that cannot ship, and releasing it is a refund — a much harder
   * conversation than refusing to reserve.
   */
  markPendingPayment(now: Date = new Date()): void {
    this.transition(OrderStatus.PENDING_PAYMENT, now);
  }

  /**
   * Records a successful charge.
   *
   * @remarks `paymentId` is required: an order in `paid` with no payment reference cannot
   * be refunded, which turns the next cancel into an unreconciled leak.
   */
  markPaid(paymentId: string, now: Date = new Date()): void {
    Ensure.notEmpty(paymentId, 'paymentId');
    this.transition(OrderStatus.PAID, now);
    this.props.paymentId = paymentId;

    this.addDomainEvent(
      new OrderPaid(
        this.id,
        { ...this.toPayload(OrderStatus.PAID), paymentId },
        this.props.version,
      ),
    );
  }

  /**
   * Records a payment reference without claiming the order is paid.
   *
   * @remarks `requires_action` and `processing` both mean "a payment exists but is not
   * finished". The order must remember the reference so a later cancel can refund it, but
   * flipping to `paid` would be a lie to every consumer of `order.paid` — and would emit an
   * event for money that has not settled.
   */
  attachPaymentId(paymentId: string, now: Date = new Date()): void {
    Ensure.notEmpty(paymentId, 'paymentId');
    if (this.props.paymentId === paymentId) return;
    this.props.paymentId = paymentId;
    this.updatedAt = now;
    // No bump(): this is not a state-machine transition and must not advance the event
    // stream — a payment reference on a pending order is bookkeeping, not a fact consumers
    // need on a topic.
  }

  /** Confirms a paid order (payment captured, stock still held). */
  markConfirmed(now: Date = new Date()): void {
    this.transition(OrderStatus.CONFIRMED, now);

    this.addDomainEvent(
      new OrderConfirmed(this.id, this.toPayload(OrderStatus.CONFIRMED), this.props.version),
    );
  }

  /**
   * Moves a paid order forward through fulfilment.
   *
   * @remarks Used by fulfilment-side commands (not the checkout saga). Each step emits the
   * matching integration event so downstream consumers (notification, audit) can react.
   */
  markShipped(now: Date = new Date()): void {
    this.transition(OrderStatus.SHIPPED, now);
  }

  markDelivered(now: Date = new Date()): void {
    this.transition(OrderStatus.DELIVERED, now);
  }

  markCompleted(now: Date = new Date()): void {
    this.transition(OrderStatus.COMPLETED, now);
  }

  /**
   * Cancels the order with a reason.
   *
   * @remarks Idempotent: a second cancel of an already-canceled order is a no-op, not an
   * error — operator tooling retries, and a retry must not emit a second `order.canceled`.
   *
   * @remarks Refuses statuses past `confirmed`: once goods have shipped the honest answer
   * is a return, not a cancellation that claims nothing left the warehouse.
   */
  cancel(reason: string, now: Date = new Date()): void {
    if (this.props.status === OrderStatus.CANCELED) return;

    if (!this.isCancelable) {
      throw new InvalidStateTransitionException(
        `order in status ${this.props.status} cannot be canceled`,
        { status: this.props.status, reason },
      );
    }

    const cleanReason = reason.trim() || DEFAULT_CANCEL_REASON;
    this.transition(OrderStatus.CANCELED, now);
    this.props.cancelReason = cleanReason;

    this.addDomainEvent(
      new OrderCanceled(
        this.id,
        { ...this.toPayload(OrderStatus.CANCELED), reason: cleanReason },
        this.props.version,
      ),
    );
  }

  /** Every mutation goes through here, so `version` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }

  private toPayload(status: OrderStatus): OrderPayload & { sessionId?: string; idempotencyKey?: string } {
    return {
      orderId: this.id,
      userId: this.props.userId,
      status,
      currency: this.props.currency,
      totalMinor: this.props.totalMinor,
      lines: this.props.lines.map(
        (line): OrderLinePayload => ({
          sku: line.sku,
          productId: line.productId,
          name: line.name,
          qty: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          totalPriceMinor: line.totalPriceMinor,
        }),
      ),
      ...(this.props.paymentId ? { paymentId: this.props.paymentId } : {}),
      ...(this.props.cancelReason ? { reason: this.props.cancelReason } : {}),
      ...(this.props.sessionId ? { sessionId: this.props.sessionId } : {}),
      ...(this.props.idempotencyKey
        ? { idempotencyKey: this.props.idempotencyKey }
        : {}),
    };
  }
}

function toLine(row: OrderLineRow): OrderLine {
  return {
    sku: row.sku,
    productId: row.product_id,
    name: row.name,
    quantity: row.quantity,
    unitPriceMinor: row.unit_price_minor,
    totalPriceMinor: row.total_price_minor,
  };
}

export type OrderEvent = OrderCreated | OrderPaid | OrderConfirmed | OrderCanceled;

export const isOrderEvent = (event: IDomainEvent): event is OrderEvent =>
  event.aggregateType === ORDER_AGGREGATE;
