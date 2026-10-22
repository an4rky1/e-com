/**
 * @fileoverview The notification service's configuration namespace.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database" unenforceable.
 *
 * @remarks `resolveNotificationConfig` is deliberately separate from the schema so a test can
 * build a {@link NotificationConfig} literally. Nothing in the application or domain layer
 * reads `process.env` itself — every value it needs is on this object.
 */
import { z } from 'zod';
import { envBoolean, envInt, envString, readNamespacedEnv, resolveModuleConfig } from '@auth/platform/config';

/** DI token for this service's own Prisma client, separate from any platform-wide binding. */
export const NOTIFICATION_PRISMA = Symbol('NOTIFICATION_PRISMA');
/** DI token for the resolved {@link NotificationConfig}. */
export const NOTIFICATION_CONFIG = Symbol('NOTIFICATION_CONFIG');

export const Defaults = {
  /**
   * How long a consumer claim survives before it may be reclaimed.
   *
   * @remarks A claim is taken *before* the notification is sent and released if processing
   * fails, so the normal path never depends on this number. It exists for the abnormal path:
   * a pod that is killed between claiming and releasing leaves the claim behind, and without
   * an expiry the event is stuck forever and its notification is never sent. Fifteen minutes
   * is longer than any plausible dispatch and short enough that the user does not notice the
   * wait.
   */
  CLAIM_TTL_SEC: 900,
  /**
   * Ceiling on `ListNotifications`.
   *
   * @remarks The notification list is the one query a user-facing screen calls on every
   * render, and an unbounded `limit` on a table that grows without limit is a denial of
   * service that only shows up once the table is big.
   */
  MAX_PAGE_SIZE: 100,
  /**
   * Whether the console channel logs rendered message bodies.
   *
   * @remarks Off by default, and the reason is worth stating: a body is composed from
   * variables that came off a Kafka topic. Log bodies on by default and this service becomes
   * the place every user's notification text ends up, in a log aggregator nobody scoped.
   */
  LOG_BODIES: false,
  /**
   * Whether malformed payloads are dead-lettered to `${topic}.dlq`.
   *
   * @remarks On by default. A poison message that is neither retried nor dead-lettered either
   * blocks its partition forever or is silently dropped, and those are the two outcomes that
   * turn "one bad event" into "notifications stopped".
   */
  DEAD_LETTER_ENABLED: true,
  /**
   * Which store backs notification records.
   *
   * @remarks `prisma` is the only durable option: records go in `notifications`, per-channel
   * outcomes in `notification_deliveries`, and announcements in `outbox_events`. `memory`
   * exists for local development and for tests that must not need a database — it is
   * process-local and loses everything on restart, which is stated rather than hidden so
   * nobody ships it by accident.
   */
  STORE_MODE: 'prisma',
} as const;

export const StoreMode = {
  PRISMA: 'prisma',
  MEMORY: 'memory',
} as const;

export type StoreMode = (typeof StoreMode)[keyof typeof StoreMode];

export const notificationSchema = z.object({
  CLAIM_TTL_SEC: envInt(Defaults.CLAIM_TTL_SEC, { min: 30, max: 86_400 }),
  MAX_PAGE_SIZE: envInt(Defaults.MAX_PAGE_SIZE, { min: 1, max: 1_000 }),
  LOG_BODIES: envBoolean(Defaults.LOG_BODIES),
  DEAD_LETTER_ENABLED: envBoolean(Defaults.DEAD_LETTER_ENABLED),
  STORE_MODE: envString(Defaults.STORE_MODE),
});

export type NotificationEnvConfig = z.infer<typeof notificationSchema>;

export interface NotificationConfig {
  claimTtlSec: number;
  maxPageSize: number;
  logBodies: boolean;
  deadLetterEnabled: boolean;
  storeMode: StoreMode;
}

/**
 * Reads `NOTIFICATION_*` into the shape the handlers take.
 *
 * @remarks `STORE_MODE` is validated rather than cast. A typo would otherwise resolve to
 * `undefined`, match no branch in the module factory, and silently leave the store unbound —
 * a service that boots and cannot record anything it sends.
 */
export function resolveNotificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotificationConfig {
  const parsed = readNamespacedEnv('NOTIFICATION', notificationSchema, env);

  // Annotated rather than inlined: `Defaults` is `as const`, so an inlined `STORE_MODE` would
  // narrow the defaults object to `'prisma'` and make `memory` unassignable.
  const defaults: NotificationConfig = {
    claimTtlSec: Defaults.CLAIM_TTL_SEC,
    maxPageSize: Defaults.MAX_PAGE_SIZE,
    logBodies: Defaults.LOG_BODIES,
    deadLetterEnabled: Defaults.DEAD_LETTER_ENABLED,
    storeMode: Defaults.STORE_MODE,
  };

  return resolveModuleConfig(defaults, {
    // Explicit, not a spread of `parsed`: the env keys are SCREAMING_SNAKE and the resolved
    // keys are camelCase, and spreading would leave both spellings on the object.
    claimTtlSec: parsed.CLAIM_TTL_SEC,
    maxPageSize: parsed.MAX_PAGE_SIZE,
    logBodies: parsed.LOG_BODIES,
    deadLetterEnabled: parsed.DEAD_LETTER_ENABLED,
    storeMode: toStoreMode(parsed.STORE_MODE),
  });
}

function toStoreMode(value: string): StoreMode {
  const normalised = value.trim().toLowerCase();
  const match = (Object.values(StoreMode) as string[]).includes(normalised);

  if (!match) {
    throw new Error(
      `NOTIFICATION_STORE_MODE must be one of ${Object.values(StoreMode).join(', ')}; received "${value}"`,
    );
  }

  return normalised as StoreMode;
}