import { z, type ZodTypeAny } from 'zod';

/**
 * Module configuration resolution.
 *
 * Why a helper instead of reading `process.env` at each use site: a module that reads its
 * own env vars scattered through its source has no single place to see what it needs, and
 * no way to override them in tests. Reading everything at construction time also means an
 * invalid value fails at boot rather than on the first request that happens to hit it.
 */

/**
 * Reads a variable a module cannot boot without.
 *
 * Why a helper instead of reading `process.env` at each use site: one place to see what a
 * module needs, an injectable env so tests never touch `process.env`, and a failure at boot
 * rather than on the first request that happens to touch the variable.
 *
 * @param name - variable to read, e.g. `DATABASE_URL`.
 * @param consumer - the module that needs it, used in the error message.
 * @param env - source map. Injectable so tests never touch `process.env`.
 */
export function requireEnv(
  name: string,
  consumer: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required by the ${consumer} module`);
  }
  return value;
}

/** `IDENTITY_CACHE_TTL_SEC` -> the `IDENTITY_` namespace owns it. */
export const ENV_PREFIXES = {
  identity: 'IDENTITY',
  accessControl: 'ACCESS_CONTROL',
  credentialVault: 'VAULT',
  session: 'SESSION',
  authFlow: 'GATEWAY',
  mfa: 'MFA',
  apiKey: 'API_KEY',
  accountSecurity: 'ACCOUNT_SECURITY',
  notification: 'NOTIFICATION',
  kafka: 'KAFKA',
  outbox: 'OUTBOX',
  grpc: 'GRPC',
  auth: 'AUTH',
  // E-commerce
  catalog: 'CATALOG',
  cart: 'CART',
  order: 'ORDER',
  inventory: 'INVENTORY',
  billing: 'BILLING',
  // Shared infrastructure modules with their own namespace
  locking: 'LOCKING',
  scheduler: 'SCHEDULER',
  http: 'HTTP',
  webhooks: 'WEBHOOKS',
  encryption: 'ENCRYPTION',
} as const;

/**
 * Collects `<PREFIX>_*` variables into a flat object keyed by the bare variable name.
 *
 * @param prefix - namespace, e.g. `SESSION`.
 * @param env - source map. Injectable so tests never touch `process.env`.
 * @param passthrough - extra sources consulted after the namespaced one.
 */
export function readNamespacedEnv<T extends ZodTypeAny>(
  prefix: string,
  schema: T,
  env: NodeJS.ProcessEnv = process.env,
  passthrough: Record<string, unknown> = {},
): z.infer<T> {
  const namespaced: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(`${prefix}_`)) {
      namespaced[key.slice(prefix.length + 1)] = value;
    }
  }

  const parsed = schema.safeParse({ ...namespaced, ...passthrough });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${prefix}_${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid ${prefix} configuration: ${issues}`);
  }

  return parsed.data as z.infer<T>;
}

/**
 * Merges explicit options over env over defaults.
 *
 * @remarks Keys present but `undefined` are ignored, so `{ port: undefined }` still falls
 * through to the default rather than pinning the value to `undefined`.
 */
export function resolveModuleConfig<TDefaults extends object>(
  defaults: TDefaults,
  options?: Partial<TDefaults> | undefined,
): TDefaults {
  if (!options) return { ...defaults };

  const resolved = { ...defaults };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      (resolved as Record<string, unknown>)[key] = value;
    }
  }
  return resolved;
}

/**
 * Boolean env parsing that rejects nonsense instead of treating it as false.
 *
 * @remarks `Boolean('false')` is `true`, which is the single most common config bug in a
 * Nest codebase: a disabled-by-default feature turns on in production and nobody notices
 * until it sends an email to every user.
 */
export const envBoolean = (fallback: boolean): z.ZodType<boolean, unknown> =>
  z
    .string()
    .optional()
    .transform((value: string | undefined) => {
      if (value === undefined) return fallback;
      const normalised = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off'].includes(normalised)) return false;
      throw new Error(`Expected a boolean, received "${value}"`);
    });

/**
 * Integer env var with an optional range.
 *
 * @remarks Bounds are applied before `.default()`. In zod v4 a defaulted schema no longer
 * exposes the numeric checks, so `envInt(100).min(1)` is a type error — the range has to be
 * part of what `envInt` builds.
 */
export const envInt = (
  fallback: number,
  range: { min?: number; max?: number } = {},
): z.ZodType<number, unknown> => {
  let schema = z.coerce.number().int();
  if (range.min !== undefined) schema = schema.min(range.min);
  if (range.max !== undefined) schema = schema.max(range.max);
  return schema.optional().default(fallback) as unknown as z.ZodType<number, unknown>;
};

export const envString = (fallback: string) =>
  z.string().optional().default(fallback);

/**
 * A secret with no default.
 *
 * @remarks Deliberately has no `.default()`. A secret that silently falls back to a
 * known value is worse than a service that refuses to boot: one is an outage, the other is
 * an incident.
 */
export const envSecret = (description: string) =>
  z
    .string()
    .min(1, `${description} must be set`)
    .describe(description);