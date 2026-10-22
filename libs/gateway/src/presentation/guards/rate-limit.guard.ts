/**
 * @fileoverview Spends the caller's rate-limit budget, or refuses the request.
 *
 * @remarks Mounted **before** `JwtAuthGuard`, so it is the first thing an unauthenticated
 * request meets. That ordering is what makes it useful against volumetric abuse: the attacks it
 * stops — credential stuffing, password spraying, scraping — are unauthenticated by construction,
 * and a limiter that only runs after a token is checked never sees them.
 *
 * @remarks Keyed by address, because that is the only identifier a pre-authentication guard has.
 * Per-account throttling of sign-in attempts is account lockout's job, done by the service that
 * owns the login rather than guessed at here.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
// Value import on purpose — see the note in `jwt-auth.guard.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import {
  RATE_LIMIT_CONFIG,
  RATE_LIMITER,
  type RateLimitConfig,
  type RateLimiter,
} from '@auth/infra/rate-limit';
import { TooManyRequestsException } from '@auth/platform/error-handling';
import type { GatewayRequest } from '../gateway-request';
import { RATE_LIMIT, type RateLimitOptions } from '../decorators/rate-limit';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.enabled) return true;

    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const response = context.switchToHttp().getResponse();

    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);

    const limit = options?.limit ?? this.config.defaultLimit;
    const windowSec = options?.windowSec ?? this.config.defaultWindowSec;

    const result = await this.limiter.check(this.keyFor(request), limit, windowSec);

    if (this.config.headers) {
      response.setHeader('X-RateLimit-Limit', String(result.limit));
      response.setHeader('X-RateLimit-Remaining', String(result.remaining));
      response.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetMs / 1_000)));
      if (!result.allowed) {
        response.setHeader('Retry-After', String(result.retryAfterSec));
      }
    }

    if (!result.allowed) {
      // The delay is in the body as well as the header: a client that reads one and not the
      // other is common, and a limit the client cannot act on is a limit it will retry against.
      throw new TooManyRequestsException('too many requests', {
        retryAfterSec: result.retryAfterSec,
        limit,
        windowSec,
      });
    }

    return true;
  }

  /**
   * The bucket this request spends from.
   *
   * @remarks Read from the socket, never from `X-Forwarded-For`. That header is caller-controlled,
   * and a limiter whose key a caller can set is a limiter with a "no" button on it.
   */
  private keyFor(request: GatewayRequest): string {
    return `ip:${request.socket?.remoteAddress ?? request.ip ?? 'unknown'}`;
  }
}
