/**
 * @fileoverview Refresh-token lifecycle states.
 *
 * @remarks `retired` is the load-bearing one. A token that has already been exchanged is
 * marked here rather than deleted, because the next presentation of that same token is
 * precisely the signal that it was stolen — and that signal only exists if the row survives.
 *
 * @remarks The names are the table's, not this file's: `refresh_tokens_status_check` admits
 * exactly `active`, `retired` and `revoked`. A domain that spells the third state `rotated`
 * fails at runtime on the first rotation with a Postgres check-constraint error — which reads
 * as "the database is broken" and is not, because the schema is the older contract here and
 * the vocabulary has to meet it rather than the other way round.
 */

export const TokenStatus = {
  /** Issued and never exchanged. The only state that may be rotated. */
  ACTIVE: 'active',
  /** Exchanged exactly once. Presenting it again is reuse. */
  RETIRED: 'retired',
  /** Withdrawn without being exchanged (logout, reuse detection, family revocation). */
  REVOKED: 'revoked',
} as const;

export type TokenStatus = (typeof TokenStatus)[keyof typeof TokenStatus];

/**
 * States from which a token can no longer be exchanged.
 *
 * @remarks Deliberately excludes "expired": an expired token is refused because of its
 * `expires_at`, not because it was consumed, and treating the two alike would report a
 * user who simply waited too long as a token thief.
 */
export const CONSUMED_TOKEN_STATUSES: ReadonlySet<TokenStatus> = new Set([
  TokenStatus.RETIRED,
  TokenStatus.REVOKED,
]);

/**
 * What a stored token is.
 *
 * @remarks The table has a `token_type` column, so the schema already anticipates more than
 * one kind of token. Only `refresh` is issued today; naming the value keeps the column from
 * being filled with a bare `'token'` that nothing can interpret later.
 */
export const TokenType = {
  REFRESH: 'refresh',
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export function isTokenStatus(value: unknown): value is TokenStatus {
  return (
    typeof value === 'string' &&
    (Object.values(TokenStatus) as string[]).includes(value)
  );
}