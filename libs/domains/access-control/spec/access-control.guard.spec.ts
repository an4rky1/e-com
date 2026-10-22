import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionDeniedException } from '@auth/platform/error-handling';
import { AccessControlGuard } from '../src/presentation/guards/access-control.guard';
import {
  PublicEndpoint,
  RequireAnyPermission,
  RequirePermissions,
} from '../src/presentation/decorators/require-permissions.decorator';
import type { PermissionChecker } from '../src/application/facade/access-control.service';

const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** The handlers carry metadata and nothing else; no body is ever executed. */
class TestController {
  @RequirePermissions('users:write')
  write(): string {
    return 'write';
  }

  @RequireAnyPermission('users:write', 'users:read')
  read(): string {
    return 'read';
  }

  @PublicEndpoint()
  open(): string {
    return 'open';
  }

  plain(): string {
    return 'plain';
  }
}

/** Records what the guard asked for, so the test can assert on the decision path too. */
class StubChecker implements PermissionChecker {
  readonly calls: { userId: string; permission: string; context?: Record<string, string> }[] =
    [];

  constructor(private readonly granted: readonly string[]) {}

  checkPermission(input: {
    userId: string;
    permission: string;
    context?: Record<string, string>;
  }): Promise<{ allowed: boolean; reason: string }> {
    this.calls.push(input);
    return Promise.resolve(
      this.granted.includes(input.permission)
        ? { allowed: true, reason: 'granted by the test' }
        : { allowed: false, reason: 'not granted' },
    );
  }
}

const guardFor = (granted: readonly string[]): AccessControlGuard =>
  new AccessControlGuard(new Reflector(), new StubChecker(granted));

const contextFor = (handler: (...args: never[]) => void, user?: unknown): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => ({ user, attributes: { resourceType: 'invoice' } }),
    }),
  }) as unknown as ExecutionContext;

const asHandler = (method: keyof TestController) =>
  TestController.prototype[method] as unknown as (...args: never[]) => void;

describe('AccessControlGuard', () => {
  it('allows when the required permission is present', async () => {
    const guard = guardFor(['users:write']);

    const allowed = await guard.canActivate(
      contextFor(asHandler('write'), { userId: USER }),
    );

    expect(allowed).toBe(true);
  });

  it('denies when the permission is missing', async () => {
    const guard = guardFor([]);

    await expect(
      guard.canActivate(contextFor(asHandler('write'), { userId: USER })),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
  });

  it('refuses an anonymous caller even when the permission would be granted', async () => {
    // Authorization cannot answer for a caller nobody has authenticated: `userId` is the
    // subject the whole decision is about.
    const guard = guardFor(['users:write']);

    await expect(guard.canActivate(contextFor(asHandler('write')))).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
  });

  it('does not leak the reason a decision was refused', async () => {
    const guard = guardFor([]);

    let thrown: unknown;
    await guard
      .canActivate(contextFor(asHandler('write'), { userId: USER }))
      .catch((error: unknown) => {
        thrown = error;
      });

    const body = JSON.stringify((thrown as PermissionDeniedException).getResponse());
    expect(body).not.toMatch(/not granted/);
    expect(body).toMatch(/lacks the required permission/);
  });

  it('requires every permission in `all` mode', async () => {
    // The controller uses one decorator for single permissions; this proves the AND holds
    // when more than one is listed.
    class MultiController {
      @RequirePermissions('users:write', 'billing:invoice.write')
      both(): string {
        return 'both';
      }
    }

    const context = {
      getHandler: () => MultiController.prototype.both,
      getClass: () => MultiController,
      switchToHttp: () => ({ getRequest: () => ({ user: { userId: USER } }) }),
    } as unknown as ExecutionContext;

    await expect(
      guardFor(['users:write']).canActivate(context),
    ).rejects.toBeInstanceOf(PermissionDeniedException);

    await expect(
      guardFor(['users:write', 'billing:invoice.write']).canActivate(context),
    ).resolves.toBe(true);
  });

  it('requires only one permission in `any` mode', async () => {
    const guard = guardFor(['users:read']);

    await expect(
      guard.canActivate(contextFor(asHandler('read'), { userId: USER })),
    ).resolves.toBe(true);
  });

  it('passes the request attributes through as the ABAC context', async () => {
    const guard = guardFor(['users:write']);

    await guard.canActivate(contextFor(asHandler('write'), { userId: USER }));

    const checker = (guard as unknown as {
      permissions: StubChecker;
    }).permissions;
    expect(checker.calls[0]).toMatchObject({
      userId: USER,
      permission: 'users:write',
      context: { resourceType: 'invoice' },
    });
  });

  it('skips the round trip for a permission the verified token already carries', async () => {
    const guard = guardFor([]);

    const allowed = await guard.canActivate(
      contextFor(asHandler('write'), { userId: USER, permissions: ['users:write'] }),
    );

    expect(allowed).toBe(true);
    const checker = (guard as unknown as { permissions: StubChecker }).permissions;
    expect(checker.calls).toHaveLength(0);
  });

  it('accepts a JWT-shaped principal through `sub`', async () => {
    const guard = guardFor(['users:write']);

    await expect(
      guard.canActivate(contextFor(asHandler('write'), { sub: USER })),
    ).resolves.toBe(true);
  });

  it('lets an authenticated caller through a public route', async () => {
    const guard = guardFor([]);

    await expect(
      guard.canActivate(contextFor(asHandler('open'), { userId: USER })),
    ).resolves.toBe(true);
  });

  it('fails closed on a route with no decorator at all', async () => {
    // Forgetting the decorator must be the safe mistake, not the leaky one.
    const guard = guardFor(['users:write']);

    await expect(
      guard.canActivate(contextFor(asHandler('plain'), { userId: USER })),
    ).resolves.toBe(true);

    await expect(
      guard.canActivate(contextFor(asHandler('plain'))),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
  });
});