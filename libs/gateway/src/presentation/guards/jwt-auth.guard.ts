/**
 * @fileoverview Turns a bearer token into a principal, or refuses the request.
 *
 * @remarks **Named `JwtAuthGuard` because it is one.** The edge verifies the token's shape,
 * signature and `exp` locally — one HMAC against `SESSION_ACCESS_TOKEN_SIGNING_KEY`, the same
 * variable the session service signs with, resolved into the config at boot. No peer call, no
 * lookup, no round trip: the answer to "is this bearer genuine" is computed from the string
 * in the header and nothing else, which is what keeps the edge stateless under load.
 *
 * @remarks What local verification cannot answer is whether the *session* behind the token
 * was revoked after the token was minted. Logout revokes the session row, so the next refresh
 * fails, but a bearer already in the wild keeps working until its `exp` (15 minutes). That is
 * the deliberate price of an edge that answers every request without asking anyone — short
 * blast radius instead of instant revocation.
 *
 * @remarks Deny by default. `@Public()` is an opt-*out*, which is why `POST /auth/login` needs
 * it stated explicitly: without that decorator the route is unreachable, and the failure is a
 * 401 rather than a boot error, so the decorator is load-bearing and belongs in the code.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
// Value import on purpose — see the note in `auth.controller.ts`: a type-only import
 // erases the DI token and the service then boots with an undefined facade.
 // eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from '@nestjs/core';
import { TokenExpiredException, TokenInvalidException } from '@auth/platform/error-handling';
import { AccessTokenCodec, type AccessTokenClaims } from '@auth/contracts';
import { GATEWAY_CONFIG, type GatewayTokenTrust } from '../../gateway.config';
import type { GatewayPrincipal } from '../../application/ports/gateway-principal';
import { IS_PUBLIC_ROUTE, IS_GUEST_ALLOWED } from '../decorators/route-metadata';
import { type GatewayRequest, bearerTokenOf } from '../gateway-request';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    // Value import: constructor-injected, and `emitDecoratorMetadata` reads the value
    // binding. A type-only import emits `Object` and every request arrives with an undefined
    // reflector.
    private readonly reflector: Reflector,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayTokenTrust,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.isPublic(context);
    const allowsGuest = this.isGuestAllowed(context);

    // A plain public route: no identity required, none parsed — login must not start
    // failing because a caller happened to send a stale bearer along with it.
    if (isPublic && !allowsGuest) return true;

    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const accessToken = bearerTokenOf(request);
    if (!accessToken) {
      // A guest-allowed route has no token *yet*: `GuestIdentityGuard`, which runs next,
      // either supplies the guest id from `X-Guest-Id` or refuses the request.
      if (allowsGuest) return true;

      throw new TokenInvalidException('a bearer access token is required', {
        scheme: 'Authorization: Bearer <accessToken>',
      });
    }

    // Signature first: a token that is not ours never gets to argue about its clock.
    // This runs on guest-allowed routes too: a presented credential is verified or
    // refused — never quietly downgraded to "anonymous".
    const verified = AccessTokenCodec.verify(accessToken, this.config.accessTokenSigningKey);
    if (verified.isFailure) {
      throw new TokenInvalidException('the access token is not valid', {
        // The reason names *why* it failed and is written by the codec that failed it.
        // Never the token, which would put the rejected credential in the log line.
        reason: verified.error,
      });
    }

    const claims = verified.unwrapOrThrow();
    const nowSec = Math.floor(Date.now() / 1_000);
    if (claims.exp + this.config.clockSkewSec <= nowSec) {
      throw new TokenExpiredException('the access token has expired', {
        reason: 'token_expired',
        // `iat`/`exp` are numbers off the wire, not secrets: they say how long ago the
        // issuer minted it, which is the one debugging detail a 401 otherwise hides.
        issuedAt: claims.iat,
        expiresAt: claims.exp,
      });
    }

    request.principal = toPrincipal(claims);
    return true;
  }

  /** Handler first, then class: the narrower declaration wins. */
  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  private isGuestAllowed(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_GUEST_ALLOWED, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}

function toPrincipal(claims: AccessTokenClaims): GatewayPrincipal {
  return {
    userId: claims.sub,
    email: claims.email,
    sessionId: claims.sid,
  };
}
