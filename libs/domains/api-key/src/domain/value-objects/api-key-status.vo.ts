/**
 * @fileoverview Lifecycle states of an issued key.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the wire format is plain text. The `status`
 * column is `text` for the same reason — adding a state must not be a migration.
 *
 * @remarks There is no sweeper and no `expired` transition. Expiry is evaluated against
 * `expires_at` on every presentation, because a job that has to keep up with every live key
 * is a dependency this service does not need to have; a key whose lifetime ran out stops
 * working on the next request and nobody has to notice that it happened.
 */

export const ApiKeyStatus = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const;

export type ApiKeyStatus = (typeof ApiKeyStatus)[keyof typeof ApiKeyStatus];

/** States from which a key may still authenticate a request. */
export const USABLE_STATUSES: ReadonlySet<ApiKeyStatus> = new Set([
  ApiKeyStatus.ACTIVE,
]);

/** States a key can never leave. */
export const TERMINAL_STATUSES: ReadonlySet<ApiKeyStatus> = new Set([
  ApiKeyStatus.REVOKED,
  ApiKeyStatus.EXPIRED,
]);

export function isApiKeyStatus(value: unknown): value is ApiKeyStatus {
  return (
    typeof value === 'string' &&
    (Object.values(ApiKeyStatus) as string[]).includes(value)
  );
}