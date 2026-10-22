/**
 * @fileoverview `@Public()` and `JwtAuthGuard`: who reaches the edge, and who does not.
 *
 * @remarks The rule under test is deny-by-default. An undecorated route is closed; only
 * `@Public()` opens a route ahead of a token. Getting that ordering wrong is how a login
 * endpoint becomes unreachable, and the failure is a 401 rather than a boot error — so it
 * ships, and it ships quietly.
 */
import { HttpStatus } from '@nestjs/common';
import { TokenInvalidException } from '@auth/platform/error-handling';
import { USER_ID, EMAIL, SESSION_ID, ACCESS_TOKEN } from './testing/peer-doubles';
import {
  contextFor,
  guardWith,
  rejection,
  requestWithToken,
  requestWithoutToken,
} from './testing/guard-harness';

describe('JwtAuthGuard', () => {
  describe('a route marked @Public()', () => {
    it('admits a caller with no token at all', async () => {
      const { guard, sessions } = guardWith();

      await expect(
        guard.canActivate(contextFor(requestWithoutToken(), 'open')),
      ).resolves.toBe(true);

      // No peer call either: a public route must not be able to fail because a dependency is
      // down, or an outage turns the login page into a 503.
      expect(sessions.validated).toEqual([]);
    });

    it('ignores a token it was handed', async () => {
      const { guard, sessions } = guardWith();

      await expect(
        guard.canActivate(contextFor(requestWithToken(ACCESS_TOKEN), 'open')),
      ).resolves.toBe(true);
      expect(sessions.validated).toEqual([]);
    });
  });

  describe('a route with no @Public()', () => {
    it('refuses a request with no Authorization header', async () => {
      const { guard, sessions } = guardWith();

      const error = await rejection(guard.canActivate(contextFor(requestWithoutToken())));

      expect(error).toBeInstanceOf(TokenInvalidException);
      expect((error as TokenInvalidException).getStatus()).toBe(
        HttpStatus.UNAUTHORIZED,
      );
      expect(sessions.validated).toEqual([]);
    });

    it('refuses a header that is not a bearer scheme', async () => {
      const { guard } = guardWith();
      const request = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };

      const error = await rejection(guard.canActivate(contextFor(request)));

      expect(error).toBeInstanceOf(TokenInvalidException);
      expect((error as TokenInvalidException).getStatus()).toBe(
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('accepts the scheme in any case, because clients differ', async () => {
      const { guard } = guardWith();
      const request = { headers: { authorization: `bearer ${ACCESS_TOKEN}` } };

      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    });
  });

  describe('a protected route with a valid token', () => {
    it('admits the request', async () => {
      const { guard, sessions } = guardWith();

      await expect(
        guard.canActivate(contextFor(requestWithToken(ACCESS_TOKEN))),
      ).resolves.toBe(true);
      expect(sessions.validated).toEqual([ACCESS_TOKEN]);
    });

    it('puts on the request exactly what session-token described', async () => {
      const { guard } = guardWith();
      const request = requestWithToken(ACCESS_TOKEN);

      await guard.canActivate(contextFor(request));

      // Handlers read this and nothing else. A handler that could build its own principal
      // would be a second authority on who the caller is.
      expect(request.principal).toEqual({
        userId: USER_ID,
        email: EMAIL,
        sessionId: SESSION_ID,
        roles: ['member'],
        permissions: ['users:read'],
      });
    });
  });

  describe('a token the session engine rejects', () => {
    it('refuses with a 401, not a 500', async () => {
      const { guard, sessions } = guardWith();
      sessions.validation = { ...sessions.validation, valid: false };

      const error = await rejection(
        guard.canActivate(contextFor(requestWithToken(ACCESS_TOKEN))),
      );

      expect(error).toBeInstanceOf(TokenInvalidException);
      expect((error as TokenInvalidException).getStatus()).toBe(
        HttpStatus.UNAUTHORIZED,
      );
    });

    it('relays the revocation reason without relaying the token', async () => {
      const { guard, sessions } = guardWith();
      sessions.validation = {
        ...sessions.validation,
        valid: false,
        revocationReason: 'session revoked by user',
      };

      const error = (await rejection(
        guard.canActivate(contextFor(requestWithToken(ACCESS_TOKEN))),
      )) as TokenInvalidException;

      expect(error.context['reason']).toBe('session revoked by user');
      // The rejected credential is the one thing that must not be in the error: it is exactly
      // what an operator reading the log would otherwise be holding.
      expect(JSON.stringify(error.context)).not.toContain(ACCESS_TOKEN);
    });
  });
});
