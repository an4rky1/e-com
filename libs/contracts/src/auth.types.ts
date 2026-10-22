/**
 * @fileoverview The canonical authenticated principal and request context.
 *
 * Why this file is not to be edited casually: every service, every guard and the API
 * gateway all read `User` from here. A service that redefines the shape locally creates a
 * type that is structurally similar but nominally different, and the guard silently stops
 * recognising it. Extend these types, never redefine them.
 */

export interface User {
  id: string;
  email: string;
  roles?: string[];
  permissions?: string[];
  metadata?: Record<string, unknown>;
}

export interface AuthContext {
  user?: User;
  /** Which credential proved the identity — `jwt`, `session`, `api_key`, `internal`. */
  strategy: string;
  authenticated: boolean;
  metadata?: Record<string, unknown>;
}

export interface JwtPayload {
  sub: string;
  email: string;
  roles?: string[];
  permissions?: string[];
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  /** Unique token id — the hook a revocation list checks. */
  jti?: string;
  sid?: string;
  scope?: string[];
}

export const AuthStrategies = {
  JWT: 'jwt',
  SESSION: 'session',
  API_KEY: 'api_key',
  INTERNAL: 'internal',
} as const;

export type AuthStrategy = (typeof AuthStrategies)[keyof typeof AuthStrategies];

/** Response shape for an authenticated session. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Seconds until the access token expires. */
  expiresIn: number;
  sessionId: string;
}