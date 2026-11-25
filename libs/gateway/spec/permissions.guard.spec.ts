/**
 * @fileoverview `PermissionsGuard`: authorization is asked for, never reimplemented.
 *
 * @remarks Every case here asserts the same two things — what was asked of access-control, and
 * that the answer became the HTTP status. What it deliberately does not assert is any mapping
 * from role to permission inside this process, because there is none. A guard that grew a
 * `if (roles.includes('admin'))` would pass these tests and fail the requirement, which is why
 * the double answers from a permission list and not from a role list: there is nothing else
 * for the guard to consult.
 */
import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PermissionDeniedException,
  TokenInvalidException,
} from '@auth/platform/error-handling';
import { PermissionsGuard } from '../src/presentation/guards/permissions.guard';
import type { GatewayRequest } from '../src/presentation/gateway-request';
import {
  FakeAccessControlClient,
  USER_ID,
  principalOf,
} from './testing/peer-doubles';
import { contextFor, rejection, requestWithToken } from './testing/guard-harness';

const guardWith = (accessControl = new FakeAccessControlClient()) => ({
  guard: new PermissionsGuard(new Reflector(), accessControl),
  accessControl,
});

const authenticated = (): Partial<GatewayRequest> => ({
  ...requestWithToken('access.token.value'),
  principal: principalOf(),
});

describe('PermissionsGuard', () => {
  describe('a route that declares no permission', () => {
    it('asks nothing', async () => {
      const { guard, accessControl } = guardWith();

      await expect(guard.canActivate(contextFor(authenticated()))).resolves.toBe(true);
      expect(accessControl.granted).toEqual([]);
    });
  });

  describe('a route that declares a permission', () => {
    it('asks access-control, on the principal the session engine produced', async () => {
      const { guard, accessControl } = guardWith();

      await expect(
        guard.canActivate(contextFor(authenticated(), 'protected')),
      ).resolves.toBe(true);

      expect(accessControl.granted).toEqual([
        { userId: USER_ID, permission: 'users:password.set' },
      ]);
    });

    it('turns a denial into a 403', async () => {
      const { guard, accessControl } = guardWith();
      accessControl.permissions = ['users:read'];

      const error = await rejection(
        guard.canActivate(contextFor(authenticated(), 'protected')),
      );

      expect(error).toBeInstanceOf(PermissionDeniedException);
      expect((error as PermissionDeniedException).getStatus()).toBe(
        HttpStatus.FORBIDDEN,
      );
    });

    it('carries access-control\'s reason, not a paraphrase of it', async () => {
      const { guard, accessControl } = guardWith();
      accessControl.permissions = [];

      const error = (await rejection(
        guard.canActivate(contextFor(authenticated(), 'protected')),
      )) as PermissionDeniedException;

      expect(error.context).toEqual({
        permission: 'users:password.set',
        reason: 'no role grants this permission',
      });
    });
  });

  describe('a guarded route reached without a principal', () => {
    it('refuses rather than asking on nobody\'s behalf', async () => {
      const { guard, accessControl } = guardWith();
      const request = requestWithToken('access.token.value');

      const error = await rejection(
        guard.canActivate(contextFor(request, 'protected')),
      );

      // Means the guard was mounted without `JwtAuthGuard` in front of it. Asking
      // access-control would then be a question about nobody.
      expect(error).toBeInstanceOf(TokenInvalidException);
      expect((error as TokenInvalidException).getStatus()).toBe(
        HttpStatus.UNAUTHORIZED,
      );
      expect(accessControl.granted).toEqual([]);
    });
  });
});
