/**
 * @fileoverview Mint and renew the credentials a completed flow is worth.
 *
 * @remarks Tokens belong to session-token. The gateway holds them for exactly as long as it
 * takes to put them in a response, and never writes one anywhere — not to the database, not to
 * an event, not to a log.
 *
 * @remarks This is also why a step-up flow is not allowed to call {@link issueTokens}: the
 * caller of a step-up already holds a session, and minting a second one on every sensitive
 * action would turn one stolen access token into an unbounded supply of them.
 */

export interface IssuedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly sessionId: string;
  readonly expiresIn: number;
}

export interface RotatedTokens extends IssuedTokens {
  /** True when a refresh token was presented twice and the family was revoked. */
  readonly reuseDetected: boolean;
}

export const SESSION_PORT = Symbol('SESSION_PORT');

export interface SessionPort {
  issueTokens(input: {
    readonly userId: string;
    readonly email: string;
    readonly deviceId?: string | null;
    readonly ipAddress?: string | null;
  }): Promise<IssuedTokens>;

  rotateTokens(input: {
    readonly refreshToken: string;
    readonly deviceId?: string | null;
    readonly ipAddress?: string | null;
  }): Promise<RotatedTokens>;
}