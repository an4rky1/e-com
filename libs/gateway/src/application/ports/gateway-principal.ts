/**
 * @fileoverview Who the caller is, once the token has said so.
 *
 * @remarks Not a claim the gateway makes. `JwtAuthGuard` fills this in by verifying the bearer
 * against the signing key both this edge and session read from the platform namespace,
 * and nothing else may write it, which is what keeps "who is this?" a question with exactly
 * one owner. A body field, a query parameter or a decoded-but-unverified token would each be
 * a second authority, and the one somebody forgets is the one that gets believed.
 *
 * @remarks Verification is local, so the principal says what the *token* asserts. Anything
 * that must not be a snapshot — live permissions, a session that has since been revoked — is
 * read per request from the service that owns it (`me` reads access-control), never trusted
 * from here.
 */

export interface GatewayPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
  /** What session saw at mint time. A snapshot, not an authorisation decision. */
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}
