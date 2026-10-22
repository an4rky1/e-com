/**
 * @fileoverview The access token: a compact JWS over the claims the gateway needs.
 *
 * @remarks Why a signed token at all, when the refresh token is verified against a stored
 * digest: nothing in `sessions` can hold an access-token digest, so an access token has to
 * be self-validating. An *unsigned* token carrying the session id would be forgeable — a
 * leaked session id, from a log line or a referrer header, would authenticate as that user.
 * Signing it costs one HMAC per request and removes that whole class of impersonation.
 *
 * Compact JWS (`HS256`) is implemented here rather than pulled from a library: the format is
 * three base64url segments and an HMAC, and a dependency that owns a signing key is a
 * dependency worth one fewer of.
 */
import { Ensure, Result } from '@auth/ddd-core';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Registered header for this implementation. A private claim set must never say `none`. */
const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

export interface AccessTokenClaims {
  /** Subject: the user id. */
  readonly sub: string;
  /** Session id — the key that revocation is looked up by. */
  readonly sid: string;
  readonly email: string;
  /** Token family, so a consumer can correlate a request with a rotation chain. */
  readonly fam: string;
  readonly roles: readonly string[];
  readonly perms: readonly string[];
  /** Issued-at, seconds since the epoch. */
  readonly iat: number;
  /** Expiry, seconds since the epoch. */
  readonly exp: number;
}

/** Why a token could not be trusted. Never carries any part of the token itself. */
export const AccessTokenFailure = {
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad_signature',
} as const;

export type AccessTokenFailure =
  (typeof AccessTokenFailure)[keyof typeof AccessTokenFailure];

export interface AccessTokenIssueInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly tokenFamilyId: string;
  readonly email: string;
  readonly roles?: readonly string[];
  readonly permissions?: readonly string[];
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Signing and verification.
 *
 * @remarks Every method takes the key as an argument rather than reading configuration, so
 * the domain has no ambient state and the codec is testable with a fixed key.
 */
export const AccessTokenCodec = {
  /** Builds `<header>.<claims>.<signature>`, all base64url. */
  sign(input: AccessTokenIssueInput, key: string): string {
    Ensure.notEmpty(key, 'access token signing key');

    const claims: AccessTokenClaims = {
      sub: input.userId,
      sid: input.sessionId,
      email: input.email,
      fam: input.tokenFamilyId,
      roles: input.roles ?? [],
      perms: input.permissions ?? [],
      iat: Math.floor(input.issuedAt.getTime() / 1_000),
      exp: Math.floor(input.expiresAt.getTime() / 1_000),
    };

    const signingInput = `${encodeSegment(HEADER)}.${encodeSegment(claims)}`;
    return `${signingInput}.${sign(signingInput, key)}`;
  },

  /**
   * Checks shape and signature only.
   *
   * @remarks Expiry is *not* checked here: "cryptographically genuine" and "still usable"
   * are different questions, and the answer to the second one also depends on whether the
   * session has since been revoked — which only the session row knows.
   */
  verify(
    token: string,
    key: string,
  ): Result<AccessTokenClaims, AccessTokenFailure> {
    if (typeof token !== 'string' || token.length === 0 || !key) {
      return Result.fail(AccessTokenFailure.MALFORMED);
    }

    const segments = token.split('.');
    if (segments.length !== 3) {
      return Result.fail(AccessTokenFailure.MALFORMED);
    }

    // The header segment is deliberately not trusted or reused: it is re-encoded from the
    // algorithm this service issues, so a token claiming anything else cannot reach the
    // signature check with a caller-chosen expected value.
    const [, payload, signature] = segments as [string, string, string];
    const claims = parseClaims(decodeSegment(payload));
    if (!claims) {
      return Result.fail(AccessTokenFailure.MALFORMED);
    }

    const expected = sign(`${encodeSegment(HEADER)}.${payload}`, key);
    if (!equalsConstantTime(expected, signature)) {
      return Result.fail(AccessTokenFailure.BAD_SIGNATURE);
    }

    return Result.ok(claims);
  },

  /** Expiry as a policy question, kept out of {@link verify} for the reason above. */
  isExpired(claims: AccessTokenClaims, now: Date): boolean {
    return claims.exp <= Math.floor(now.getTime() / 1_000);
  },

  /** Seconds remaining, floored at zero — what `expires_in` on the wire reports. */
  secondsUntilExpiry(claims: AccessTokenClaims, now: Date): number {
    return Math.max(0, claims.exp - Math.floor(now.getTime() / 1_000));
  },
};

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function sign(signingInput: string, key: string): string {
  return createHmac('sha256', key).update(signingInput, 'utf8').digest('base64url');
}

function equalsConstantTime(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Narrows an untrusted decoded segment into claims.
 *
 * @remarks Every field is checked: the payload came off the wire, and a claim that is
 * missing or of the wrong type must fail closed rather than flow into a handler as `undefined`.
 */
function parseClaims(value: unknown): AccessTokenClaims | null {
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sub !== 'string' ||
    typeof candidate.sid !== 'string' ||
    typeof candidate.email !== 'string' ||
    typeof candidate.fam !== 'string' ||
    typeof candidate.iat !== 'number' ||
    typeof candidate.exp !== 'number' ||
    !Array.isArray(candidate.roles) ||
    !Array.isArray(candidate.perms)
  ) {
    return null;
  }

  const roles = candidate.roles.filter(isString);
  const permissions = candidate.perms.filter(isString);
  if (roles.length !== candidate.roles.length || permissions.length !== candidate.perms.length) {
    return null;
  }

  return {
    sub: candidate.sub,
    sid: candidate.sid,
    email: candidate.email,
    fam: candidate.fam,
    roles,
    perms: permissions,
    iat: candidate.iat,
    exp: candidate.exp,
  };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}