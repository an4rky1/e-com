import { z } from 'zod';
import { envBoolean, envInt, envSecret } from '@auth/platform/config';

export const SESSION_TOKEN_PRISMA = Symbol('SESSION_TOKEN_PRISMA');
export const SESSION_TOKEN_CONFIG = Symbol('SESSION_TOKEN_CONFIG');

export const Defaults = {
  /** 15 minutes — the blast radius of a leaked access token. */
  ACCESS_TOKEN_TTL_SEC: 900,
  /** 30 days — long enough to be usable, short enough to expire. */
  REFRESH_TOKEN_TTL_SEC: 2_592_000,
  /**
   * Tolerance applied to `exp` when validating.
   *
   * @remarks Issuance and verification usually happen in different pods, and a token minted
   * one second before the verifier's clock catches up would be rejected as expired. Thirty
   * seconds is far below the token's own lifetime, so the skew widens exposure by 3% at
   * worst while removing a class of "logged out for no reason" bug.
   */
  CLOCK_SKEW_SEC: 30,
  /**
   * Whether a replayed refresh token is treated as theft.
   *
   * @remarks Exists as an operator escape hatch only, and it never *permits* a replay to
   * succeed: with detection off, a consumed token is still refused. What changes is that the
   * family is not revoked and no security event is raised, which is only ever appropriate on
   * a known-benign client double-submitting.
   */
  REUSE_REVOKES_FAMILY: true,
} as const;

/**
 * Session-token's own configuration namespace.
 *
 * @remarks No connection parameters here. `DATABASE_URL` is platform-owned; a module that
 * could reconfigure its own connection would make "one service, one database" unenforceable.
 */
export const sessionTokenSchema = z.object({
  ACCESS_TOKEN_TTL_SEC: envInt(Defaults.ACCESS_TOKEN_TTL_SEC, { min: 30, max: 86_400 }),
  REFRESH_TOKEN_TTL_SEC: envInt(Defaults.REFRESH_TOKEN_TTL_SEC, { min: 300, max: 31_536_000 }),
  CLOCK_SKEW_SEC: envInt(Defaults.CLOCK_SKEW_SEC, { min: 0, max: 300 }),
  REUSE_REVOKES_FAMILY: envBoolean(Defaults.REUSE_REVOKES_FAMILY),
  /**
   * HMAC key for access tokens.
   *
   * @remarks Required with no default. An access token has no row to be verified against, so
   * this key is the only thing between a leaked session id and an impersonated user; a default
   * here would be a well-known key in production.
   */
  ACCESS_TOKEN_SIGNING_KEY: envSecret('SESSION_ACCESS_TOKEN_SIGNING_KEY'),
});

export type SessionTokenEnvConfig = z.infer<typeof sessionTokenSchema>;

export interface SessionTokenConfig {
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  clockSkewSec: number;
  reuseRevokesFamily: boolean;
  accessTokenSigningKey: string;
}