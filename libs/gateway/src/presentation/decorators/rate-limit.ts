/**
 * @fileoverview Per-route rate-limit overrides.
 *
 * @remarks The default limit is global and lives in config; this decorator is for the routes
 * where the default is the wrong answer — a sensitive endpoint that should be harder to reach
 * than the rest of the surface.
 *
 * @remarks Deliberately no "key by account" option. Throttling one account's password guesses is
 * account lockout's job, and it is a different question from "how much traffic is this route
 * taking": the first is answered per account by the service that owns the login, the second per
 * address here. A rate limiter that tried to do both would need the principal, which does not
 * exist at this point in the chain.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export interface RateLimitOptions {
  /** Requests permitted per key per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export const RATE_LIMIT = Symbol('RATE_LIMIT');

export const RateLimit = (options: RateLimitOptions): CustomDecorator<symbol> =>
  SetMetadata(RATE_LIMIT, options);
