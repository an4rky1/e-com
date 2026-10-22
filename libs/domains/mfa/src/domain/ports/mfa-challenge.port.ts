/**
 * @fileoverview The single question the transport layer may ask about a second factor.
 *
 * @remarks Declared as a port rather than depending on {@link MfaService} directly, because
 * the guard is the piece auth-gateway reuses — and a gateway that imported a command handler
 * would drag the vault, the repositories and a Prisma client into its own module graph. The
 * interface is four lines wide on purpose: "does this code prove possession?" is all a guard
 * can act on.
 */

export const MFA_CHALLENGE = Symbol('MFA_CHALLENGE');

export interface MfaChallengePort {
  /**
   * @returns `true` when `code` proves possession of the user's second factor at this instant.
   *
   * @remarks Never throws for a failed proof — a refusal is an answer. Anything else (a dead
   * database, a corrupt envelope) is allowed to propagate, because a guard that answers
   * `false` to "is the service healthy?" would silently deny every request in the platform.
   */
  verifyOwnership(input: {
    readonly userId: string;
    readonly code: string;
  }): Promise<boolean>;
}