/**
 * @fileoverview Turns a bearer token into a principal, or refuses the request.
 *
 * @remarks **Named `JwtAuthGuard` for the shape of what it accepts; it never touches a JWT.**
 * There is no signing key in this service's environment and no `jsonwebtoken` in its import
 * graph. session-token minted the token and session-token decides whether it is still valid,
 * so the gateway forwards the string and accepts the answer. A local verifier would be a
 * second opinion on a question one service already owns, and the two would disagree the day
 * a key rotates.
 *
 * @remarks Deny by default. `@Public()` is an opt-*out*, which is why `POST /auth/login` needs
 * it stated explicitly: without that decorator the route is unreachable, and the failure is
 * a 401 rather than a boot error, so the decorator is load-bearing and belongs in the code.
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
import { TokenInvalidException } from '@auth/platform/error-handling';
import {
  SESSION_CLIENT,
  type SessionClientPort,
} from '../../application/ports/peer-clients.port';
import type { GatewayPrincipal } from '../../application/ports/gateway-principal';
import { IS_PUBLIC_ROUTE } from '../decorators/route-metadata';
import { type GatewayRequest, bearerTokenOf } from '../gateway-request';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    // Value import: constructor-injected, and `emitDecoratorMetadata` reads the value
    // binding. A type-only import emits `Object` and every request arrives with an undefined
    // reflector.
    private readonly reflector: Reflector,
    @Inject(SESSION_CLIENT) private readonly sessions: SessionClientPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;

    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const accessToken = bearerTokenOf(request);
    if (!accessToken) {
      throw new TokenInvalidException('a bearer access token is required', {
        scheme: 'Authorization: Bearer <accessToken>',
      });
    }

    // The peer call carries its own deadline and maps its own failures, so a gRPC error can
    // never reach this method and escape as a raw object.
    const validation = await this.sessions.validateAccessToken(accessToken);

    // `valid: false` is an answer, not a failure: a stale browser tab holding a revoked token
    // is ordinary traffic, and session-token says so with a field rather than an exception.
    if (!validation.valid) {
      throw new TokenInvalidException('the access token is not valid', {
        // The reason names *why* it stopped working, and is written by the service that knows.
        // Never the token, which would put the rejected credential in the log line.
        reason: validation.revocationReason || 'rejected by the session engine',
      });
    }

    request.principal = toPrincipal(validation);
    return true;
  }

  /** Class first, then handler: the narrower declaration wins. */
  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}

function toPrincipal(validation: {
  userId: string;
  email: string;
  sessionId: string;
  roles: readonly string[];
  permissions: readonly string[];
}): GatewayPrincipal {
  return {
    userId: validation.userId,
    email: validation.email,
    sessionId: validation.sessionId,
    roles: [...validation.roles],
    permissions: [...validation.permissions],
  };
}
