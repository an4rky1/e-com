/**
 * @fileoverview Injects the principal a guard already established.
 *
 * @remarks A handler never reads `request.principal` by hand. Going through a parameter
 * decorator makes the dependency part of the method's signature, so removing the guard above
 * it is a compile error rather than an `undefined` at runtime.
 */
import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { GatewayPrincipal } from '../../application/ports/gateway-principal';
import { TokenInvalidException } from '@auth/platform/error-handling';
import type { GatewayRequest } from '../gateway-request';

/**
 * The authenticated caller.
 *
 * @remarks Throws rather than returning `undefined` when there is no principal: a handler
 * that needs one has been mounted without the guard, and answering `null` would let it ship.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): GatewayPrincipal => {
    const request = context.switchToHttp().getRequest<GatewayRequest>();
    if (!request.principal) {
      throw new TokenInvalidException('no authenticated principal on this request', {
        hint: 'a route reading the principal must sit behind JwtAuthGuard',
      });
    }
    return request.principal;
  },
);

/** The caller's address, for the peers that record it. Never a header we were told to trust. */
export const ClientIp = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const forwarded = request.headers?.['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof value === 'string' && value.length > 0) return value.split(',')[0]?.trim();
    return request.socket?.remoteAddress ?? undefined;
  },
);

/** The caller's user agent, forwarded verbatim for the flows that record it. */
export const ClientUserAgent = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<GatewayRequest>();
    const header = request.headers?.['user-agent'];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' ? value : undefined;
  },
);
