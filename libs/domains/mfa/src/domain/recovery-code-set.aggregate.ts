/**
 * @fileoverview The user's backup codes.
 *
 * @remarks Separate from {@link MfaFactor} because the schema is: `mfa_recovery_code_sets` is
 * keyed by `user_id` (unique) and holds no reference to any factor, while `mfa_factors` holds
 * no reference to any code set. Recovery codes survive a factor being replaced and belong to
 * the person, not the enrolment — so pretending otherwise and bolting them onto the factor
 * would model a relationship the database denies.
 *
 * @remarks Only digests are ever held here. The plaintext exists for the length of one
 * response and is never stored, never logged and never re-derivable: a dump of
 * `mfa_recovery_codes` is therefore useless to an attacker with read access, which is the only
 * outcome that makes it acceptable to keep a *recovery* mechanism at all.
 *
 * @remarks Consumption is single-use by index, and the uniqueness that enforces it lives in the
 * conditional `UPDATE ... WHERE consumed_at IS NULL`, not in this class. In-memory this is a
 * boolean; in the database it is a compare-and-set, which is what stops two concurrent
 * verifications from spending the same code.
 */

import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/core';
import { MfaDomainError, MfaErrorReason } from './errors/mfa-domain.error';
import type { MfaMethod } from './value-objects/mfa-method.vo';
import { MfaMethod as Method } from './value-objects/mfa-method.vo';

export const RECOVERY_CODE_SET_AGGREGATE = 'MfaRecoveryCodeSet';

/**
 * One code's stored form.
 *
 * @remarks `code` is empty on every entry rehydrated from the database and populated only on
 * the response path. Keeping it on the type — rather than having a parallel "digest only"
 * shape — makes the fact impossible to lose sight of at a call site.
 */
export interface RecoveryCodeEntry {
  /** Plaintext. Present only while a fresh set is being handed to its owner. */
  readonly code: string;
  readonly digest: string;
  readonly consumedAt: Date | null;
}

export interface RecoveryCodeSetProps {
  userId: string;
  /** Per-set salt. Mixing it into every digest means two sets never share a digest table. */
  salt: string;
  issuedAt: Date;
  regeneratedAt: Date | null;
  codes: readonly RecoveryCodeEntry[];
  version: number;
}

export interface RecoveryCodeSetRow {
  set_id: string;
  user_id: string;
  salt: string;
  created_at: Date;
  regenerated_at: Date | null;
  mfa_recovery_codes?: {
    code_index: number;
    digest: string;
    consumed_at: Date | null;
  }[];
}

export class MfaRecoveryCodesIssued extends DomainEvent {
  constructor(aggregateId: string, version = 1) {
    super(aggregateId, RECOVERY_CODE_SET_AGGREGATE, 'mfa.recovery_codes_issued', version);
  }
}

export class MfaRecoveryCodesRegenerated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; codeCount: number },
    version = 1,
  ) {
    super(aggregateId, RECOVERY_CODE_SET_AGGREGATE, 'mfa.recovery_codes_regenerated', version);
  }
}

/**
 * A recovery code was spent, so a second factor was satisfied.
 *
 * @remarks Carries the `mfa.verified` event type rather than a bespoke one: to every
 * consumer downstream — the audit log, the notification service, auth-gateway's own view of
 * "this session is now second-factor verified" — spending a backup code and typing a TOTP
 * code are the same fact. Splitting them would force every consumer to learn that recovery
 * codes exist and where in the flow they are accepted.
 *
 * @remarks The payload names the *method*, never the code. An event bus is a broadcast
 * surface with a long retention, and a raw recovery code in it would outlive the single use
 * that makes it safe.
 */
export class MfaRecoveryCodeVerified extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; method: MfaMethod },
    version = 1,
  ) {
    super(aggregateId, RECOVERY_CODE_SET_AGGREGATE, 'mfa.verified', version);
  }
}

export class RecoveryCodeSet extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: RecoveryCodeSetProps,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(id, createdAt, updatedAt, null);
  }

  /**
   * Issues the first set.
   *
   * @remarks The caller supplies `code`/`digest` pairs because digests are produced by the
   * {@link RecoveryCodePort}: the aggregate stores an opaque string it cannot recompute, so
   * there is no path by which a plaintext code could be persisted by accident.
   */
  static issue(input: {
    userId: string;
    salt: string;
    entries: readonly RecoveryCodeEntry[];
    now?: Date;
    id?: string;
  }): RecoveryCodeSet {
    Ensure.notEmpty(input.userId, 'userId');
    Ensure.notEmpty(input.salt, 'salt');
    Ensure.isTrue(input.entries.length > 0, 'a recovery code set needs at least one code');

    const now = input.now ?? new Date();
    const set = new RecoveryCodeSet(
      input.id ?? crypto.randomUUID(),
      {
        userId: input.userId,
        salt: input.salt,
        issuedAt: now,
        regeneratedAt: null,
        codes: input.entries.map((entry) => ({ ...entry, consumedAt: null })),
        version: 0,
      },
      now,
      now,
    );

    set.bump(now);
    set.addDomainEvent(new MfaRecoveryCodesIssued(set.id, set.props.version));
    return set;
  }

  /** Rehydration from persistence. Emits nothing — the write already happened. */
  static fromRow(row: RecoveryCodeSetRow): RecoveryCodeSet {
    const codes = (row.mfa_recovery_codes ?? [])
      .slice()
      .sort((a, b) => a.code_index - b.code_index)
      .map((code) => ({
        // Empty by construction: the table has no column for it. A rehydrated entry is a
        // digest and a spend marker, never a usable code.
        code: '',
        digest: code.digest,
        consumedAt: code.consumed_at,
      }));

    return new RecoveryCodeSet(
      row.set_id,
      {
        userId: row.user_id,
        salt: row.salt,
        issuedAt: row.created_at,
        regeneratedAt: row.regenerated_at,
        codes,
        version: 0,
      },
      row.created_at,
      row.regenerated_at ?? row.created_at,
    );
  }

  // ---- reads ---------------------------------------------------------------------

  get userId(): string {
    return this.props.userId;
  }

  get salt(): string {
    return this.props.salt;
  }

  get issuedAt(): Date {
    return this.props.issuedAt;
  }

  get regeneratedAt(): Date | null {
    return this.props.regeneratedAt;
  }

  get codeCount(): number {
    return this.props.codes.length;
  }

  get remaining(): number {
    return this.props.codes.filter((entry) => entry.consumedAt === null).length;
  }

  /** Indices still spendable, ascending. */
  unconsumedIndexes(): number[] {
    return this.props.codes
      .map((entry, index) => (entry.consumedAt === null ? index : -1))
      .filter((index) => index >= 0);
  }

  digestAt(index: number): string {
    return this.props.codes[index]?.digest ?? '';
  }

  /** Every entry, as `(index, digest, consumedAt)`. Never the plaintext. */
  entries(): { index: number; digest: string; consumedAt: Date | null }[] {
    return this.props.codes.map((entry, index) => ({
      index,
      digest: entry.digest,
      consumedAt: entry.consumedAt,
    }));
  }

  // ---- transitions --------------------------------------------------------------

  /**
   * Spends one code.
   *
   * @remarks Marks it locally; the caller still has to win the compare-and-set in storage,
   * because in-memory exclusivity proves nothing about two requests racing.
   *
   * @remarks Refusing to spend the *last* code is deliberate. A user with zero remaining codes
   * and a disabled factor can never authenticate again, and the only remedy — an operator
   * action — is far more disruptive than one spare code. Refusing here means the last code
   * stays valid until the user regenerates the set.
   */
  consumeAt(index: number, now: Date): void {
    const entry = this.props.codes[index];
    if (!entry || entry.consumedAt !== null) {
      throw new MfaDomainError(
        MfaErrorReason.CODE_INVALID,
        'the code does not match',
        { userId: this.props.userId },
      );
    }
    if (this.remaining <= 1) {
      throw new MfaDomainError(
        MfaErrorReason.RECOVERY_CODES_EXHAUSTED,
        'this is the last remaining recovery code; regenerate the set first',
        { userId: this.props.userId },
      );
    }

    (entry as { consumedAt: Date | null }).consumedAt = now;
    this.bump(now);

    this.addDomainEvent(
      new MfaRecoveryCodeVerified(this.id, {
        userId: this.props.userId,
        method: Method.BACKUP_CODE,
      }, this.props.version),
    );
  }

  /**
   * Replaces every code with a fresh set.
   *
   * @remarks The previous generation stops working by construction: new salt, new digests,
   * every old row discarded. Rotation is therefore *not* additive — a regeneration that
   * merged would leave the codes an attacker already photographed still valid, which is the
   * exact opposite of what the user asked for when they rotated after a suspected compromise.
   */
  rotate(input: {
    salt: string;
    entries: readonly RecoveryCodeEntry[];
    now?: Date;
  }): void {
    Ensure.notEmpty(input.salt, 'salt');
    Ensure.isTrue(input.entries.length > 0, 'a recovery code set needs at least one code');

    const now = input.now ?? new Date();
    this.props.salt = input.salt;
    this.props.codes = input.entries.map((entry) => ({ ...entry, consumedAt: null }));
    this.props.regeneratedAt = now;
    this.bump(now);

    this.addDomainEvent(
      new MfaRecoveryCodesRegenerated(this.id, {
        userId: this.props.userId,
        codeCount: this.props.codes.length,
      }, this.props.version),
    );
  }

  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }

  /**
   * Never serialises a code.
   *
   * @remarks {@link RecoveryCodeEntry.code} is an enumerable own property, so without this the
   * base representation would carry live bypasses into any `JSON.stringify` of a whole
   * aggregate — a log line, an error serialiser, an audit hook walking the object graph. A
   * code must reach its owner exactly once, through the response that hands it over, and
   * nowhere else.
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      userId: this.props.userId,
      issuedAt: this.props.issuedAt.toISOString(),
      regeneratedAt: this.props.regeneratedAt?.toISOString() ?? null,
      codeCount: this.codeCount,
      remaining: this.remaining,
      entries: this.entries(),
    };
  }
}

export type RecoveryCodeSetEvent = MfaRecoveryCodesIssued | MfaRecoveryCodesRegenerated;

export const isRecoveryCodeSetEvent = (event: IDomainEvent): event is RecoveryCodeSetEvent =>
  event.aggregateType === RECOVERY_CODE_SET_AGGREGATE;