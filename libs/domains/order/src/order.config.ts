/**
 * @fileoverview Order's own configuration namespace (`ORDER_*`).
 *
 * @remarks Connection parameters live elsewhere on purpose — `DATABASE_URL` is
 * platform-owned, and a module that could reconfigure its own connection would make
 * "one service, one database" unenforceable.
 *
 * @remarks `process.env` is touched in exactly one file. The namespace, its schema and its
 * defaults sit next to each other, so a new setting has one obvious home and a test can
 * build a config object without touching the environment.
 */
import { z } from 'zod';
import { envInt, envString, readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';
import {
  GRPC_DEADLINE_MAX_MS,
  GRPC_DEADLINE_MIN_MS,
  GRPC_DEADLINE_MS,
} from '@auth/contracts/grpc/deadline';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '@auth/contracts/http/api';

/** This service's own Prisma client. Never shared with another domain lib. */
export const ORDER_PRISMA = Symbol('ORDER_PRISMA');

/** DI token for the resolved configuration. */
export const ORDER_CONFIG = Symbol('ORDER_CONFIG');

export const Defaults = {
  /**
   * Warehouse the checkout saga reserves against when the request does not name one.
   *
   * @remarks A single default matches the single-warehouse deployment this service ships
   * with; multi-warehouse routing is a later concern and must not pretend to be solved
   * here by silently splitting stock.
   */
  DEFAULT_WAREHOUSE: 'main',
  /**
   * Ceiling on a user-orders page.
   *
   * @remarks A pager that can be asked for 10 000 rows is a denial-of-service surface
   * dressed as a convenience.
   */
  MAX_PAGE_SIZE,
  /** Default page size when the caller omits it. */
  DEFAULT_PAGE_SIZE,
  /** Deadline for each peer RPC during the checkout saga. */
  GRPC_DEADLINE_MS,
} as const;

/**
 * Order's configuration schema.
 *
 * @remarks No connection parameters and no secrets: everything in this namespace is a
 * policy number an operator may read out loud.
 */
export const orderSchema = z.object({
  DEFAULT_WAREHOUSE: envString(Defaults.DEFAULT_WAREHOUSE),
  MAX_PAGE_SIZE: envInt(Defaults.MAX_PAGE_SIZE, { min: 1, max: 1_000 }),
  DEFAULT_PAGE_SIZE: envInt(Defaults.DEFAULT_PAGE_SIZE, { min: 1, max: 1_000 }),
  GRPC_DEADLINE_MS: envInt(Defaults.GRPC_DEADLINE_MS, {
    min: GRPC_DEADLINE_MIN_MS,
    max: GRPC_DEADLINE_MAX_MS,
  }),
});

export type OrderEnvConfig = z.infer<typeof orderSchema>;

export interface OrderConfig {
  defaultWarehouse: string;
  maxPageSize: number;
  defaultPageSize: number;
  grpcDeadlineMs: number;
}

/**
 * Reads `ORDER_*` into a validated config.
 *
 * @remarks An empty warehouse name is a boot failure rather than a silent fallback: a
 * reservation written against `""` would be invisible to every operator tooling that
 * filters by warehouse, and stock would appear to vanish.
 */
export function resolveOrderConfig(
  env: NodeJS.ProcessEnv = process.env,
): OrderConfig {
  const parsed = readNamespacedEnv('ORDER', orderSchema, env);
  const warehouse = parsed.DEFAULT_WAREHOUSE.trim();

  if (warehouse.length === 0) {
    throw new Error(
      'Invalid ORDER configuration: DEFAULT_WAREHOUSE must be a non-empty string',
    );
  }

  if (parsed.DEFAULT_PAGE_SIZE > parsed.MAX_PAGE_SIZE) {
    throw new Error(
      'Invalid ORDER configuration: DEFAULT_PAGE_SIZE must not exceed MAX_PAGE_SIZE',
    );
  }

  const config: OrderConfig = {
    defaultWarehouse: warehouse,
    maxPageSize: parsed.MAX_PAGE_SIZE,
    defaultPageSize: parsed.DEFAULT_PAGE_SIZE,
    grpcDeadlineMs: parsed.GRPC_DEADLINE_MS,
  };

  return resolveModuleConfig(config, {});
}
