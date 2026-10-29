/**
 * @fileoverview `@Public()` and `JwtAuthGuard`: who reaches the edge, and who does not.
 *
 * @remarks The rule under test is deny-by-default. An undecorated route is closed; only
 * `@Public()` opens a route ahead of a token. Getting that ordering wrong is how a login
 * endpoint becomes unreachable, and the failure is a 401 rather than a boot error — so it
 * ships, and it ships quietly.
 *
 * @remarks The guard verifies locally, so every "valid token" here is a real signed token —
 * minted with the harness key the guard was configured with. A test double for the answer
 * would exercise the guard's plumbing and skip the only thing it does: check the signature.
 */
import { HttpStatus } from '@nestjs/common';
import { TokenExpiredException, TokenInvalidException } from '@auth/platform/error-handling';
import { USER_ID, EMAIL, SESSION_ID } from './testing/peer-doubles';
import {
  TEST_CLOCK_SKEW_SEC,
  TEST_OTHER_KEY,
  contextFor,
  guardWith,
  rejection,
  requestWithToken,
  requestWithoutToken,
  signTestToken,
} from './testing/guard-harness';

describe('JwtAuthGuard', () => {
  describe('a route marked @Public()', () => {
    it('admits a caller with no token at all', () => {
      const { guard } = guardWith();

      expect(guard.canActivate(contextFor(requestWithoutToken(), 'open'))).toBe(true);
    });

    it('ignores a token it was handed — even one that would fail verification', () => {
      const { guard } = guardWith();
      const forged = signTestToken({ key: TEST_OTHER_KEY });

      expect(guard.canActivate(contextFor(requestWithToken(forged), 'open'))).toBe(true);
    });
  });

  describe('a route with no @Public()', () => {
    it('refuses a request with no Authorization header', () => {
      const { guard } = guardWith();

      const error = rejection(
        Promise.resolve().then(() => guard.canActivate(contextFor(requestWithoutToken()))),
      );

      return error.then((caught: unknown) => {
        expect(caught).toBeInstanceOf(TokenInvalidException);
        expect((caught as TokenInvalidException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      });
    });

    it('refuses a header that is not a bearer scheme', () => {
      const { guard } = guardWith();
      const request = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };

      return rejection(
        Promise.resolve().then(() => guard.canActivate(contextFor(request))),
      ).then((caught: unknown) => {
        expect(caught).toBeInstanceOf(TokenInvalidException);
        expect((caught as TokenInvalidException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      });
    });

    it('accepts the scheme in any case, because clients differ', () => {
      const { guard } = guardWith();
      const request = { headers: { authorization: `bearer ${signTestToken()}` } };

      expect(guard.canActivate(contextFor(request))).toBe(true);
    });
  });

  describe('a protected route with a valid token', () => {
    it('admits the request', () => {
      const { guard } = guardWith();

      expect(guard.canActivate(contextFor(requestWithToken(signTestToken())))).toBe(true);
    });

    it('puts on the request exactly what the token asserts', () => {
      const { guard } = guardWith();
      const request = requestWithToken(signTestToken());

      guard.canActivate(contextFor(request));

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

  describe('a token the signature rejects', () => {
    it('refuses a token signed with someone else\'s key, with a 401 not a 500', () => {
      const { guard } = guardWith();
      const forged = signTestToken({ key: TEST_OTHER_KEY });

      return rejection(
        Promise.resolve().then(() => guard.canActivate(contextFor(requestWithToken(forged)))),
      ).then((caught: unknown) => {
        expect(caught).toBeInstanceOf(TokenInvalidException);
        expect((caught as TokenInvalidException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
        expect((caught as TokenInvalidException).context['reason']).toBe('bad_signature');
        // The rejected credential is the one thing that must not be in the error: it is
        // exactly what an operator reading the log would otherwise be holding.
        expect(JSON.stringify((caught as TokenInvalidException).context)).not.toContain(forged);
      });
    });

    it('refuses a token that is not three segments of ours', () => {
      const { guard } = guardWith();

      return rejection(
        Promise.resolve().then(() =>
          guard.canActivate(contextFor(requestWithToken('not.a.jwt'))),
        ),
      ).then((caught: unknown) => {
        expect(caught).toBeInstanceOf(TokenInvalidException);
        expect((caught as TokenInvalidException).context['reason']).toBe('malformed');
      });
    });
  });

  describe('an expired token', () => {
    it('refuses a token past its exp plus the skew', () => {
      const { guard } = guardWith();
      const expired = signTestToken({
        issuedAt: new Date(Date.now() - 20 * 60 * 1_000),
        expiresAt: new Date(Date.now() - (TEST_CLOCK_SKEW_SEC + 1) * 1_000),
      });

      return rejection(
        Promise.resolve().then(() => guard.canActivate(contextFor(requestWithToken(expired)))),
      ).then((caught: unknown) => {
        expect(caught).toBeInstanceOf(TokenExpiredException);
        expect((caught as TokenExpiredException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      });
    });

    it('admits a token inside the skew, because two pods disagree about the clock', () => {
      const { guard } = guardWith();
      const justExpired = signTestToken({
        issuedAt: new Date(Date.now() - 16 * 60 * 1_000),
        expiresAt: new Date(Date.now() - (TEST_CLOCK_SKEW_SEC - 5) * 1_000),
      });

      expect(guard.canActivate(contextFor(requestWithToken(justExpired)))).toBe(true);
    });
  });
});
