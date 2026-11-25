/**
 * @fileoverview Who the caller is: identity only, from either of the two writers.
 *
 * @remarks Not a claim the gateway makes. `JwtAuthGuard` fills this in by verifying the bearer
 * against the signing key both this edge and session read from the platform namespace;
 * `GuestIdentityGuard` is the only other writer, and only on `@AllowGuest()` routes where it
 * turns a validated `X-Guest-Id` into a session-only principal. Nothing else may write it,
 * which is what keeps "who is this?" a question with exactly one owner per route. A body
 * field, a query parameter or a decoded-but-unverified token would each be a second
 * authority, and the one somebody forgets is the one that gets believed.
 *
 * @remarks The shape carries identity and nothing else — deliberately no roles or
 * permissions. A bearer's claims are a snapshot taken at mint time and a guest has no claims
 * at all, so both would answer "what could this caller do an hour ago". Anything that must
 * not be a snapshot — live permissions, a session that has since been revoked — is read per
 * request from the service that owns it (`me` reads access-control), never trusted from here.
 *
 * @remarks `userId` is empty on the guest principal, which carries its id in `sessionId`.
 */

export interface GatewayPrincipal {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
}
