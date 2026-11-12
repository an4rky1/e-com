/**
 * @fileoverview Inventory's own configuration namespace (`INVENTORY_*`).
 *
 * @remarks Lives in one file rather than at each use site so the namespace, its schema and
 * its defaults sit next to each other: a new setting has one obvious home, and a test can
 * build a config object without touching `process.env`.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database"
 * unenforceable.
 */
import { z } from 'zod';
import { envInt, envString, readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';

/** This service's own Prisma client. Never shared with another domain lib. */
export const INVENTORY_PRISMA = Symbol('INVENTORY_PRISMA');

/** DI token for the resolved configuration. */
export const INVENTORY_CONFIG = Symbol('INVENTORY_CONFIG');

export const Defaults = {
  /**
   * Warehouse used when a request does not name one.
   *
   * @remarks Single-warehouse deployments are the common case, but the column is part of
   * the `(sku, warehouse_id)` key — so "no warehouse" has to be a value, not an absence,
   * or every read would need a second code path.
   */
  DEFAULT_WAREHOUSE: 'main',
  /**
   * Safety stock written onto a stock row when it is first created.
   *
   * @remarks Applies to creation only. Raising it later would silently change `available`
   * for every existing row, which is an inventory decision an operator must make per SKU,
   * not a config flip.
   */
  SAFETY_DEFAULT: 0,
  /**
   * Deadline applied to outbound gRPC calls by callers that honour it.
   *
   * @remarks A reserve that hangs is worse than a reserve that fails: the order side
   * cannot tell "still deciding" from "decided no", and a retry is the only safe answer.
   */
  GRPC_DEADLINE_MS: 5_000,
} as const;

/**
 * Inventory's configuration schema.
 *
 * @remarks Parsed through `readNamespacedEnv`, so `INVENTORY_SAFETY_DEFAULT` is the only
 * spelling of the key that is ever read.
 */
export const inventorySchema = z.object({
  DEFAULT_WAREHOUSE: envString(Defaults.DEFAULT_WAREHOUSE),
  SAFETY_DEFAULT: envInt(Defaults.SAFETY_DEFAULT, { min: 0, max: 1_000_000 }),
  GRPC_DEADLINE_MS: envInt(Defaults.GRPC_DEADLINE_MS, { min: 100, max: 60_000 }),
});

export type InventoryEnvConfig = z.infer<typeof inventorySchema>;

export interface InventoryConfig {
  defaultWarehouse: string;
  safetyDefault: number;
  grpcDeadlineMs: number;
}

/**
 * Reads `INVENTORY_*` into a validated config.
 *
 * @remarks An empty warehouse name is a boot failure rather than a silent fallback: a blank
 * key would satisfy "not provided" at every call site while writing stock rows under a
 * warehouse nothing else ever reads.
 */
export function resolveInventoryConfig(
  env: NodeJS.ProcessEnv = process.env,
): InventoryConfig {
  const parsed = readNamespacedEnv('INVENTORY', inventorySchema, env);
  const warehouse = parsed.DEFAULT_WAREHOUSE.trim();

  if (warehouse.length === 0) {
    throw new Error(
      'Invalid INVENTORY configuration: DEFAULT_WAREHOUSE must be a non-empty string',
    );
  }

  // Annotated rather than inlined: TypeScript would otherwise widen the object literal at
  // the call to `resolveModuleConfig` and the result would no longer satisfy
  // {@link InventoryConfig} by construction.
  const config: InventoryConfig = {
    defaultWarehouse: warehouse,
    safetyDefault: parsed.SAFETY_DEFAULT,
    grpcDeadlineMs: parsed.GRPC_DEADLINE_MS,
  };

  return resolveModuleConfig(config, {});
}
