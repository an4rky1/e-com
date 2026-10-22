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
import { JwtAuthGuard } from '../../src/presentation/guards/jwt-auth.guard';
import {
  Public,
  RequirePermissions,
} from '../../src/presentation/decorators/route-metadata';
import type { GatewayRequest } from '../../src/presentation/gateway-request';
import { FakeSessionClient } from './peer-doubles';

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

  @RequirePermissions('users:password:set')
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

/** A guard with a scriptable session peer. */
export const guardWith = (sessions: FakeSessionClient = new FakeSessionClient()) => ({
  guard: new JwtAuthGuard(new Reflector(), sessions),
  sessions,
});
