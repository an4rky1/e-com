/**
 * @fileoverview A guard's unit test, without a guard's container.
 *
 * @remarks `ExecutionContext` is a three-method interface and `Reflector` reads real metadata
 * off real decorated methods. That is enough to exercise everything a guard decides — whether
 * a route is public, what the request carries, what the principal becomes — with no Nest
 * bootstrap, no HTTP server and no socket. A container here would test Nest, not the guard.
 *
 * @remarks The decorated class below is a *shape*, not a controller under test. It exists so
 * the metadata a real route carries is real metadata rather than a stubbed answer.
 */
import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenCodec } from '@auth/contracts';
import { JwtAuthGuard } from '../../src/presentation/guards/jwt-auth.guard';
import {
  AllowGuest,
  Public,
  RequirePermissions,
} from '../../src/presentation/decorators/route-metadata';
import type { GatewayRequest } from '../../src/presentation/gateway-request';
import type { GatewayTokenTrust } from '../../src/gateway.config';

/**
 * The key this suite signs with. The guard verifies locally, so a test token has to be a real
 * token — signed with the key the guard was configured with, exactly as session would
 * sign it — rather than the opaque string an opaque peer call used to stand in for.
 */
export const TEST_SIGNING_KEY = 'a-test-signing-key-that-is-only-ever-used-here';
export const TEST_OTHER_KEY = 'a-different-key-entirely-32-bytes-of-entropy';
/** The skew under test, mirroring the issuer's default. */
export const TEST_CLOCK_SKEW_SEC = 30;

/**
 * Signs a token the guard should accept, with any claim overridden per test.
 *
 * @remarks Defaults mirror the claims `peer-doubles` exports, so a test that only cares about
 * "a valid token" keeps reading as one.
 */
export const signTestToken = (
  overrides: Partial<{
    userId: string;
    sessionId: string;
    email: string;
    tokenFamilyId: string;
    roles: readonly string[];
    permissions: readonly string[];
    issuedAt: Date;
    expiresAt: Date;
    key: string;
  }> = {},
): string =>
  AccessTokenCodec.sign(
    {
      userId: overrides.userId ?? '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      sessionId: overrides.sessionId ?? 'session-1',
      email: overrides.email ?? 'person@example.com',
      tokenFamilyId: overrides.tokenFamilyId ?? '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      roles: overrides.roles ?? ['member'],
      permissions: overrides.permissions ?? ['users:read'],
      issuedAt: overrides.issuedAt ?? new Date(),
      expiresAt:
        overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1_000),
    },
    overrides.key ?? TEST_SIGNING_KEY,
  );

/**
 * Route shapes carrying the same metadata the real controllers carry.
 *
 * @remarks The bodies do nothing, and are never called. They exist so `@Public()` and
 * `@RequirePermissions()` are applied to real functions — `Reflector` then reads real
 * metadata rather than a stubbed answer, which is the only part of the guards that could
 * plausibly be wrong.
 */
class TestRoutes {
  @Public()
  open(): string {
    return 'open';
  }

  /** The cart shape: no bearer required, but a `X-Guest-Id` has to name somebody. */
  @Public()
  @AllowGuest()
  guestOpen(): string {
    return 'guestOpen';
  }

  @RequirePermissions('users:password.set')
  protected(): string {
    return 'protected';
  }

  plain(): string {
    return 'plain';
  }
}

export const contextFor = (
  request: Partial<GatewayRequest>,
  handler: keyof TestRoutes = 'plain',
): ExecutionContext =>
  ({
    getHandler: () => TestRoutes.prototype[handler],
    getClass: () => TestRoutes,
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

export const requestWithToken = (token: string): Partial<GatewayRequest> => ({
  headers: { authorization: `Bearer ${token}` },
});

export const requestWithoutToken = (): Partial<GatewayRequest> => ({ headers: {} });

/** Awaits a promise expected to reject, and returns the reason. */
export const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
};

/** A guard configured the way the module configures it: local key, local skew. */
export const guardWith = (config: Partial<GatewayTokenTrust> = {}) => ({
  guard: new JwtAuthGuard(new Reflector(), {
    accessTokenSigningKey: config.accessTokenSigningKey ?? TEST_SIGNING_KEY,
    clockSkewSec: config.clockSkewSec ?? TEST_CLOCK_SKEW_SEC,
  }),
});
