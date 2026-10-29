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

/**
 * The caller's address, as this edge reads it everywhere it needs one: the first
 * `X-Forwarded-For` entry when a proxy supplied it, the socket's address otherwise.
 *
 * @remarks One function rather than three copies because idempotency's key scope and the
 * address peers record must agree: a scope derived differently from what `@ClientIp()`
 * reports would put two identities on one request, and the mismatch would only ever show
 * up as a record that failed to match its retry.
 */
export function clientIpOf(request: GatewayRequest): string | undefined {
  const forwarded = request.headers?.['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof value === 'string' && value.length > 0) return value.split(',')[0]?.trim();
  return request.socket?.remoteAddress ?? undefined;
}
