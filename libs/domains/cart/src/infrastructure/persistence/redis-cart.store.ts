/**
 * @fileoverview The cart in Redis: one JSON document per owner key, with a sliding TTL.
 *
 * @remarks Redis is the *only* copy. There is no table to fall back to and no migration to
 * run, which is the whole reason a basket — a thing that is worthless the moment the
 * session ends — does not occupy a row in a database that has to be backed up, indexed and
 * reasoned about forever after.
 *
 * @remarks The document is validated on the way *in*, not on the way out, plus one more
 * pass here: a blob that cannot be read is treated as absent and logged, rather than
 * raised. The alternative is a shopper who can never open their basket again because one
 * write was truncated, and the warning is what makes the difference between "recovered"
 * and "silently lost" visible to whoever is on call.
 */
import { Logger } from '@nestjs/common';
import { DependencyUnavailableException } from '@auth/platform/error-handling';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { StoredCart } from '../../domain/cart.aggregate';
import { CART_STATUSES } from '../../domain/value-objects/cart-status.vo';
import type { CartStorePort, SaveCartInput } from '../../domain/ports/cart-store.port';
import type { CartConfig } from '../../cart.config';

/**
 * The persisted document, as the store will accept it.
 *
 * @remarks Deliberately as strict as the aggregate is: quantity at least one, price a
 * non-negative integer, currency a real code. A schema that waved these through would let
 * a bad write become a bad cart, and the aggregate's own guards would then be the only
 * thing standing between a blob and a subtotal.
 */
const storedCartItemSchema = z.object({
  sku: z.string().min(1),
  productId: z.string().min(1),
  name: z.string(),
  quantity: z.number().int().min(1),
  unitPriceMinor: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/),
  addedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const storedCartSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  status: z.enum(CART_STATUSES),
  version: z.number().int().min(0),
  updatedAt: z.iso.datetime(),
  items: z.array(storedCartItemSchema),
});

export class RedisCartStore implements CartStorePort {
  private static readonly logger = new Logger(RedisCartStore.name);

  constructor(
    private readonly client: Redis | null,
    private readonly config: CartConfig,
  ) {}

  async load(key: string): Promise<StoredCart | null> {
    const redis = this.requireClient();
    const storageKey = this.storageKey(key);

    let raw: string | null;
    try {
      raw = await redis.get(storageKey);
    } catch (error) {
      throw this.unreachable(storageKey, error);
    }

    if (raw === null) return null;

    try {
      return storedCartSchema.parse(JSON.parse(raw)) as StoredCart;
    } catch (error) {
      // Absent rather than raised: the next write replaces the document, and the warning
      // is the only trace that anything was ever lost.
      RedisCartStore.logger.warn(
        `unreadable cart at ${storageKey}; treating it as empty: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async save(input: SaveCartInput): Promise<void> {
    const redis = this.requireClient();
    const storageKey = this.storageKey(input.key);
    const payload = JSON.stringify(input.cart);

    try {
      if (input.discardKey === undefined) {
        await redis.set(storageKey, payload, 'EX', input.ttlSeconds);
        return;
      }

      // One transaction, because two commands issued back to back are two chances for a
      // failure between them: the merge recorded and the guest cart still alive means the
      // next request merges the same quantities again, and the basket doubles with no
      // error anywhere to explain it.
      const multi = redis.multi();
      multi.set(storageKey, payload, 'EX', input.ttlSeconds);
      multi.del(this.storageKey(input.discardKey));
      await multi.exec();
    } catch (error) {
      throw this.unreachable(storageKey, error);
    }
  }

  async ping(): Promise<void> {
    await this.requireClient().ping();
  }

  private storageKey(ownerKey: string): string {
    return `${this.config.keyPrefix}:data:${ownerKey}`;
  }

  private requireClient(): Redis {
    if (this.client === null) {
      // Refusing beats inventing a basket: a store that answered with an empty cart when
      // Redis is simply not configured would look exactly like a shopper with nothing in
      // their basket, and every add would then fail for a reason nobody had logged.
      throw new DependencyUnavailableException(
        'the cart store needs Redis (REDIS_URL is not set)',
      );
    }
    return this.client;
  }

  private unreachable(key: string, cause: unknown): DependencyUnavailableException {
    return new DependencyUnavailableException(
      'the cart store could not be reached',
      { key },
      cause,
    );
  }
}
