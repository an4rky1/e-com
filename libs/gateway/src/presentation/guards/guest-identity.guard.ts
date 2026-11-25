/**
 * @fileoverview Supplies the guest identity on routes that accept one, or refuses.
 *
 * @remarks Acts only on routes marked `@AllowGuest()`, and is a no-op anywhere else —
 * because the controllers that mount it also carry plain `@Public()` routes (a sign-in, the
 * OAuth walk) where `JwtAuthGuard` admits the request without building a principal, and a
 * missing `X-Guest-Id` there is not a reason to refuse. The decorator is what makes the
 * guard mountable at controller level, next to routes it has no business with.
 *
 * @remarks On a guest-allowed route there are two outcomes only: a bearer already produced
 * a principal and this guard is a pass-through, or there is no principal and `X-Guest-Id`
 * has to name one. Nothing in between — a route that reached here with neither identity gets
 * a 401 rather than an anonymous principal that would address some default cart.
 *
 * @remarks The guest id is a *capability*: whoever holds the uuid holds the basket, the
 * same way a bearer holds its session. That is why this guard only checks shape — a uuid
 * and nothing else — and never asks identity whether the row still exists: the cart is
 * Redis-bound and TTL'd, and a reaped guest's basket is collected by TTL, not by a lookup
 * on every request.
 */
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
// Value import on purpose — see the note in `auth.controller.ts`: a type-only import
// erases the DI token and the service then boots with an undefined reflector.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import { GUEST_ID_HEADER } from '@auth/contracts/http';
import {
  TokenInvalidException,
  ValidationException,
} from '@auth/platform/error-handling';
import { IS_GUEST_ALLOWED } from '../decorators/route-metadata';
import type { GatewayPrincipal } from '../../application/ports/gateway-principal';
import type { GatewayRequest } from '../gateway-request';

@Injectable()
export class GuestIdentityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.isGuestAllowed(context)) return true;

    const request = context.switchToHttp().getRequest<GatewayRequest>();
    if (request.principal) return true;

    const raw = request.headers?.[GUEST_ID_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const guestId = typeof header === 'string' ? header.trim() : '';

    if (guestId.length === 0) {
      throw new TokenInvalidException('a bearer access token or a guest id is required', {
        scheme: `${GUEST_ID_HEADER}: <guestId>`,
      });
    }

    if (!isUUID(guestId)) {
      // Refused before it can become a key: an unvalidated string here would be written
      // into Redis as `session:<whatever arrived>`.
      throw new ValidationException('the guest id is not a uuid', {
        header: GUEST_ID_HEADER,
      });
    }

    request.principal = toGuestPrincipal(guestId);
    return true;
  }

  /** Handler first, then class: the narrower declaration wins. */
  private isGuestAllowed(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_GUEST_ALLOWED, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}

/**
 * The principal an anonymous browser gets.
 *
 * @remarks `userId` is empty on purpose: `resolveCartOwner` in cart keys a cart by
 * `session:` exactly when `userId` is empty, so this shape *is* the rule that puts the
 * basket under the guest id — a second rule at another call site would be a second place
 * for the two to disagree.
 */
function toGuestPrincipal(guestId: string): GatewayPrincipal {
  return {
    userId: '',
    email: '',
    sessionId: guestId,
  };
}
