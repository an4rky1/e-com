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

    expect(cart.items.map((item) => item.sku)).toEqual(['SKU-1', 'SKU-G']);
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
          sku: 'SKU-1',
          productId: 'product-1',
          name: 'Blue mug',
          quantity: 1,
          unitPriceMinor: 100,
          currency: 'USD',
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
      target.removeItem('SKU-1', new Date()),
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
    expect(store.documents.get(USER_KEY)?.items.map((item) => item.sku)).toEqual(['SKU-G']);
  });
});
