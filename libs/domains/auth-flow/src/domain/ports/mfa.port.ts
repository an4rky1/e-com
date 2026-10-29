/**
 * @fileoverview Does this person hold a second factor, and have they just proved it?
 *
 * @remarks Both questions belong to mfa. The gateway only learns *that* a factor is
 * outstanding — which is the difference between `awaiting_2fa` and `awaiting_step_up` in its
 * state machine — and never learns a secret, a seed or which factor was used.
 *
 * @remarks A refusal is a value here, not an exception. The gateway must be able to keep a
 * flow alive while a person types a six-digit code, and an exception per wrong code would make
 * "wrong code" indistinguishable from "the mfa service is down" unless every caller learned to
 * catch it.
 */

export const MFA_PORT = Symbol('MFA_PORT');

export interface FactorVerification {
  readonly verified: boolean;
  /** Set on success only. Never set on a refusal: a refusal must not describe the factor. */
  readonly method?: 'totp' | 'backup_code';
}

export interface MfaPort {
  /** Whether this account has any usable factor enrolled. */
  isEnabled(input: { readonly userId: string }): Promise<boolean>;

  /**
   * @param code - An OTP or a backup code, exactly as presented.
   */
  verifyFactor(input: {
    readonly userId: string;
    readonly code: string;
    /** Optional hint: which factor the caller meant. Ignored when absent. */
    readonly factorId?: string;
  }): Promise<FactorVerification>;
}