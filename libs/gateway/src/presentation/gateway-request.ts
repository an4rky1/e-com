/**
 * @fileoverview The request shape the gateway's guards extend.
 *
 * @remarks `principal` is optional on the type and mandatory by the time a handler runs:
 * `JwtAuthGuard` refuses every route it has not marked `@Public()`, and a handler that reads
 * the principal is one of those. The optionality is an artefact of a guard writing to a
 * framework-owned object, not an invitation to check.
 */
import type { Request } from 'express';
import type { GatewayPrincipal } from '../application/ports/gateway-principal';

export interface GatewayRequest extends Request {
  principal?: GatewayPrincipal;
}

/**
 * The bearer token, or nothing.
 *
 * @remarks Returns `undefined` rather than throwing, so the guard is the only place that
 * decides what a missing credential means. Two call sites each answering that question
 * differently is how a protected route ends up half-open.
 *
 * @remarks Only the `Authorization` header is read. A session cookie would make every
 * mutating route a CSRF problem and would invite treating a refresh token as an access token;
 * neither is a trade this edge should make on behalf of every caller.
 */
export function bearerTokenOf(request: GatewayRequest): string | undefined {
  const header = request.headers?.['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;

  const [scheme, token] = value.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;

  const trimmed = token?.trim();
  return trimmed ? trimmed : undefined;
}
