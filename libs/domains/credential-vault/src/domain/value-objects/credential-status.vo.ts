/**
 * @fileoverview Credential lifecycle states.
 *
 * @remarks A string union rather than a TypeScript `enum`: the enum emits runtime code and
 * forces consumers to import the module, and the wire format is plain text. The database
 * column is `text` for the same reason — adding a state must not be a migration.
 *
 * @remarks There is no `expired` state. A credential does not expire on a schedule; it is
 * replaced (`active`), rate-limited out of use (`locked`) or retired (`revoked`), and a
 * sweeper that had to keep up with every lock expiry would be a dependency this service does
 * not need.
 */

export const CredentialStatus = {
  ACTIVE: 'active',
  LOCKED: 'locked',
  REVOKED: 'revoked',
} as const;

export type CredentialStatus = (typeof CredentialStatus)[keyof typeof CredentialStatus];

/** States a password may still be verified against. */
export const VERIFIABLE_STATUSES: ReadonlySet<CredentialStatus> = new Set([
  CredentialStatus.ACTIVE,
]);

/** States a credential can never leave. */
export const TERMINAL_STATUSES: ReadonlySet<CredentialStatus> = new Set([
  CredentialStatus.REVOKED,
]);

export function isCredentialStatus(value: unknown): value is CredentialStatus {
  return (
    typeof value === 'string' &&
    (Object.values(CredentialStatus) as string[]).includes(value)
  );
}

/**
 * The verification method a credential row records.
 *
 * @remarks Declared here because `credentials.method` is a free-text column and nothing at
 * the type level would otherwise stop a TOTP secret being written into a row this service
 * treats as a password. Only `password` is minted here; the other factors are owned by the
 * mfa and api-key services.
 */
export const CredentialMethod = {
  PASSWORD: 'password',
  RECOVERY_CODE: 'recovery_code',
  TOTP: 'totp',
  WEBAUTHN: 'webauthn',
  API_KEY: 'api_key',
} as const;

export type CredentialMethod = (typeof CredentialMethod)[keyof typeof CredentialMethod];