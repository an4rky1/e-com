/**
 * @fileoverview Is this the right secret?
 *
 * @remarks The gateway never sees a hash, a salt or an algorithm. It hands the presented
 * secret to the service that owns credential storage and gets back a verdict — which is the
 * only reason the two databases can stay separate.
 */

export interface PasswordVerification {
  /** Whether the secret matched. The *only* thing the gateway is allowed to branch on. */
  readonly valid: boolean;
  /**
   * Failed attempts recorded by the vault.
   *
   * @remarks Informational. Lockout is the vault's decision to publish on the credential topic,
   * not something this service gets to recompute from a number handed back in a reply.
   */
  readonly failedAttempts: number;
}

export const CREDENTIAL_PORT = Symbol('CREDENTIAL_PORT');

export interface CredentialPort {
  /**
   * @param password - The plaintext the user just typed. Never stored, never logged, never
   * put in an event payload.
   */
  verifyPassword(input: {
    readonly userId: string;
    readonly password: string;
  }): Promise<PasswordVerification>;
}