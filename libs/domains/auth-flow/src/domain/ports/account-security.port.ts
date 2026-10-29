/**
 * @fileoverview The account-security dependency: "record this sign-in, and is it locked?"
 *
 * @remarks One method rather than the service's full surface. This orchestrator needs exactly
 * one thing from account-security — the lock decision — and a port that exposed `ListDevices`
 * and `RevokeDevice` too would invite the flow handlers to start making device decisions, which
 * is not their job.
 *
 * @remarks The port reports the lock rather than throwing. account-security deliberately refuses
 * nothing: the one thing it cannot see is whether the person on the other end is the account's
 * owner, and a refusal built on a guess is worse than a refusal built on the flow's own outcome.
 */
export const ACCOUNT_SECURITY_PORT = Symbol('ACCOUNT_SECURITY_PORT');

export interface LoginAttemptRecord {
  userId: string | null;
  email: string;
  ipAddress: string;
  userAgent?: string;
  deviceFingerprint?: string;
  succeeded: boolean;
}

export interface AccountLockState {
  locked: boolean;
  /** Epoch millis when the lock lifts, or null when there is none. */
  lockedUntil: number | null;
  retryAfterSeconds: number;
}

export interface AccountSecurityPort {
  recordAttempt(record: LoginAttemptRecord): Promise<AccountLockState>;
}
