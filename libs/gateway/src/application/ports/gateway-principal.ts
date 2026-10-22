/**
 * @fileoverview Who the caller is, once one service has said so.
 *
 * @remarks Not a claim the gateway makes. `JwtAuthGuard` fills this in from session-token's
 * `ValidateAccessToken` answer and nothing else may write it, which is what keeps "who is
 * this?" a question with exactly one owner. A body field, a query parameter or a decoded
 * token would each be a second authority, and the one somebody forgets is the one that gets
 * believed.
 */

export interface GatewayPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
  /** What session-token saw at mint time. A snapshot, not an authorisation decision. */
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}
