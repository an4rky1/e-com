/**
 * @fileoverview `GuestIdentityGuard`: the other way a caller becomes somebody.
 *
 * @remarks A bearer reaches the cart with a principal already on the request and this
 * guard is a pass-through — the assertion that matters there is that it does *not*
 * overwrite the account with a guest id the browser also happened to send. Everything
 * else is the anonymous path: a uuid from `X-Guest-Id` becomes a session-only principal,
 * and neither absence nor garbage becomes one.
 *
 * @remarks The empty `userId` on the guest principal is the load-bearing part: cart keys
 * a basket by `session:` exactly when `userId` is empty, so this shape *is* the rule that
 * puts the basket under the guest id. A test that only checked "a principal was set"
 * would pass for a principal that addresses the wrong cart.
 */
import { HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUEST_ID_HEADER } from '@auth/contracts/http';
import {
  TokenInvalidException,
  ValidationException,
} from '@auth/platform/error-handling';
import { GuestIdentityGuard } from '../src/presentation/guards/guest-identity.guard';
import { EMAIL, SESSION_ID, USER_ID } from './testing/peer-doubles';
import {
  guardWith,
  contextFor,
  rejection,
  signTestToken,
  requestWithToken,
} from './testing/guard-harness';

const GUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const guard = new GuestIdentityGuard(new Reflector());

const requestWithGuestId = (guestId: string) => ({
  headers: { [GUEST_ID_HEADER]: guestId },
});

describe('GuestIdentityGuard', () => {
  it('leaves a route without @AllowGuest() alone, whatever it carries', () => {
    // The controllers this guard mounts on also carry plain `@Public()` routes — a
    // sign-in, the OAuth walk — where `JwtAuthGuard` admits the request without building a
    // principal. Demanding `X-Guest-Id` there would refuse a login for not being a guest.
    const request = requestWithGuestId('../drop-everything');

    expect(guard.canActivate(contextFor(request, 'open'))).toBe(true);
    expect(guard.canActivate(contextFor(request, 'plain'))).toBe(true);
    expect(request.principal).toBeUndefined();
  });

  it('passes through when a bearer already produced a principal', async () => {
    // The tab is signed in *and* still holds the guest id it shopped with. The account
    // wins; the header is not a second vote.
    const request = requestWithToken(signTestToken());
    guardWith().guard.canActivate(contextFor(request, 'guestOpen'));

    expect(guard.canActivate(contextFor(request, 'guestOpen'))).toBe(true);
    expect(request.principal).toEqual({
      userId: USER_ID,
      email: EMAIL,
      sessionId: SESSION_ID,
    });
  });

  it('supplies a session-only principal from the guest id', async () => {
    const request = requestWithGuestId(GUEST_ID);

    expect(guard.canActivate(contextFor(request, 'guestOpen'))).toBe(true);
    expect(request.principal).toEqual({
      userId: '',
      email: '',
      sessionId: GUEST_ID,
    });
  });

  it('trims the header, because proxies and hand-written clients differ', async () => {
    const request = requestWithGuestId(`  ${GUEST_ID}  `);

    guard.canActivate(contextFor(request, 'guestOpen'));

    expect(request.principal?.sessionId).toBe(GUEST_ID);
  });

  it('refuses a request with neither a bearer nor a guest id', () => {
    const request = { headers: {} as Record<string, string> };

    return rejection(
      Promise.resolve().then(() => guard.canActivate(contextFor(request, 'guestOpen'))),
    ).then((caught: unknown) => {
      expect(caught).toBeInstanceOf(TokenInvalidException);
      expect((caught as TokenInvalidException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      // The scheme it asks for is the one thing a client needs from the 401.
      expect((caught as TokenInvalidException).context['scheme']).toBe(
        `${GUEST_ID_HEADER}: <guestId>`,
      );
    });
  });

  it('refuses an empty guest id the same way', () => {
    const request = requestWithGuestId('   ');

    return rejection(
      Promise.resolve().then(() => guard.canActivate(contextFor(request, 'guestOpen'))),
    ).then((caught: unknown) => {
      expect(caught).toBeInstanceOf(TokenInvalidException);
    });
  });

  it('refuses a guest id that is not a uuid — before it can become a key', async () => {
    // Anything else would be written into Redis as `session:<whatever arrived>`: the
    // check is the whole reason an unvalidated string never reaches the cart.
    const request = requestWithGuestId('../drop-everything');

    await expect(
      rejection(
        Promise.resolve().then(() => guard.canActivate(contextFor(request, 'guestOpen'))),
      ),
    ).resolves.toBeInstanceOf(ValidationException);
    expect(request.principal).toBeUndefined();
  });

  it('reports a non-uuid as a 400, not a 401', async () => {
    // A missing credential is the caller's to fix with a token or a header; a malformed
    // one is a bad request. Collapsing them into 401 would send a client hunting for an
    // authentication problem it does not have.
    const request = requestWithGuestId('not-a-uuid');

    const caught = await rejection(
      Promise.resolve().then(() => guard.canActivate(contextFor(request, 'guestOpen'))),
    );

    expect((caught as ValidationException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });
});
