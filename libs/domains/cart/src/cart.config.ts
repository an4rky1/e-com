/**
 * @fileoverview Cart's own configuration namespace (`CART_*`).
 *
 * @remarks Lives in one file rather than at each use site so the namespace, its schema and
 * its defaults sit next to each other: a new setting has one obvious home, and a test can
 * build a config object without touching `process.env`.
 *
 * @remarks No connection parameters here. `REDIS_URL` is platform-owned — one Redis serves
 * the rate limiter, the cache and the queue as well as this cart, and a `CART_REDIS_URL`
 * would be a second owner for the same socket. Key namespacing is this module's job
 * ({@link CartConfig.keyPrefix}), which is the part it genuinely owns.
 */
import { z } from 'zod';
import {
  envBoolean,
  envInt,
  envString,
  readNamespacedEnv,
} from '@auth/platform/config';

/** DI token for the resolved configuration. */
export const CART_CONFIG = Symbol('CART_CONFIG');

export const Defaults = {
  /**
   * How long a cart survives its last write, in seconds.
   *
   * @remarks Sliding, not absolute: every save re-applies it, so an abandoned cart expires
   * 24h after the shopper stopped touching it rather than 24h after they first opened it.
   */
  TTL_SECONDS: 86_400,
  /**
   * Ceiling on distinct SKUs in one cart.
   *
   * @remarks A *shape* limit, not a business rule: a cart of 500 unique lines is a
   * different document — a different payload on every read, a different merge cost — and
   * should be several carts. It bounds `addItem` (adding a new SKU at the ceiling is
   * refused); it does not retroactively evict lines a merge brought in.
   */
  MAX_ITEMS: 100,
  /**
   * Ceiling on the quantity of a single SKU.
   *
   * @remarks Guards the wire rather than the warehouse: `quantity` is an `int32` and a
   * caller may send 2 000 000 000, which would overflow every subtotal built from it.
   * Stock availability is inventory's answer, not this one's.
   */
  MAX_QUANTITY_PER_ITEM: 999,
  /**
   * Fold a guest cart into the shopper's cart on an authenticated request.
   *
   * @remarks `cart.proto` has no merge RPC — the contract cannot ask for one — so the
   * merge has to be implicit in the calls that already carry both `session_id` and
   * `user_id`. Turning it off is a migration escape hatch, not a feature: with it off a
   * signed-in shopper simply does not see what they added before signing in.
   */
  AUTO_MERGE: true,
  /**
   * Deadline applied to the catalog calls this service makes.
   *
   * @remarks A price lookup that hangs is worse than one that fails: `addItem` cannot
   * snapshot a price it has not been told, and the caller needs a refusal rather than a
   * request parked until the edge gives up.
   */
  GRPC_DEADLINE_MS: 5_000,
  /**
   * Prefix every cart key is written under.
   *
   * @remarks Two deployments sharing one Redis — a staging cart next to a production one —
   * are separated by this and nothing else.
   */
  KEY_PREFIX: 'cart',
} as const;

/**
 * Cart's configuration schema.
 *
 * @remarks Field names are spelled without the namespace: `readNamespacedEnv('CART', …)`
 * strips `CART_` before validation, so `CART_TTL_SECONDS` arrives here as `TTL_SECONDS`.
 */
export const cartSchema = z.object({
  TTL_SECONDS: envInt(Defaults.TTL_SECONDS, { min: 60, max: 2_592_000 }),
  MAX_ITEMS: envInt(Defaults.MAX_ITEMS, { min: 1, max: 1_000 }),
  MAX_QUANTITY_PER_ITEM: envInt(Defaults.MAX_QUANTITY_PER_ITEM, {
    min: 1,
    max: 100_000,
  }),
  AUTO_MERGE: envBoolean(Defaults.AUTO_MERGE),
  GRPC_DEADLINE_MS: envInt(Defaults.GRPC_DEADLINE_MS, { min: 100, max: 60_000 }),
  KEY_PREFIX: envString(Defaults.KEY_PREFIX),
});

export type CartEnvConfig = z.infer<typeof cartSchema>;

export interface CartConfig {
  ttlSeconds: number;
  maxItems: number;
  maxQuantityPerItem: number;
  autoMerge: boolean;
  grpcDeadlineMs: number;
  keyPrefix: string;
}

/**
 * Reads `CART_*` into a validated config.
 *
 * @remarks An empty key prefix is a boot failure rather than a silent fallback: `":data:x"`
 * and `"cart:data:x"` are different keys, and a deployment that quietly collapsed onto the
 * bare namespace would start reading another environment's carts the first time both were
 * pointed at one Redis.
 */
export function resolveCartConfig(
  env: NodeJS.ProcessEnv = process.env,
): CartConfig {
  const parsed = readNamespacedEnv('CART', cartSchema, env);
  const keyPrefix = parsed.KEY_PREFIX.trim();

  if (keyPrefix.length === 0) {
    throw new Error(
      'Invalid CART configuration: KEY_PREFIX must be a non-empty string',
    );
  }

  return {
    ttlSeconds: parsed.TTL_SECONDS,
    maxItems: parsed.MAX_ITEMS,
    maxQuantityPerItem: parsed.MAX_QUANTITY_PER_ITEM,
    autoMerge: parsed.AUTO_MERGE,
    grpcDeadlineMs: parsed.GRPC_DEADLINE_MS,
    keyPrefix,
  };
}
