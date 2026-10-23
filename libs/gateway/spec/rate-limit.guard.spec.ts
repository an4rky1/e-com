/**
 * @fileoverview `RateLimitGuard`: how the edge spends a caller's budget.
 *
 * @remarks The guard is a thin shell around the limiter, and every decision it makes is worth
 * pinning: which key a request is charged to, whether the route's own limit overrides the global
 * one, and whether the delay is available to a client that reads the body rather than the
 * headers. The limiter itself is tested against a real Redis; this is only about the wiring.
 */
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimit } from '../src/presentation/decorators/rate-limit';
import { RateLimitGuard } from '../src/presentation/guards/rate-limit.guard';
import type { RateLimitConfig } from '@auth/infra/rate-limit';
import type { RateLimiter, RateLimitResult } from '@auth/infra/rate-limit';
import { TooManyRequestsException } from '@auth/platform/error-handling';
import type { GatewayRequest } from '../src/presentation/gateway-request';

const config = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  enabled: true,
  defaultLimit: 100,
  defaultWindowSec: 60,
  failOpen: true,
  headers: true,
  keyPrefix: 'rl',
  redisUrl: null,
  ...over,
});

class ScriptableLimiter implements RateLimiter {
  readonly keys: Array<{ key: string; limit: number; windowSec: number }> = [];
  result: RateLimitResult = {
    allowed: true,
    limit: 100,
    remaining: 99,
    resetMs: 0,
    retryAfterSec: 0,
  };

  async check(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    this.keys.push({ key, limit, windowSec });
    return this.result;
  }
}

class TestRoutes {
  @RateLimit({ limit: 5, windowSec: 30 })
  strict(): string {
    return 'strict';
  }

  plain(): string {
    return 'plain';
  }
}

const contextFor = (
  request: Partial<GatewayRequest>,
  handler: keyof TestRoutes = 'plain',
): { context: ExecutionContext; setHeader: jest.Mock } => {
  const setHeader = jest.fn();
  const context = {
    getHandler: () => TestRoutes.prototype[handler],
    getClass: () => TestRoutes,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
};

const requestFrom = (ip: string, headers: Record<string, string> = {}): Partial<GatewayRequest> => ({
  headers,
  ip,
  socket: { remoteAddress: ip },
});

describe('RateLimitGuard', () => {
  it('allows a request under the limit and reports the budget in the headers', async () => {
    const limiter = new ScriptableLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter, config());
    const { context, setHeader } = contextFor(requestFrom('203.0.113.7'));

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(limiter.keys).toEqual([
      { key: 'ip:203.0.113.7', limit: 100, windowSec: 60 },
    ]);
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '100');
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '99');
  });

  it('refuses over the limit, with the delay in the body as well as the header', async () => {
    const limiter = new ScriptableLimiter();
    limiter.result = {
      allowed: false,
      limit: 100,
      remaining: 0,
      resetMs: Date.now() + 45_000,
      retryAfterSec: 45,
    };
    const guard = new RateLimitGuard(new Reflector(), limiter, config());
    const { context, setHeader } = contextFor(requestFrom('203.0.113.7'));

    const error = await guard.canActivate(context).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TooManyRequestsException);
    expect((error as TooManyRequestsException).getStatus()).toBe(429);
    expect((error as TooManyRequestsException).context).toMatchObject({ retryAfterSec: 45 });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '45');
  });

  it('prefers the route limit over the global one', async () => {
    const limiter = new ScriptableLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter, config());

    await guard.canActivate(contextFor(requestFrom('203.0.113.7'), 'strict').context);

    expect(limiter.keys[0]).toEqual({ key: 'ip:203.0.113.7', limit: 5, windowSec: 30 });
  });

  it('charges the socket address, never a header the caller controls', async () => {
    const limiter = new ScriptableLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter, config());
    // `X-Forwarded-For` is set by the caller and is exactly the header a limiter must ignore:
    // a key the caller can choose is a limit the caller can reset.
    const request = requestFrom('203.0.113.7', { 'x-forwarded-for': '10.0.0.1' });

    await guard.canActivate(contextFor(request).context);

    expect(limiter.keys[0]?.key).toBe('ip:203.0.113.7');
  });

  it('does nothing at all when rate limiting is disabled', async () => {
    const limiter = new ScriptableLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter, config({ enabled: false }));

    await guard.canActivate(contextFor(requestFrom('203.0.113.7')).context);

    expect(limiter.keys).toEqual([]);
  });
});
