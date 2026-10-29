/**
 * @fileoverview Authenticates machine credentials on a route.
 *
 * @remarks Reused verbatim by api-gateway, for the same reason `MfaGuard` is: two copies of a
 * security guard are two implementations that will eventually disagree about what "protected"
 * means, and the one that disagrees in the lenient direction is the one that ships.
 *
 * @remarks The credential is read from `X-API-Key`, or from `Authorization: Bearer <key>` for
 * the SDKs that already have a bearer slot. It is never read from a query string: a URL ends up
 * in access logs, proxies and browser history, and a credential that has been logged is a
 * credential that has to be rotated.
 *
 * @remarks The guard authenticates *machines*. It never reads a user id off a session, a JWT or
 * a cookie — that is auth-flow's question, and this one has no opinion about who a human is.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InvalidCredentialsException,
  PermissionDeniedException,
} from '@auth/platform/error-handling';
import {
  API_KEY_VERIFIER,
  INVALID_API_KEY_MESSAGE,
  type ApiKeyVerifier,
  type AuthenticatedApiKey,
} from '../../application/authentication/api-key-authentication.service';
import { satisfiesScopes, type ApiKeyScope } from '../../domain/value-objects/api-key-scope.vo';
import { REQUIRED_SCOPES } from '../decorators/require-scopes.decorator';

/** The request property the resolved key is attached to. */
export const API_KEY_PRINCIPAL_PROPERTY = 'apiKey' as const;

/** What this guard adds to the request. Every field is non-secret. */
export interface ApiKeyPrincipal extends AuthenticatedApiKey {
  readonly lastUsedAt?: Date;
}

/**
 * The request as the guard leaves it.
 *
 * @remarks An intersection rather than a redeclaration of Express's request: api-gateway
 * imports this type through an HTTP boundary, and a structural view of what the guard adds is
 * the part that can be relied on.
 */
export type ApiKeyAuthenticatedRequest = Record<string, unknown> & {
  apiKey?: ApiKeyPrincipal;
};

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    // An explicit token, because a type-only import is erased before the decorator metadata
    // is emitted and the container would then have `Object` to resolve against.
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_KEY_VERIFIER) private readonly verifier: ApiKeyVerifier,
  ) {}

  /**
   * @returns `true`, with `request.apiKey` set to the resolved key and its scopes.
   * @throws {InvalidCredentialsException} when no live key is presented.
   * @throws {PermissionDeniedException} when the key is live but lacks a required scope.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestOf(context);
    const presented = presentedKeyOf(request);

    if (!presented) {
      // Same message as a wrong key: a guard that says "no credential" and a guard that says
      // "wrong credential" tell an attacker which half of the pair to work on.
      throw new InvalidCredentialsException(INVALID_API_KEY_MESSAGE, {});
    }

    const principal = await this.verifier.authenticate(presented);
    const required = this.requiredScopes(context);

    if (required.length > 0 && !satisfiesScopes(principal.scopes, required)) {
      // Deliberately *not* the credential error: the caller has proved who it is, and the only
      // thing wrong is the authority. Collapsing the two would make an insufficient-scope
      // integration impossible to debug from the outside.
      throw new PermissionDeniedException('api key lacks the required scope', { required });
    }

    request[API_KEY_PRINCIPAL_PROPERTY] = principal;
    return true;
  }

  private requiredScopes(context: ExecutionContext): readonly ApiKeyScope[] {
    return (
      this.reflector.getAllAndOverride<ApiKeyScope[] | undefined>(REQUIRED_SCOPES, [
        context.getHandler(),
        context.getClass(),
      ]) ?? []
    );
  }
}

/** The resolved key, if this guard ran. Null rather than a throw: callers ask, they do not assert. */
export const apiKeyPrincipalOf = (request: unknown): ApiKeyPrincipal | null => {
  const record = request as ApiKeyAuthenticatedRequest | null;
  return record && typeof record === 'object' ? (record.apiKey ?? null) : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const requestOf = (context: ExecutionContext): ApiKeyAuthenticatedRequest => {
  const request: unknown = context.switchToHttp().getRequest();
  return isRecord(request) ? (request as ApiKeyAuthenticatedRequest) : {};
};

/**
 * Reads the credential from the header, then from a bearer token.
 *
 * @remarks Both spellings of the header name are accepted: Node lower-cases `headers`, but a
 * guard is also used in front of frameworks and tests that hand it a plain object, and a
 * credential that works in one and not the other is a support ticket nobody can reproduce.
 */
const presentedKeyOf = (request: ApiKeyAuthenticatedRequest): string | null => {
  const headers = isRecord(request.headers) ? request.headers : {};

  const header = headers['x-api-key'] ?? headers['X-API-Key'] ?? headers['X-API-KEY'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }

  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization === 'string') {
    // `Bearer <key>`. Case-insensitive on the scheme, because every SDK capitalises it
    // differently and none of them is wrong.
    const bearer = /^bearer\s+(.+)$/i.exec(authorization.trim());
    const token = bearer?.[1]?.trim();
    if (token) return token;
  }

  return null;
};