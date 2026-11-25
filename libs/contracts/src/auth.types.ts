/**
 * @fileoverview The token pair every transport hands a caller, and the strategies that name
 * how one was minted.
 *
 * @remarks Small on purpose. The shapes that used to sit beside them here (`User`,
 * `AuthContext`, `JwtPayload`) were read by nothing: each service derives its caller from
 * the transport that carries it — the gateway from the verified bearer, a gRPC handler from
 * its own metadata — and a second "canonical" copy of that shape would be one nobody keeps
 * honest. The composed answer a page actually reads is `Principal`, in `http/api.ts`.
 */

export const AuthStrategies = {
  JWT: 'jwt',
  SESSION: 'session',
  API_KEY: 'api_key',
  INTERNAL: 'internal',
} as const;

export type AuthStrategy = (typeof AuthStrategies)[keyof typeof AuthStrategies];

/** The only token scheme the platform issues, as spelled on the wire. */
export const TOKEN_TYPE_BEARER = 'Bearer';

/** Response shape for an authenticated session. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: typeof TOKEN_TYPE_BEARER;
  /** Seconds until the access token expires. */
  expiresIn: number;
  sessionId: string;
}
