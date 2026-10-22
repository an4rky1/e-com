/**
 * @fileoverview Enrollment states of a factor.
 *
 * @remarks A string union rather than a TypeScript `enum`: an enum emits runtime code and
 * forces every consumer to import the module just to name a state, while the column is `text`
 * and the wire format is plain text. Adding a state must never be a migration.
 *
 * @remarks The machine is `unverified -> pending -> active -> disabled`, and it is enforced by
 * {@link MfaFactor}, not by the callers. The single rule that matters most: `unverified` and
 * `pending` factors exist in the table but **never** satisfy a verification — otherwise an
 * attacker who can write a factor row (or a user who abandons an enrollment) has a second
 * factor nobody ever confirmed.
 */

/** The states a factor moves through. */
export const MfaStatus = {
  /** Row exists, no secret has been issued yet. */
  UNVERIFIED: 'unverified',
  /** A secret has been issued and is awaiting its first successful code. */
  PENDING: 'pending',
  /** Confirmed by a valid code; the only state that can satisfy verification. */
  ACTIVE: 'active',
  /** Turned off. The secret has been destroyed. */
  DISABLED: 'disabled',
} as const;

export type MfaStatus = (typeof MfaStatus)[keyof typeof MfaStatus];

/**
 * States from which verification may succeed.
 *
 * @remarks A single entry on purpose. `VERIFIABLE_STATUSES` is the one predicate every
 * verification path consults, so widening it is the only edit that could ever let an
 * unconfirmed factor authenticate anybody.
 */
export const VERIFIABLE_STATUSES: ReadonlySet<MfaStatus> = new Set([MfaStatus.ACTIVE]);

/**
 * The legal transitions.
 *
 * @remarks Declared once, as data, so a review can read the whole machine in one place and so
 * a test can assert it without hard-coding a list the same way the production code does.
 * There is deliberately no path back to `active` from `disabled`: re-enrolling creates a new
 * factor, which is what destroys the old secret for good.
 */
export const ENROLLMENT_TRANSITIONS: Readonly<
  Record<MfaStatus, ReadonlySet<MfaStatus>>
> = {
  [MfaStatus.UNVERIFIED]: new Set([MfaStatus.PENDING]),
  [MfaStatus.PENDING]: new Set([MfaStatus.ACTIVE, MfaStatus.UNVERIFIED]),
  [MfaStatus.ACTIVE]: new Set([MfaStatus.DISABLED]),
  [MfaStatus.DISABLED]: new Set([]),
} as const;

export function isMfaStatus(value: unknown): value is MfaStatus {
  return (
    typeof value === 'string' &&
    (Object.values(MfaStatus) as string[]).includes(value)
  );
}

/** Whether `from -> to` is a legal move. */
export function canTransition(from: MfaStatus, to: MfaStatus): boolean {
  return ENROLLMENT_TRANSITIONS[from]?.has(to) ?? false;
}