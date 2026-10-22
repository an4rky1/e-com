import { AsyncLocalStorage } from 'node:async_hooks';

export interface TransactionContext {
  /** Prisma's transaction client; the ambient one for the duration of `runInTransaction`. */
  client: unknown;
  traceId?: string;
}

const storage = new AsyncLocalStorage<TransactionContext>();

/**
 * Ambient transaction access.
 *
 * @remarks This is what makes "the aggregate and its events commit together" hold at every
 * call site. Without it, a repository has no way to know whether the caller already opened
 * a transaction, so it either opens a second one (which silently fails to be atomic) or
 * requires every handler to thread the client through by hand.
 *
 * `AsyncLocalStorage` propagates across `await` and across unrelated service objects,
 * which a hand-threaded parameter does not.
 */
export const TransactionStorage = {
  run<TValue>(context: TransactionContext, fn: () => Promise<TValue>): Promise<TValue> {
    return storage.run(context, fn);
  },

  /** The ambient transaction client, or `undefined` outside a transaction. */
  get(): TransactionContext | undefined {
    return storage.getStore();
  },

  get isActive(): boolean {
    return storage.getStore() !== undefined;
  },

  /**
   * Rejects re-entrant transactions.
   *
   * @remarks Nesting is not supported. A nested `$transaction` would either open a second
   * connection (defeating atomicity) or deadlock waiting on a row the outer transaction
   * holds. Failing loudly at the point of the mistake is far cheaper than debugging either.
   */
  assertNotActive(operation: string): void {
    if (storage.getStore()) {
      throw new Error(
        `${operation}: nested transactions are not supported; reuse the ambient transaction instead`,
      );
    }
  },
};