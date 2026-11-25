/**
 * @fileoverview The one place a cart is loaded, changed and written back.
 *
 * @remarks Four things have to happen together and none of them is safe alone: the cart is
 * addressed, a guest cart is folded in on the first authenticated request, the whole
 * section runs under the cart's lock, and the result is written back with the guest key
 * dropped in the same transaction. Each of those is asserted here rather than through the
 * handlers, because a handler test would pass with a workspace that skipped any one of
 * them and still answered correctly for a single-item basket.
 *
 * @remarks The "wrote nothing" cases matter as much as the ones that write: a read that
 * found no work must not spend a version number or slide a TTL it did not touch, or
 * browsing a basket would keep an abandoned cart alive forever.
 */
import 'reflect-metadata';
import { ValidationException } from '@auth/platform/error-handling';
import { CartWorkspace } from '../src/application/cart-workspace';
import { Money } from '../src/domain/value-objects/money';
import { ProductId } from '../src/domain/value-objects/product-id.vo';
import { Quantity } from '../src/domain/value-objects/quantity.vo';
import { Sku } from '../src/domain/value-objects/sku.vo';
import {
  InMemoryCartStore,
  RecordingLock,
  SESSION_ID,
  USER_ID,
  storedCart,
  storedItem,
  testCartConfig,
} from './support/fakes';

const GUEST_KEY = `session:${SESSION_ID}`;
const USER_KEY = `user:${USER_ID}`;

/** A second browser, so a merge can name a source other than the caller's own session. */
const OTHER_SESSION_ID = '9f2c7a10-0000-4000-8000-000000000002';
const OTHER_GUEST_KEY = `session:${OTHER_SESSION_ID}`;

const guestCart = () => storedCart({ items: [storedItem({ sku: 'SKU-G', quantity: 1 })] });

const build = (overrides: { autoMerge?: boolean } = {}) => {
  const store = new InMemoryCartStore();
  const lock = new RecordingLock();
  const config = testCartConfig({ autoMerge: overrides.autoMerge ?? true });
  const workspace = new CartWorkspace(store, lock, config);

  return { workspace, store, lock };
};

describe('CartWorkspace.read', () => {
  it('answers an empty basket for a cart nobody has opened, and writes nothing', async () => {
    // Every reader of this service wants a basket to render. Creating the key would mean
    // every window that renders one extends the life of an empty document.
    const { workspace, store } = build();

    const cart = await workspace.read({ sessionId: SESSION_ID, userId: '' });

    expect(cart.version).toBe(0);
    expect(cart.isEmpty).toBe(true);
    expect(store.saves).toHaveLength(0);
    expect(store.documents.size).toBe(0);
  });

  it('returns the stored cart as it stands, without rewriting it', async () => {
    const { workspace, store } = build();
    store.documents.set(USER_KEY, storedCart({ version: 7, items: [storedItem()] }));

    const cart = await workspace.read({ sessionId: SESSION_ID, userId: USER_ID });

    expect(cart.version).toBe(7);
    expect(cart.itemCount).toBe(2);
    expect(store.saves).toHaveLength(0);
  });

  it('folds a guest cart into the shopper\'s cart on the first authenticated request', async () => {
    const { workspace, store } = build();
    store.documents.set(USER_KEY, storedCart({ items: [storedItem({ quantity: 1 })] }));
    store.documents.set(GUEST_KEY, guestCart());

    const cart = await workspace.read({ sessionId: SESSION_ID, userId: USER_ID });

    expect(cart.items.map((item) => item.sku.value)).toEqual(['SKU-1', 'SKU-G']);
    expect(store.documents.has(GUEST_KEY)).toBe(false);
    expect(store.saves[0]?.discardKey).toBe(GUEST_KEY);
  });

  it('folds a guest cart in even when the shopper has none of their own', async () => {
    const { workspace, store } = build();
    store.documents.set(GUEST_KEY, guestCart());

    const cart = await workspace.read({ sessionId: SESSION_ID, userId: USER_ID });

    expect(cart.items).toHaveLength(1);
    expect(cart.version).toBe(1);
    expect(store.documents.has(GUEST_KEY)).toBe(false);
  });

  it('merges the guest cart exactly once, so a second read does not double it', async () => {
    const { workspace, store } = build();
    store.documents.set(GUEST_KEY, guestCart());

    await workspace.read({ sessionId: SESSION_ID, userId: USER_ID });
    const second = await workspace.read({ sessionId: SESSION_ID, userId: USER_ID });

    expect(second.itemCount).toBe(1);
    expect(store.saves).toHaveLength(1);
  });

  it('leaves the guest cart alone when auto-merge is switched off', async () => {
    // The escape hatch for a migration: with it off a signed-in shopper simply does not
    // see what they added before signing in — but nothing may be deleted behind their back.
    const { workspace, store } = build({ autoMerge: false });
    store.documents.set(GUEST_KEY, guestCart());

    const cart = await workspace.read({ sessionId: SESSION_ID, userId: USER_ID });

    expect(cart.isEmpty).toBe(true);
    expect(store.documents.has(GUEST_KEY)).toBe(true);
    expect(store.saves).toHaveLength(0);
  });

  it('never looks at a guest key for a request with no session', async () => {
    const { workspace, store } = build();
    store.documents.set(GUEST_KEY, guestCart());

    const cart = await workspace.read({ sessionId: '', userId: USER_ID });

    expect(cart.isEmpty).toBe(true);
    expect(store.saves).toHaveLength(0);
  });

  it('refuses a request with neither identifier before touching the store', async () => {
    const { workspace, store } = build();

    await expect(workspace.read({ sessionId: '', userId: '' })).rejects.toBeInstanceOf(
      ValidationException,
    );
    expect(store.saves).toHaveLength(0);
  });

  it('holds the shopper cart and the guest cart while it works', async () => {
    // Both names, in the set the lock de-duplicates and sorts: a merge that held only one
    // would interleave with a guest request writing the same document.
    const { workspace, lock } = build();
    await workspace.read({ sessionId: SESSION_ID, userId: USER_ID });

    expect(lock.acquisitions).toEqual([[USER_KEY, GUEST_KEY]]);
  });

  it('holds one name when there is nothing to merge', async () => {
    const { workspace, lock } = build();

    await workspace.read({ sessionId: SESSION_ID, userId: '' });

    expect(lock.acquisitions).toEqual([[`session:${SESSION_ID}`]]);
  });
});

describe('CartWorkspace.mutate', () => {
  it('writes the changed cart back with the configured TTL', async () => {
    const { workspace, store } = build();

    const cart = await workspace.mutate({ sessionId: SESSION_ID, userId: '' }, (target) => {
      target.addItem(
        {
          sku: Sku.of('SKU-1'),
          productId: ProductId.of('product-1'),
          name: 'Blue mug',
          quantity: Quantity.of(1),
          unitPrice: Money.of(100, 'USD'),
        },
        { maxItems: 10, maxQuantityPerItem: 10 },
        new Date(),
      );
    });

    expect(cart.version).toBe(1);
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]).toMatchObject({
      key: `session:${SESSION_ID}`,
      ttlSeconds: 86_400,
    });
    expect(store.saves[0]?.discardKey).toBeUndefined();
    expect(store.documents.get(`session:${SESSION_ID}`)?.version).toBe(1);
  });

  it('writes nothing when the mutation changed nothing', async () => {
    // Clearing an already-empty cart is satisfied by an empty cart, so a retry after a
    // dropped connection does not spend a version or slide a TTL.
    const { workspace, store } = build();

    const cart = await workspace.mutate({ sessionId: SESSION_ID, userId: '' }, (target) =>
      target.clear(new Date()),
    );

    expect(cart.version).toBe(0);
    expect(store.saves).toHaveLength(0);
  });

  it('replaces the stored document rather than merging into it', async () => {
    const { workspace, store } = build();
    store.documents.set(`session:${SESSION_ID}`, storedCart({ items: [storedItem()] }));

    const cart = await workspace.mutate({ sessionId: SESSION_ID, userId: '' }, (target) =>
      target.removeItem(Sku.of('SKU-1'), new Date()),
    );

    expect(cart.isEmpty).toBe(true);
    expect(store.documents.get(`session:${SESSION_ID}`)?.items).toEqual([]);
    expect(store.documents.get(`session:${SESSION_ID}`)?.version).toBe(2);
  });

  it('discards the guest key in the same write that records the merge', async () => {
    // Two separate calls would be two chances for a failure between them: the merge
    // recorded and the guest cart still alive means the next request merges the same
    // quantities again, and the basket doubles with no error anywhere to explain it.
    const { workspace, store } = build();
    store.documents.set(GUEST_KEY, guestCart());

    await workspace.mutate({ sessionId: SESSION_ID, userId: USER_ID }, async () => undefined);

    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]?.discardKey).toBe(GUEST_KEY);
    expect(store.documents.has(GUEST_KEY)).toBe(false);
    expect(store.documents.get(USER_KEY)?.items.map((item) => item.sku)).toEqual([
      'SKU-G',
    ]);
  });
});

describe('CartWorkspace.mergeFrom', () => {
  it('folds the named guest cart into the shopper\'s cart and drops the source', async () => {
    // The explicit counterpart to merge-on-read: the source is addressed *by name* —
    // the id the browser presented at login — not derived from the new session, which
    // has never seen a guest key.
    const { workspace, store } = build();
    store.documents.set(USER_KEY, storedCart({ items: [storedItem({ quantity: 1 })] }));
    store.documents.set(GUEST_KEY, guestCart());

    const merged = await workspace.mergeFrom(
      { sessionId: SESSION_ID, userId: USER_ID },
      SESSION_ID,
    );

    expect(merged).toBe(true);
    expect(store.documents.get(USER_KEY)?.items.map((item) => item.sku)).toEqual([
      'SKU-1',
      'SKU-G',
    ]);
    expect(store.documents.has(GUEST_KEY)).toBe(false);
    expect(store.saves[0]?.discardKey).toBe(GUEST_KEY);
  });

  it('sums the quantity when both carts hold the same line', async () => {
    // Merging by replacement would quietly drop units the shopper added while anonymous;
    // merging by sum is the reason the two documents are read under one lock.
    const { workspace, store } = build();
    store.documents.set(USER_KEY, storedCart({ items: [storedItem({ quantity: 1 })] }));
    store.documents.set(GUEST_KEY, storedCart({ items: [storedItem({ quantity: 2 })] }));

    await workspace.mergeFrom({ sessionId: SESSION_ID, userId: USER_ID }, SESSION_ID);

    const items = store.documents.get(USER_KEY)?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(3);
  });

  it('answers false and writes nothing when no guest basket exists', async () => {
    // The ordinary answer for a shopper who never browsed anonymously — a retry after a
    // partial failure must not double-count, and must not spend a version on the way.
    const { workspace, store } = build();
    store.documents.set(USER_KEY, storedCart({ items: [storedItem()] }));

    const merged = await workspace.mergeFrom(
      { sessionId: SESSION_ID, userId: USER_ID },
      SESSION_ID,
    );

    expect(merged).toBe(false);
    expect(store.saves).toHaveLength(0);
  });

  it('discards an empty guest document even though nothing folded', async () => {
    // `false` means "nothing was folded", not "leave the document alone": an empty guest
    // cart is still a document that must stop existing, or it rides along forever.
    const { workspace, store } = build();
    store.documents.set(GUEST_KEY, storedCart({ items: [] }));

    const merged = await workspace.mergeFrom(
      { sessionId: SESSION_ID, userId: USER_ID },
      SESSION_ID,
    );

    expect(merged).toBe(false);
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]?.discardKey).toBe(GUEST_KEY);
    expect(store.documents.has(GUEST_KEY)).toBe(false);
  });

  it('refuses to merge a cart into itself', async () => {
    // A source that *is* the owner would double every quantity, and it can only happen
    // when a caller passes its own session id as the guest. Refused before the lock.
    const { workspace, store, lock } = build();
    store.documents.set(GUEST_KEY, guestCart());

    const merged = await workspace.mergeFrom({ sessionId: SESSION_ID, userId: '' }, SESSION_ID);

    expect(merged).toBe(false);
    expect(lock.acquisitions).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
    expect(store.documents.get(GUEST_KEY)?.items).toHaveLength(1);
  });

  it('holds the owner, its guest key and the named source while it works', async () => {
    // Three names, in the order the workspace composes them: the source is a cart
    // another request may be writing right now — the tab still shopping anonymously
    // while this one signs in.
    const { workspace, store, lock } = build();
    store.documents.set(OTHER_GUEST_KEY, guestCart());

    await workspace.mergeFrom({ sessionId: SESSION_ID, userId: USER_ID }, OTHER_SESSION_ID);

    expect(lock.acquisitions).toEqual([[USER_KEY, GUEST_KEY, OTHER_GUEST_KEY]]);
  });
});
