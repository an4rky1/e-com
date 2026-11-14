/**
 * @fileoverview CreateOrder idempotency and ownership rules.
 *
 * @remarks The unique key on `orders.idempotency_key` is the race backstop; the handler's
 * fingerprint check is what turns "same key, different payload" into an explicit conflict
 * instead of a silent second order — or worse, a replay of the wrong order.
 */
import 'reflect-metadata';
import {
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import { CreateOrderHandler } from '../src/application/commands/create-order.handler';
import { CancelOrderHandler } from '../src/application/commands/cancel-order.handler';
import { CreateOrderCommand, CancelOrderCommand } from '../src/application/commands/order.command';
import { GetOrderHandler, ListUserOrdersHandler } from '../src/application/queries/order.query-handlers';
import { GetOrderQuery, ListUserOrdersQuery } from '../src/application/queries/order.queries';
import { Order, OrderStatus } from '../src/domain/order.aggregate';
import {
  FakeBillingPeer,
  FakeCartPeer,
  FakeInventoryPeer,
  IDEMPOTENCY_KEY,
  InMemoryOrderRepository,
  PAYMENT_ID,
  SESSION_ID,
  USER_ID,
  testOrderConfig,
} from './support/fakes';
import { thrownAsync } from './support/helpers';

function makeHandler(overrides: {
  cart?: FakeCartPeer;
  inventory?: FakeInventoryPeer;
  billing?: FakeBillingPeer;
  repository?: InMemoryOrderRepository;
} = {}): {
  handler: CreateOrderHandler;
  repository: InMemoryOrderRepository;
  cart: FakeCartPeer;
  inventory: FakeInventoryPeer;
  billing: FakeBillingPeer;
} {
  const repository = overrides.repository ?? new InMemoryOrderRepository();
  const cart = overrides.cart ?? new FakeCartPeer();
  const inventory = overrides.inventory ?? new FakeInventoryPeer();
  const billing = overrides.billing ?? new FakeBillingPeer();

  const handler = new CreateOrderHandler(
    repository,
    cart,
    inventory,
    billing,
    testOrderConfig,
  );

  return { handler, repository, cart, inventory, billing };
}

function command(overrides: Partial<{
  userId: string;
  sessionId: string;
  idempotencyKey: string;
  currency: string;
  paymentMethodToken: string;
  customerCountry: string;
  couponCode: string;
}> = {}): CreateOrderCommand {
  return new CreateOrderCommand(
    overrides.userId ?? USER_ID,
    overrides.sessionId ?? SESSION_ID,
    overrides.idempotencyKey ?? IDEMPOTENCY_KEY,
    overrides.currency ?? 'USD',
    overrides.paymentMethodToken ?? 'pm_card_visa',
    overrides.customerCountry ?? '',
    overrides.couponCode ?? '',
  );
}

describe('CreateOrderHandler', () => {
  it('creates a paid order through the saga', async () => {
    const { handler } = makeHandler();

    const view = await handler.execute(command());

    expect(view.status).toBe(OrderStatus.PAID);
    expect(view.paymentId).toBe(PAYMENT_ID);
    expect(view.total.amountMinor).toBe('1000');
    expect(view.currency).toBe('USD');
    expect(view.lines).toHaveLength(1);
  });

  it('replays the same order for the same key and payload', async () => {
    const { handler } = makeHandler();

    const first = await handler.execute(command());
    const second = await handler.execute(command());

    expect(second.id).toBe(first.id);
    expect(second.status).toBe(first.status);
  });

  it('hands the command jurisdiction and coupon to billing for preview and charge', async () => {
    const { handler, billing } = makeHandler();

    await handler.execute(command({ customerCountry: 'DE', couponCode: 'SAVE10' }));

    expect(billing.previews[0]).toMatchObject({
      customerCountry: 'DE',
      couponCode: 'SAVE10',
    });
    expect(billing.charges[0]).toMatchObject({
      customerCountry: 'DE',
      couponCode: 'SAVE10',
    });
  });

  it('refuses the same key with a different payload as IDEMPOTENCY_CONFLICT', async () => {
    const { handler } = makeHandler();
    await handler.execute(command());

    const conflicting = new CreateOrderCommand(
      USER_ID,
      'other-session',
      IDEMPOTENCY_KEY,
      'USD',
      'pm_card_visa',
    );

    const error = await thrownAsync(() => handler.execute(conflicting));
    expect(error).toBeInstanceOf(ResourceAlreadyExistsException);
    expect((error as Error).message).toContain('IDEMPOTENCY_CONFLICT');
  });

  it('refuses the same key with a different coupon or jurisdiction as IDEMPOTENCY_CONFLICT', async () => {
    // Both inputs change what billing charges: a retry that silently swapped one would
    // replay an order priced under terms the second delivery never agreed to.
    const { handler } = makeHandler();
    await handler.execute(command({ customerCountry: 'DE', couponCode: 'SAVE10' }));

    for (const diverged of [
      command({ customerCountry: 'DE', couponCode: 'SAVE20' }),
      command({ customerCountry: 'FR', couponCode: 'SAVE10' }),
    ]) {
      const error = await thrownAsync(() => handler.execute(diverged));
      expect(error).toBeInstanceOf(ResourceAlreadyExistsException);
      expect((error as Error).message).toContain('IDEMPOTENCY_CONFLICT');
    }

    // Case is not meaningful to the country (billing uppercases before rating), so
    // 'de' replays as the original — while a coupon's case is the code itself.
    const replay = await handler.execute(
      command({ customerCountry: 'de', couponCode: 'SAVE10' }),
    );
    expect(replay.status).toBe(OrderStatus.PAID);
  });

  it('requires an idempotency key', async () => {
    const { handler } = makeHandler();

    const error = await thrownAsync(() =>
      handler.execute(new CreateOrderCommand(USER_ID, SESSION_ID, '  ', 'USD', '')),
    );

    expect(error).toBeInstanceOf(ValidationException);
  });

  it('requires a session id', async () => {
    const { handler } = makeHandler();

    const error = await thrownAsync(() =>
      handler.execute(new CreateOrderCommand(USER_ID, '', IDEMPOTENCY_KEY, 'USD', '')),
    );

    expect(error).toBeInstanceOf(ValidationException);
  });

  it('maps a declined charge to a validation error naming the failure', async () => {
    const { handler } = makeHandler({ billing: new FakeBillingPeer('failed', 'card_declined') });

    const error = await thrownAsync(() => handler.execute(command()));

    expect(error).toBeInstanceOf(ValidationException);
    expect((error as { context?: Record<string, unknown> }).context?.failureCode).toBe(
      'card_declined',
    );
  });

  it('maps insufficient stock to a validation error naming the rejected skus', async () => {
    const { handler } = makeHandler({
      inventory: new FakeInventoryPeer({ fullyAccepted: false }),
    });

    const error = await thrownAsync(() => handler.execute(command()));

    expect(error).toBeInstanceOf(ValidationException);
    expect((error as { context?: Record<string, unknown> }).context?.rejected).toEqual([
      { sku: 'SKU-1', qty: 2, reason: 'insufficient_stock' },
    ]);
  });
});

describe('CancelOrderHandler', () => {
  async function paidInView(): Promise<{ handler: CancelOrderHandler; repository: InMemoryOrderRepository; orderId: string }> {
    const repository = new InMemoryOrderRepository();
    const create = new CreateOrderHandler(
      repository,
      new FakeCartPeer(),
      new FakeInventoryPeer(),
      new FakeBillingPeer(),
      testOrderConfig,
    );
    const view = await create.execute(command());

    const handler = new CancelOrderHandler(
      repository,
      new FakeInventoryPeer(),
      new FakeBillingPeer(),
      testOrderConfig,
    );

    return { handler, repository, orderId: view.id };
  }

  it('cancels a paid order', async () => {
    const { handler, orderId } = await paidInView();

    const view = await handler.execute(new CancelOrderCommand(orderId, USER_ID, 'nope'));

    expect(view.status).toBe(OrderStatus.CANCELED);
    expect(view.cancelReason).toBe('nope');
  });

  it('is idempotent for an already-canceled order', async () => {
    const { handler, orderId } = await paidInView();
    await handler.execute(new CancelOrderCommand(orderId, USER_ID, 'first'));

    const second = await handler.execute(new CancelOrderCommand(orderId, USER_ID, 'second'));

    expect(second.cancelReason).toBe('first');
  });

  it('404s for an unknown order', async () => {
    const { handler } = await paidInView();

    const error = await thrownAsync(() =>
      handler.execute(new CancelOrderCommand('missing', USER_ID, 'x')),
    );

    expect(error).toBeInstanceOf(ResourceNotFoundException);
  });

  it('404s for another user order (no existence leak)', async () => {
    const { handler, orderId } = await paidInView();

    const error = await thrownAsync(() =>
      handler.execute(new CancelOrderCommand(orderId, 'someone-else', 'x')),
    );

    expect(error).toBeInstanceOf(ResourceNotFoundException);
  });
});

describe('GetOrderHandler', () => {
  it('returns the order for its owner', async () => {
    const repository = new InMemoryOrderRepository();
    const create = new CreateOrderHandler(
      repository,
      new FakeCartPeer(),
      new FakeInventoryPeer(),
      new FakeBillingPeer(),
      testOrderConfig,
    );
    const created = await create.execute(command());

    const get = new GetOrderHandler(repository);
    const view = await get.execute(new GetOrderQuery(created.id, USER_ID));

    expect(view.id).toBe(created.id);
    expect(view.status).toBe(OrderStatus.PAID);
  });

  it('404s when the order belongs to somebody else', async () => {
    const repository = new InMemoryOrderRepository();
    const create = new CreateOrderHandler(
      repository,
      new FakeCartPeer(),
      new FakeInventoryPeer(),
      new FakeBillingPeer(),
      testOrderConfig,
    );
    const created = await create.execute(command());

    const get = new GetOrderHandler(repository);
    const error = await thrownAsync(() =>
      get.execute(new GetOrderQuery(created.id, 'intruder')),
    );

    expect(error).toBeInstanceOf(ResourceNotFoundException);
  });
});

describe('ListUserOrdersHandler', () => {
  it('pages newest-first and clamps pageSize to the configured maximum', async () => {
    const repository = new InMemoryOrderRepository();
    const create = new CreateOrderHandler(
      repository,
      new FakeCartPeer(),
      new FakeInventoryPeer(),
      new FakeBillingPeer(),
      testOrderConfig,
    );

    for (let i = 0; i < 3; i += 1) {
      await create.execute(
        new CreateOrderCommand(USER_ID, SESSION_ID, `key-${i}`, 'USD', ''),
      );
    }

    const list = new ListUserOrdersHandler(repository, testOrderConfig);
    const page1 = await list.execute(new ListUserOrdersQuery(USER_ID, 1, 2));
    const page2 = await list.execute(new ListUserOrdersQuery(USER_ID, 2, 2));
    const huge = await list.execute(new ListUserOrdersQuery(USER_ID, 1, 10_000));

    expect(page1.total).toBe(3);
    expect(page1.orders).toHaveLength(2);
    expect(page2.orders).toHaveLength(1);
    expect(huge.orders.length).toBeLessThanOrEqual(testOrderConfig.maxPageSize);
  });

  it('rejects an empty user id', async () => {
    const list = new ListUserOrdersHandler(new InMemoryOrderRepository(), testOrderConfig);
    const error = await thrownAsync(() => list.execute(new ListUserOrdersQuery('', 1, 10)));
    expect(error).toBeInstanceOf(ValidationException);
  });
});
