/**
 * @fileoverview The second factor itself: one authenticator enrolment for one user.
 *
 * @remarks mfa owns exactly one question — *does the caller hold something a stolen password
 * does not?* — and the aggregate is built around that question. Every method here either
 * enrols a secret, checks a proof against one, or destroys the secret. Nothing here decides
 * whether MFA should be demanded of a given request; that is auth-gateway's judgement, made
 * with the risk context this service is not given.
 *
 * @remarks The state machine is the heart of it. A factor is `unverified` before a secret
 * exists, `pending` once one has been issued but not proven, `active` only after a code
 * matched it, and `disabled` once the secret has been destroyed. `canSatisfyVerification()`
 * reads {@link VERIFIABLE_STATUSES}, so an abandoned enrollment cannot become a second factor —
 * which matters because enrollment issues a secret that the *client* holds long before anyone
 * has proved they can compute codes from it.
 *
 * @remarks `mfa_factors` has a check constraint and a sibling `totp_used_counters` row keyed
 * by the factor. That row is treated as aggregate state, not as a side table: the replay rule
 * is an invariant of *this* factor, so a code of verification that could load the factor
 * without its counter would be a hole straight through the middle of it.
 */

import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/core';
import { MfaDomainError, MfaErrorReason } from './errors/mfa-domain.error';
import type { MfaPolicy } from './mfa-policy';
import {
  MfaMethod as Method,
  TOTP_CODE_PATTERN,
  type MfaMethod,
} from './value-objects/mfa-method.vo';
import {
  MfaStatus,
  VERIFIABLE_STATUSES,
  canTransition,
} from './value-objects/mfa-status.vo';
import type { TotpEnginePort, TotpMatch } from './ports/totp.port';

/** Aggregate/event identity — the prefix that scopes every factor event. */
export const MFA_FACTOR_AGGREGATE = 'MfaFactor';

export interface MfaFactorProps {
  userId: string;
  method: MfaMethod;
  status: MfaStatus;
  accountLabel: string | null;
  destinationHint: string | null;
  /** AES-256-GCM envelope. Never plaintext — see {@link TotpSecret}. */
  secretCiphertext: string | null;
  /** Optional pepper/verifier over the secret, for operators who want a second check. */
  secretHash: string | null;
  /** Kind of the secret awaiting confirmation: `totp`. */
  pendingSecretKind: string | null;
  /** Envelope of the candidate secret. Promoted to `secretCiphertext` on confirmation. */
  pendingSecretValue: string | null;
  pendingSecretExpiresAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  activatedAt: Date | null;
  lastVerifiedAt: Date | null;
  version: number;
  /** Highest TOTP step already spent. `null` until the first successful verification. */
  lastUsedCounter: bigint | null;
}

/** The shape a persisted row has, including the 1:1 counter row. */
export interface MfaFactorRow {
  id: string;
  user_id: string;
  method: string;
  status: string;
  account_label: string | null;
  destination_hint: string | null;
  secret_ciphertext: string | null;
  secret_hash: string | null;
  pending_secret_kind: string | null;
  pending_secret_value: string | null;
  pending_secret_expires_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
  activated_at: Date | null;
  last_verified_at: Date | null;
  version: number;
  totp_used_counters?: { last_counter: bigint } | null;
}

// ---- events ----------------------------------------------------------------------

export class MfaEnrollmentStarted extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; method: MfaMethod },
    version = 1,
  ) {
    super(aggregateId, MFA_FACTOR_AGGREGATE, 'mfa.enrollment_started', version);
  }
}

export class MfaEnrolled extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; method: MfaMethod },
    version = 1,
  ) {
    super(aggregateId, MFA_FACTOR_AGGREGATE, 'mfa.enrolled', version);
  }
}

export class MfaVerified extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; method: MfaMethod },
    version = 1,
  ) {
    super(aggregateId, MFA_FACTOR_AGGREGATE, 'mfa.verified', version);
  }
}

export class MfaVerificationFailed extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      userId: string;
      method: MfaMethod;
      reason: string;
      failedAttempts: number;
      lockedUntil: string | null;
    },
    version = 1,
  ) {
    super(aggregateId, MFA_FACTOR_AGGREGATE, 'mfa.failed', version);
  }
}

export class MfaDisabled extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; method: MfaMethod },
    version = 1,
  ) {
    super(aggregateId, MFA_FACTOR_AGGREGATE, 'mfa.disabled', version);
  }
}

// ---- aggregate -------------------------------------------------------------------

export class MfaFactor extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: MfaFactorProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * Starts an enrollment by issuing the candidate secret.
   *
   * @remarks The factor is created `unverified` and immediately moved to `pending`, which is
   * the only legal move out of `unverified`. The secret is handed over already encrypted: this
   * method is the boundary where a plaintext secret exists in memory, and the aggregate never
   * holds one.
   *
   * @remarks Two events' worth of change, one version. Enrolling is a single user-visible act,
   * so numbering it twice would imply a state that was externally observable.
   */
  static beginEnrollment(input: {
    userId: string;
    method?: MfaMethod;
    secretCiphertext: string;
    enrollmentTtlMs: number;
    accountLabel?: string | null;
    destinationHint?: string | null;
    now?: Date;
    id?: string;
  }): MfaFactor {
    Ensure.notEmpty(input.userId, 'userId');
    Ensure.notEmpty(input.secretCiphertext, 'secretCiphertext');
    Ensure.positive(input.enrollmentTtlMs, 'enrollmentTtlMs');

    const now = input.now ?? new Date();
    const method = input.method ?? Method.TOTP;
    const factor = new MfaFactor(
      input.id ?? crypto.randomUUID(),
      {
        userId: input.userId,
        method,
        status: MfaStatus.UNVERIFIED,
        accountLabel: input.accountLabel ?? null,
        destinationHint: input.destinationHint ?? null,
        secretCiphertext: null,
        secretHash: null,
        pendingSecretKind: method,
        pendingSecretValue: input.secretCiphertext,
        pendingSecretExpiresAt: new Date(now.getTime() + input.enrollmentTtlMs),
        failedAttempts: 0,
        lockedUntil: null,
        activatedAt: null,
        lastVerifiedAt: null,
        version: 0,
        lastUsedCounter: null,
      },
      now,
      now,
    );

    factor.issuePendingSecret(now);
    return factor;
  }

  /** Rehydration from persistence. Emits nothing — the write already happened. */
  static fromRow(row: MfaFactorRow): MfaFactor {
    return new MfaFactor(
      row.id,
      {
        userId: row.user_id,
        method: row.method as MfaMethod,
        status: row.status as MfaStatus,
        accountLabel: row.account_label,
        destinationHint: row.destination_hint,
        secretCiphertext: row.secret_ciphertext,
        secretHash: row.secret_hash,
        pendingSecretKind: row.pending_secret_kind,
        pendingSecretValue: row.pending_secret_value,
        pendingSecretExpiresAt: row.pending_secret_expires_at,
        failedAttempts: row.failed_attempts,
        lockedUntil: row.locked_until,
        activatedAt: row.activated_at,
        lastVerifiedAt: row.last_verified_at,
        version: row.version,
        lastUsedCounter: row.totp_used_counters?.last_counter ?? null,
      },
      row.created_at,
      row.updated_at,
    );
  }

  // ---- reads ---------------------------------------------------------------------

  get userId(): string {
    return this.props.userId;
  }

  get method(): MfaMethod {
    return this.props.method;
  }

  get status(): MfaStatus {
    return this.props.status;
  }

  get accountLabel(): string | null {
    return this.props.accountLabel;
  }

  get destinationHint(): string | null {
    return this.props.destinationHint;
  }

  /** The confirmed secret's envelope. `null` while pending and after being disabled. */
  get secretCiphertext(): string | null {
    return this.props.secretCiphertext;
  }

  get pendingSecretValue(): string | null {
    return this.props.pendingSecretValue;
  }

  /** Which kind of secret is awaiting confirmation: `totp`, or `null` when none is. */
  get pendingSecretKind(): string | null {
    return this.props.pendingSecretKind;
  }

  get pendingSecretExpiresAt(): Date | null {
    return this.props.pendingSecretExpiresAt;
  }

  get activatedAt(): Date | null {
    return this.props.activatedAt;
  }

  get lastVerifiedAt(): Date | null {
    return this.props.lastVerifiedAt;
  }

  get failedAttempts(): number {
    return this.props.failedAttempts;
  }

  get lockedUntil(): Date | null {
    return this.props.lockedUntil;
  }

  get lastUsedCounter(): bigint | null {
    return this.props.lastUsedCounter;
  }

  get factorVersion(): number {
    return this.props.version;
  }

  /** The one predicate every verification path consults. */
  get canSatisfyVerification(): boolean {
    return VERIFIABLE_STATUSES.has(this.props.status);
  }

  isLocked(now: Date): boolean {
    return (
      this.props.lockedUntil !== null && this.props.lockedUntil.getTime() > now.getTime()
    );
  }

  // ---- transitions --------------------------------------------------------------

  /** `unverified -> pending`. */
  private issuePendingSecret(now: Date): void {
    this.transition(MfaStatus.PENDING, now);
    this.addDomainEvent(
      new MfaEnrollmentStarted(this.id, {
        userId: this.props.userId,
        method: this.props.method,
      }, this.props.version),
    );
  }

  /**
   * Confirms the enrolment: the first successful code promotes `pending -> active`.
   *
   * @remarks `secret` is the plaintext recovered from `pendingSecretValue` by the handler. The
   * aggregate deliberately never sees the stored form, so "which secret was verified" cannot
   * be answered by reading the aggregate.
   *
   * @remarks The confirmation spends the step it matched, exactly as {@link verifyTotp} does.
   * RFC 6238 reissues the same six digits for the next 90 seconds, so a code an observer read
   * off the confirmation screen would otherwise still be a working credential afterwards. One
   * step authorising one transition is the whole invariant; there is no second, weaker version
   * of it for the enrollment path.
   *
   * @remarks Throws without mutating on any refusal. A rejected confirmation must not leave a
   * half-applied promotion behind, and the attempt is recorded separately so that it survives
   * the rollback of the transaction the refusal unwound.
   */
  confirmEnrollment(input: {
    readonly code: string;
    readonly secret: string;
    readonly now: Date;
    readonly totp: TotpEnginePort;
    readonly policy: MfaPolicy;
  }): void {
    const { now } = input;

    if (this.props.status !== MfaStatus.PENDING) {
      throw new MfaDomainError(
        MfaErrorReason.FACTOR_NOT_ACTIVE,
        'this factor is not awaiting confirmation',
        { factorId: this.id, status: this.props.status },
      );
    }

    const expiresAt = this.props.pendingSecretExpiresAt;
    if (expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
      throw new MfaDomainError(
        MfaErrorReason.ENROLLMENT_EXPIRED,
        'the enrollment window has closed; start again',
        { factorId: this.id, expiresAt: expiresAt.toISOString() },
      );
    }

    const pendingSecret = this.props.pendingSecretValue;
    if (pendingSecret === null) {
      throw new MfaDomainError(
        MfaErrorReason.FACTOR_NOT_ACTIVE,
        'this factor has no secret awaiting confirmation',
        { factorId: this.id },
      );
    }

    // Matched against `input.secret` — the plaintext the handler recovered from
    // `pendingSecretValue` — and *promoted* as `pendingSecret`, which is the stored envelope.
    // Verifying against the envelope instead would HMAC a ciphertext and could never match,
    // which is exactly the bug this pair of values exists to keep straight.
    const match = this.matchCode(input, input.secret, now);
    if (match === null) {
      throw new MfaDomainError(
        MfaErrorReason.CODE_INVALID,
        'the code does not match',
        { factorId: this.id, method: this.props.method },
      );
    }
    this.spendStep(match);

    this.props.secretCiphertext = pendingSecret;
    this.props.pendingSecretKind = null;
    this.props.pendingSecretValue = null;
    this.props.pendingSecretExpiresAt = null;
    this.props.failedAttempts = 0;
    this.props.lockedUntil = null;
    this.props.activatedAt = now;
    this.transition(MfaStatus.ACTIVE, now);

    this.addDomainEvent(
      new MfaEnrolled(this.id, {
        userId: this.props.userId,
        method: this.props.method,
      }, this.props.version),
    );
  }

  /**
   * Checks a TOTP proof and spends the step it matched.
   *
   * @remarks The step is spent rather than merely recorded. That single inequality is the
   * whole replay defence: RFC 6238 gives a code a 90-second life and then reissues the same
   * six digits, so an attacker who captures one request and resends it 20 seconds later would
   * otherwise authenticate a second time. Requiring the counter to *advance* rejects the
   * resend, rejects the same digits from an earlier step inside the window, and — because a
   * later step is always accepted — costs an honest user nothing as the clock moves on.
   *
   * @remarks The counter is stored per factor and compared, never trusted as a range. Storing
   * "the highest step seen" is also what makes the check a single row read rather than a
   * lookup across the window.
   *
   * @returns the step that was spent, for the caller's result payload.
   */
  verifyTotp(input: {
    readonly code: string;
    readonly secret: string;
    readonly now: Date;
    readonly totp: TotpEnginePort;
    readonly policy: MfaPolicy;
  }): bigint {
    const { now } = input;

    if (!this.canSatisfyVerification) {
      throw new MfaDomainError(
        MfaErrorReason.FACTOR_NOT_ACTIVE,
        'this factor cannot satisfy a verification',
        { factorId: this.id, status: this.props.status },
      );
    }

    this.assertUnlocked(now);

    const match = this.matchCode(input, input.secret, now);
    if (match === null) {
      throw new MfaDomainError(
        MfaErrorReason.CODE_INVALID,
        'the code does not match',
        { factorId: this.id, method: this.props.method },
      );
    }

    const counter = this.spendStep(match);

    this.props.lastVerifiedAt = now;
    this.props.failedAttempts = 0;
    this.props.lockedUntil = null;
    this.bump(now);

    this.addDomainEvent(
      new MfaVerified(this.id, {
        userId: this.props.userId,
        method: this.props.method,
      }, this.props.version),
    );

    return counter;
  }

  /**
   * Turns the factor off, but only for a caller who can still prove possession of it.
   *
   * @remarks Requiring a code is the whole point. Disabling MFA is the step an attacker takes
   * immediately after a password reset, so "proves who you are" is not enough here — the
   * request has to prove the very thing being revoked.
   *
   * @remarks The secret is destroyed rather than flagged. Leaving a live TOTP secret behind
   * after the user asked for MFA to be turned off would mean the next enrolment reuses
   * nothing, but any code the attacker already captured would still verify — against a
   * factor the user believes no longer exists.
   *
   * @remarks No replay guard here, deliberately: this is a possession check that ends in
   * revocation, not a grant of access. Requiring a fresh step would mean a user who disabled
   * MFA with the code they had just used to sign in could not disable it at all.
   */
  disable(input: {
    readonly code: string;
    readonly secret: string;
    readonly now: Date;
    readonly totp: TotpEnginePort;
    readonly policy: MfaPolicy;
  }): void {
    const { now } = input;

    if (!this.canSatisfyVerification) {
      throw new MfaDomainError(
        MfaErrorReason.FACTOR_NOT_ACTIVE,
        'only an active factor can be disabled',
        { factorId: this.id, status: this.props.status },
      );
    }

    this.assertUnlocked(now);

    if (this.matchCode(input, input.secret, now) === null) {
      throw new MfaDomainError(
        MfaErrorReason.CODE_INVALID,
        'the code does not match',
        { factorId: this.id, method: this.props.method },
      );
    }

    this.props.secretCiphertext = null;
    this.props.secretHash = null;
    this.props.pendingSecretKind = null;
    this.props.pendingSecretValue = null;
    this.props.pendingSecretExpiresAt = null;
    // The spent-step marker goes with the secret: a re-enrolment is a new factor, and a stale
    // counter would reject the user's very first legitimate code.
    this.props.lastUsedCounter = null;
    this.props.failedAttempts = 0;
    this.props.lockedUntil = null;
    this.transition(MfaStatus.DISABLED, now);

    this.addDomainEvent(
      new MfaDisabled(this.id, {
        userId: this.props.userId,
        method: this.props.method,
      }, this.props.version),
    );
  }

  /**
   * Records one settled failure against the factor.
   *
   * @remarks Called by the command handler in a transaction of its own, after the verification
   * transaction has unwound. Counting attempts inside the failing transaction would count
   * nothing: the exception rolls the increment back, and a brute-forcer would get unlimited
   * guesses for free.
   */
  registerFailure(reason: string, now: Date, policy: MfaPolicy): void {
    this.props.failedAttempts += 1;
    if (policy.lockoutMs > 0 && this.props.failedAttempts >= policy.maxFailedAttempts) {
      this.props.lockedUntil = new Date(now.getTime() + policy.lockoutMs);
    }
    this.bump(now);

    this.addDomainEvent(
      new MfaVerificationFailed(this.id, {
        userId: this.props.userId,
        method: this.props.method,
        reason,
        failedAttempts: this.props.failedAttempts,
        lockedUntil: this.props.lockedUntil?.toISOString() ?? null,
      }, this.props.version),
    );
  }

  // ---- internals -----------------------------------------------------------------

  /**
   * Marks a step spent, or refuses the proof that tried to spend it twice.
   *
   * @remarks The single place the replay rule lives, so there is exactly one inequality to
   * audit rather than one per call site. `<=` rather than `===` is deliberate: the window
   * admits steps `current-1`, `current` and `current+1`, and a code captured from an earlier
   * step inside that window is still the same six digits a second request would carry.
   *
   * @returns the counter now recorded, so callers do not read it back.
   */
  private spendStep(match: TotpMatch): bigint {
    const lastUsed = this.props.lastUsedCounter;
    if (lastUsed !== null && match.counter <= lastUsed) {
      throw new MfaDomainError(
        MfaErrorReason.CODE_ALREADY_USED,
        'this code has already been used',
        { factorId: this.id, counter: match.counter.toString() },
      );
    }
    this.props.lastUsedCounter = match.counter;
    return match.counter;
  }

  private assertUnlocked(now: Date): void {
    if (this.isLocked(now)) {
      throw new MfaDomainError(
        MfaErrorReason.FACTOR_LOCKED,
        'this factor is temporarily locked',
        { factorId: this.id, lockedUntil: this.props.lockedUntil?.toISOString() ?? null },
      );
    }
  }

  /** Runs the engine and returns the match, or `null` for anything that is not a code. */
  private matchCode(
    input: { readonly code: string; readonly now: Date; readonly totp: TotpEnginePort; readonly policy: MfaPolicy },
    secret: string,
    now: Date,
  ): TotpMatch | null {
    if (!TOTP_CODE_PATTERN.test(input.code)) {
      // Rejected without touching the HMAC: a malformed code is not a near miss, and
      // computing one anyway only widens what an attacker can time.
      return null;
    }
    if (secret.length === 0) {
      return null;
    }
    return input.totp.verify({
      secret,
      code: input.code,
      at: now,
      window: input.policy.window,
    });
  }

  private transition(to: MfaStatus, now: Date): void {
    const from = this.props.status;
    if (!canTransition(from, to)) {
      throw new MfaDomainError(
        MfaErrorReason.FACTOR_NOT_ACTIVE,
        `illegal factor transition ${from} -> ${to}`,
        { factorId: this.id, from, to },
      );
    }
    this.props.status = to;
    this.bump(now);
  }

  /** Every mutation goes through here, so `version` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

export type MfaFactorEvent =
  | MfaEnrollmentStarted
  | MfaEnrolled
  | MfaVerified
  | MfaVerificationFailed
  | MfaDisabled;

export const isMfaFactorEvent = (event: IDomainEvent): event is MfaFactorEvent =>
  event.aggregateType === MFA_FACTOR_AGGREGATE;