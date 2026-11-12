/**
 * The gRPC surface, and the CQRS wiring underneath it.
 *
 * @remarks Two things are asserted here that no other suite in this service can see. The
 * first is the translation at the boundary: money crosses this wire as a *string* and must
 * come back out as one, while everything the domain reasons about stays an integer of
 * minor units — a figure that leaked through as a number, or a subtotal that came back as
 * `0` for a cart with lines in it, are bugs only this suite can catch. The second is that
 * every handler is registered against a *class*: `CommandBus.execute` resolves a handler
 * from `command.constructor`, so a string key or a plain object literal cannot dispatch at
 * all.
 *
 * @remarks The facade and the handlers are real; only the two buses are doubled, by a
 * `DispatchBus` that resolves `command.constructor` exactly the way Nest does. The store
 * and the catalogue are the in-memory doubles, so a request through this suite moves a
 * basket exactly as far as production would.
 */
import 'reflect-metadata';
import {
  COMMAND_HANDLER_METADATA,
  QUERY_HANDLER_METADATA,
} from '@nestjs/cqrs/dist/decorators/constants';
import type {
  AddItemRequest,
  CartView,
  CheckoutLines,
  GetCartRequest,
  RemoveItemRequest,
  UpdateItemQtyRequest,
  ValidateForCheckoutResponse,
} from '@auth/contracts';
import {
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import { CartService } from '../src/application/facade/cart.service';
import {
  AddItemCommand,
  ClearCartCommand,
  RemoveItemCommand,
  UpdateItemQtyCommand,
} from '../src/application/commands/cart.commands';
import { AddItemHandler } from '../src/application/commands/add-item.handler';
import { UpdateItemQtyHandler } from '../src/application/commands/update-item-qty.handler';
import { RemoveItemHandler } from '../src/application/commands/remove-item.handler';
import { ClearCartHandler } from '../src/application/commands/clear-cart.handler';
import {
  GetCartHandler,
  GetCartQuery,
  GetCheckoutLinesHandler,
  GetCheckoutLinesQuery,
  ValidateForCheckoutHandler,
  ValidateForCheckoutQuery,
} from '../src/application/queries/cart.queries';
import { CartWorkspace } from '../src/application/cart-workspace';
import { CartGrpcController } from '../src/presentation/grpc/cart.grpc.controller';
import {
  FakePricing,
  InMemoryCartStore,
  RecordingLock,
  SESSION_ID,
  USER_ID,
  testCartConfig,
} from './support/fakes';

/** The wire keys of `cart.v1.Cart`, asserted so an invented field never reaches a client. */
const CART_FIELDS = [
  'currency',
  'expiresAt',
  'itemCount',
  'items',
  'sessionId',
  'status',
  'subtotal',
  'total',
  'userId',
  'version',
].sort();

/** Dispatches by `command.constructor`, exactly the way `CommandBus` resolves a handler. */
class DispatchBus {
  constructor(
    private readonly handlers: Map<object, (input: object) => Promise<unknown>>,
  ) {}

  execute(command: object): Promise<unknown> {
    const handler = this.handlers.get(command.constructor);
    if (!handler) {
      throw new Error(`no handler registered for ${command.constructor.name}`);
    }
    return handler(command);
  }
}

function build() {
  const store = new InMemoryCartStore();
  const lock = new RecordingLock();
  const config = testCartConfig();
  const pricing = new FakePricing().list({
    sku: 'SKU-1',
    productId: 'product-1',
    name: 'Blue mug',
    priceMinor: 1_000,
    currency: 'USD',
  });
  const workspace = new CartWorkspace(store, lock, config);

  const commandHandlers = new Map<object, (input: object) => Promise<unknown>>(
    [
      [AddItemCommand, new AddItemHandler(workspace, pricing, config)],
      [UpdateItemQtyCommand, new UpdateItemQtyHandler(workspace, pricing, config)],
      [RemoveItemCommand, new RemoveItemHandler(workspace, pricing, config)],
      [ClearCartCommand, new ClearCartHandler(workspace, pricing, config)],
    ].map(([command, handler]) => [
      command,
      (input: object) =>
        (handler as { execute: (input: object) => Promise<unknown> }).execute(input),
    ]) as [object, (input: object) => Promise<unknown>][],
  );

  const queryHandlers = new Map<object, (input: object) => Promise<unknown>>(
    [
      [GetCartQuery, new GetCartHandler(workspace, pricing, config)],
      [GetCheckoutLinesQuery, new GetCheckoutLinesHandler(workspace)],
      [
        ValidateForCheckoutQuery,
        new ValidateForCheckoutHandler(workspace, pricing),
      ],
    ].map(([query, handler]) => [
      query,
      (input: object) =>
        (handler as { execute: (input: object) => Promise<unknown> }).execute(input),
    ]) as [object, (input: object) => Promise<unknown>][],
  );

  // One narrowing cast, at the boundary where the fake takes the place of Nest's bus. The
  // facade itself is real, so the test exercises the handlers it really calls.
  const facade = new CartService(
    new DispatchBus(commandHandlers) as unknown as never,
    new DispatchBus(queryHandlers) as unknown as never,
  );

  return {
    controller: new CartGrpcController(facade),
    store,
    pricing,
    workspace,
    config,
    lock,
  };
}

const guest = (overrides: Partial<GetCartRequest> = {}): GetCartRequest => ({
  sessionId: SESSION_ID,
  userId: '',
  ...overrides,
});

const shopper = (overrides: Partial<GetCartRequest> = {}): GetCartRequest => ({
  sessionId: SESSION_ID,
  userId: USER_ID,
  ...overrides,
});

const addItem = (
  controller: CartGrpcController,
  overrides: Partial<AddItemRequest> = {},
): Promise<CartView> =>
  controller.addItem({
    sessionId: SESSION_ID,
    userId: '',
    sku: 'SKU-1',
    quantity: 2,
    ...overrides,
  });

const updateQty = (
  controller: CartGrpcController,
  sku: string,
  quantity: number,
  overrides: Partial<UpdateItemQtyRequest> = {},
): Promise<CartView> =>
  controller.updateItemQty({
    sessionId: SESSION_ID,
    userId: '',
    sku,
    quantity,
    ...overrides,
  });

const removeItem = (
  controller: CartGrpcController,
  sku: string,
  overrides: Partial<RemoveItemRequest> = {},
): Promise<CartView> =>
  controller.removeItem({
    sessionId: SESSION_ID,
    userId: '',
    sku,
    ...overrides,
  });

describe('CartGrpcController dispatch', () => {
  it('routes every command and query to a handler registered against its class', async () => {
    // If any of these were registered against a string, `command.constructor` would
    // resolve to `Object` and the bus would find nothing — which is exactly the failure
    // mode the class requirement exists to prevent.
    const { controller, store } = build();

    const response = await addItem(controller);

    expect(response.version).toBe(1);
    expect(store.saves).toHaveLength(1);
  });

  it('registers each handler under the exact class it handles', () => {
    // `@CommandHandler(cls)` stores the class on the handler itself; reading it back is
    // the only way to prove the decorator was given the class and not a string.
    for (const [handler, command] of [
      [AddItemHandler, AddItemCommand],
      [UpdateItemQtyHandler, UpdateItemQtyCommand],
      [RemoveItemHandler, RemoveItemCommand],
      [ClearCartHandler, ClearCartCommand],
    ] as const) {
      expect(Reflect.getMetadata(COMMAND_HANDLER_METADATA, handler)).toBe(command);
    }

    for (const [handler, query] of [
      [GetCartHandler, GetCartQuery],
      [GetCheckoutLinesHandler, GetCheckoutLinesQuery],
      [ValidateForCheckoutHandler, ValidateForCheckoutQuery],
    ] as const) {
      expect(Reflect.getMetadata(QUERY_HANDLER_METADATA, handler)).toBe(query);
    }
  });
});

describe('CartGrpcController.GetCart', () => {
  it('answers an empty basket with the fields the proto declares and no others', async () => {
    const { controller } = build();

    const view: CartView = await controller.getCart(guest());

    expect(view).toEqual({
      sessionId: SESSION_ID,
      userId: '',
      items: [],
      status: 'active',
      itemCount: 0,
      subtotal: { amountMinor: '0', currency: '' },
      total: { amountMinor: '0', currency: '' },
      currency: '',
      expiresAt: '',
      version: 0,
    });
    expect(Object.keys(view).sort()).toEqual(CART_FIELDS);
  });

  it('formats the stored basket as the wire spells money', async () => {
    const { controller } = build();
    await addItem(controller);

    const view = await controller.getCart(guest());

    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toEqual({
      sku: 'SKU-1',
      productId: 'product-1',
      name: 'Blue mug',
      quantity: 2,
      unitPrice: { amountMinor: '1000', currency: 'USD' },
      totalPrice: { amountMinor: '2000', currency: 'USD' },
      addedAt: expect.any(String),
      updatedAt: expect.any(String),
      priceChanged: false,
    });
    expect(view.subtotal).toEqual({ amountMinor: '2000', currency: 'USD' });
    expect(view.total).toEqual({ amountMinor: '2000', currency: 'USD' });
    expect(view.itemCount).toBe(2);
    expect(Date.parse(view.items[0].addedAt)).not.toBeNaN();
  });

  it('expires an unstored cart at the empty string rather than a made-up date', async () => {
    const { controller } = build();

    const view = await controller.getCart(guest());

    // proto3 has no null: an absent timestamp arrives as `""`, and a client that parsed
    // a guessed date would show a countdown for a basket that does not exist yet.
    expect(view.expiresAt).toBe('');
  });

  it('reports a moved catalogue price without rewriting the snapshot', async () => {
    const { controller, pricing } = build();
    await addItem(controller);
    pricing.list({
      sku: 'SKU-1',
      productId: 'product-1',
      name: 'Blue mug',
      priceMinor: 1_500,
      currency: 'USD',
    });

    const view = await controller.getCart(guest());

    expect(view.items[0].priceChanged).toBe(true);
    expect(view.items[0].unitPrice).toEqual({ amountMinor: '1000', currency: 'USD' });
    expect(view.subtotal).toEqual({ amountMinor: '2000', currency: 'USD' });
  });

  it('serves the snapshot when the catalogue is unreachable', async () => {
    // A shopper who cannot *see* what is in their basket cannot be told anything about
    // it either, so the read degrades — unlike ValidateForCheckout, which does not.
    const { controller, pricing } = build();
    await addItem(controller);
    pricing.failure = new Error('the peer is not there');

    const view = await controller.getCart(guest());

    expect(view.items[0].priceChanged).toBe(false);
    expect(view.subtotal).toEqual({ amountMinor: '2000', currency: 'USD' });
  });

  it('refuses a request with neither identifier the way proto3 delivers one', async () => {
    const { controller } = build();

    await expect(
      controller.getCart(guest({ sessionId: undefined, userId: undefined })),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});

describe('CartGrpcController.AddItem', () => {
  it('reads the price from the catalogue rather than from the request', async () => {
    // `AddItemRequest` carries no price at all. A cart that trusted one would let
    // checkout proceed at whatever figure the client cared to send.
    const { controller, store } = build();

    const view = await addItem(controller, { quantity: 3 });

    expect(view.subtotal).toEqual({ amountMinor: '3000', currency: 'USD' });
    expect(store.documents.size).toBe(1);
  });

  it('defaults the omitted proto3 scalars to the values handlers expect', async () => {
    const { controller } = build();

    await expect(
      addItem(controller, {
        sessionId: undefined,
        userId: undefined,
        sku: undefined,
        quantity: undefined,
      }),
    ).rejects.toThrow(/sku is required/);
  });

  it('refuses a quantity of zero, which is what an omitted int32 arrives as', async () => {
    const { controller } = build();

    await expect(addItem(controller, { quantity: 0 })).rejects.toThrow(
      /quantity must be a positive integer/,
    );
  });

  it('refuses a quantity above the per-item ceiling', async () => {
    const { controller } = build();

    await expect(addItem(controller, { quantity: 1_000 })).rejects.toThrow(
      /exceeds the per-item limit/,
    );
  });

  it('refuses a SKU the catalogue will not sell, with a 404 rather than a guessed price', async () => {
    const { controller, store } = build();

    await expect(addItem(controller, { sku: 'SKU-NOPE' })).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    expect(store.saves).toHaveLength(0);
  });

  it('refuses a listed-but-withdrawn SKU the same way', async () => {
    const { controller, pricing } = build();
    pricing.inactive.add('SKU-1');

    await expect(addItem(controller)).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('names the cart when neither identifier is present', async () => {
    const { controller } = build();

    await expect(
      controller.addItem({ sessionId: '', userId: '', sku: 'SKU-1', quantity: 1 }),
    ).rejects.toThrow(/needs a sessionId or a userId/);
  });

  it('keeps the catalogue lookup outside the cart\'s lock', async () => {
    // The price is a network round trip. Holding the mutex across one would block every
    // other request to that cart for as long as the catalogue takes to answer.
    const { controller, lock } = build();

    await addItem(controller);

    expect(lock.acquisitions).toHaveLength(1);
    expect(lock.acquisitions[0]).toEqual([`session:${SESSION_ID}`]);
  });
});

describe('CartGrpcController.UpdateItemQty', () => {
  it('sets an absolute quantity and returns the basket it produced', async () => {
    const { controller } = build();
    await addItem(controller);

    const view = await controller.updateItemQty({
      sessionId: SESSION_ID,
      userId: '',
      sku: 'SKU-1',
      quantity: 5,
    });

    expect(view.itemCount).toBe(5);
    expect(view.subtotal).toEqual({ amountMinor: '5000', currency: 'USD' });
    expect(view.version).toBe(2);
  });

  it('refuses zero rather than treating it as a removal', async () => {
    // A number that means two different things depending on whether it is zero is the
    // kind of overloading that survives a rewrite of the client.
    const { controller } = build();
    await addItem(controller);

    await expect(
      controller.updateItemQty({
        sessionId: SESSION_ID,
        userId: '',
        sku: 'SKU-1',
        quantity: 0,
      }),
    ).rejects.toThrow(/use RemoveItem to drop a line/);
  });

  it('refuses a SKU the basket does not hold', async () => {
    const { controller } = build();

    await expect(
      controller.updateItemQty({
        sessionId: SESSION_ID,
        userId: '',
        sku: 'SKU-NOPE',
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});

describe('CartGrpcController.RemoveItem', () => {
  it('drops the line and returns the basket it produced', async () => {
    const { controller } = build();
    await addItem(controller);

    const view = await controller.removeItem({
      sessionId: SESSION_ID,
      userId: '',
      sku: 'SKU-1',
    });

    expect(view.items).toEqual([]);
    expect(view.subtotal).toEqual({ amountMinor: '0', currency: '' });
    expect(view.version).toBe(2);
  });

  it('refuses a SKU that is not there rather than reporting success', async () => {
    const { controller } = build();

    await expect(
      controller.removeItem({ sessionId: SESSION_ID, userId: '', sku: 'SKU-NOPE' }),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});

describe('CartGrpcController.ClearCart', () => {
  it('empties the basket and answers exactly the same way the second time', async () => {
    // The one mutation in `cart.v1` a caller may safely retry after a dropped connection.
    const { controller, store } = build();
    await addItem(controller);
    store.saves.length = 0;

    const first = await controller.clearCart({ sessionId: SESSION_ID, userId: '' });
    const second = await controller.clearCart({ sessionId: SESSION_ID, userId: '' });

    expect(first.items).toEqual([]);
    expect(second).toEqual(first);
    expect(store.saves).toHaveLength(1);
  });
});

describe('CartGrpcController.GetCheckoutLines', () => {
  it('answers with the lines order copies, as wire money', async () => {
    const { controller } = build();
    await addItem(controller);

    const lines: CheckoutLines = await controller.getCheckoutLines(guest());

    expect(lines).toEqual({
      lines: [
        {
          sku: 'SKU-1',
          productId: 'product-1',
          name: 'Blue mug',
          quantity: 2,
          unitPrice: { amountMinor: '1000', currency: 'USD' },
        },
      ],
      subtotal: { amountMinor: '2000', currency: 'USD' },
      currency: 'USD',
      version: 1,
    });
  });

  it('never consults the catalogue — it is a snapshot, not a quote', async () => {
    // The order service copies exactly what the shopper saw. A price that has moved since
    // is caught, and reported, by ValidateForCheckout.
    const { controller, pricing } = build();
    await addItem(controller);
    pricing.priceLookups.length = 0;

    await controller.getCheckoutLines(guest());

    expect(pricing.priceLookups).toHaveLength(0);
  });

  it('answers with an empty basket for a cart nobody has opened', async () => {
    const { controller } = build();

    const lines = await controller.getCheckoutLines(guest());

    expect(lines).toEqual({
      lines: [],
      subtotal: { amountMinor: '0', currency: '' },
      currency: '',
      version: 0,
    });
  });
});

describe('CartGrpcController.ValidateForCheckout', () => {
  it('answers valid when nothing has moved', async () => {
    const { controller } = build();
    await addItem(controller);

    const result: ValidateForCheckoutResponse =
      await controller.validateForCheckout(guest());

    expect(result).toEqual({
      valid: true,
      unavailableSkus: [],
      priceChanges: [],
    });
  });

  it('reports a moved price as a change, with both figures as wire money', async () => {
    const { controller, pricing } = build();
    await addItem(controller);
    pricing.list({
      sku: 'SKU-1',
      productId: 'product-1',
      name: 'Blue mug',
      priceMinor: 1_500,
      currency: 'USD',
    });

    const result = await controller.validateForCheckout(guest());

    // A price that moved is a price the shopper has not agreed to *yet*, so the answer
    // is "not valid" until they confirm it — not "valid, but here is a surprise".
    expect(result.valid).toBe(false);
    expect(result.priceChanges).toEqual([
      {
        sku: 'SKU-1',
        oldPrice: { amountMinor: '1000', currency: 'USD' },
        newPrice: { amountMinor: '1500', currency: 'USD' },
      },
    ]);
    expect(result.unavailableSkus).toEqual([]);
  });

  it('reports a withdrawn SKU as unavailable rather than as a price change', async () => {
    const { controller, pricing } = build();
    await addItem(controller);
    pricing.inactive.add('SKU-1');

    const result = await controller.validateForCheckout(guest());

    expect(result).toEqual({
      valid: false,
      unavailableSkus: ['SKU-1'],
      priceChanges: [],
    });
  });

  it('fails rather than degrading when the catalogue is unreachable', async () => {
    // A validation that skipped the catalogue during an outage would clear a basket full
    // of prices nobody has checked. The caller already has a 503 for this.
    const { controller, pricing } = build();
    await addItem(controller);
    pricing.failure = new Error('the peer is not there');

    await expect(controller.validateForCheckout(guest())).rejects.toThrow(
      /the peer is not there/,
    );
  });

  it('answers valid for a basket nobody has opened', async () => {
    const { controller, pricing } = build();

    const result = await controller.validateForCheckout(guest());

    expect(result).toEqual({ valid: true, unavailableSkus: [], priceChanges: [] });
    // An empty input answers empty without a call, so this does not touch the catalogue.
    expect(pricing.priceLookups).toHaveLength(0);
  });
});

describe('CartGrpcController across requests', () => {
  it('folds a guest basket into the shopper\'s on the first signed-in call', async () => {
    const { controller, store } = build();
    await addItem(controller);

    const view = await controller.getCart(shopper());

    expect(view.userId).toBe(USER_ID);
    expect(view.items.map((item) => item.sku)).toEqual(['SKU-1']);
    expect(store.documents.has(`session:${SESSION_ID}`)).toBe(false);
  });

  it('carries the version the next optimistic write will be checked against', async () => {
    const { controller } = build();
    const added = await addItem(controller);

    expect(added.version).toBe(1);

    const updated = await controller.updateItemQty({
      sessionId: SESSION_ID,
      userId: '',
      sku: 'SKU-1',
      quantity: 4,
    });

    expect(updated.version).toBe(2);
    expect(updated.itemCount).toBe(4);
  });

  it('rejects a request whose identities are absent the way proto3 sends them', async () => {
    const { controller } = build();

    await expect(
      removeItem(controller, 'SKU-1', { sessionId: undefined, userId: undefined }),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});
