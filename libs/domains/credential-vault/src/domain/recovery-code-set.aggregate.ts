/**
 * @fileoverview A user's set of single-use recovery codes.
 *
 * @remarks This is its own aggregate root rather than a child of {@link PasswordCredential},
 * because the table is keyed by `user_id` and not by credential id: a user who has never set a
 * password can still hold recovery codes, and a user whose password credential was revoked
 * must not keep theirs — which is only expressible if the codes do not belong to the password.
 *
 * @remarks The aggregate holds *digests* after issuance. The plaintext leaves in the command
 * result and is never stored, never logged and never re-readable, so a regeneration replaces
 * the whole set and the old codes simply stop existing.
 */
import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/core';
import {
  RecoveryCode,
  RECOVERY_CODE_COUNT_DEFAULT,
  RECOVERY_CODE_COUNT_MAX,
  type RecoveryCodeRow,
} from './value-objects/recovery-code.vo';

/** Aggregate/event identity constants — the prefix that scopes every recovery-code event. */
export const RECOVERY_CODE_SET_AGGREGATE = 'RecoveryCodeSet';

/**
 * A fresh set of recovery codes was issued.
 *
 * @remarks Carries no code and no digest. The fact that is worth publishing is "this user's
 * bypasses were replaced" — account-security needs to know a recovery just happened, and
 * nothing else needs to learn anything about the codes themselves.
 */
export class RecoveryCodesRegenerated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      readonly userId: string;
      readonly codeCount: number;
    },
    version = 1,
  ) {
    super(aggregateId, RECOVERY_CODE_SET_AGGREGATE, 'credential.recovery_codes_regenerated', version);
  }
}

export class RecoveryCodeSet extends AggregateRoot<string> {
  private constructor(
    userId: string,
    private codes: RecoveryCode[],
    /**
     * Strictly monotonic stamp used as the event version, and therefore as the tail of the
     * outbox `dedup_key`.
     *
     * @remarks A counter would be wrong here. `recovery_codes` has no revision column, so a
     * counter restarts at 1 every time the set is loaded — and the first regeneration after
     * that reload would collide with the key the original issuance used, turning the event
     * into a silently skipped duplicate. The newest `created_at` survives the reload and is
     * already written by the regeneration that produced it.
     */
    private revisionAt: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    super(userId, createdAt, updatedAt, null);
  }

  /** Issues a brand-new set for a user who may have had none. */
  static issue(input: {
    userId: string;
    count?: number;
    now?: Date;
  }): { set: RecoveryCodeSet; codes: readonly RecoveryCode[] } {
    Ensure.notEmpty(input.userId, 'userId');
    const count = RecoveryCodeSet.assertCount(input.count ?? RECOVERY_CODE_COUNT_DEFAULT);
    const now = input.now ?? new Date();

    const codes = [...RecoveryCode.mintSet(count, now)];
    const set = new RecoveryCodeSet(input.userId, codes, now.getTime(), now, now);
    set.announce();

    return { set, codes };
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRows(userId: string, rows: readonly RecoveryCodeRow[]): RecoveryCodeSet {
    const codes = [...rows]
      .sort((left, right) => left.code_index - right.code_index)
      .map(RecoveryCode.fromRow);

    const newest = rows.reduce<Date>(
      (latest, row) => (row.created_at > latest ? row.created_at : latest),
      rows[0]?.created_at ?? new Date(),
    );

    return new RecoveryCodeSet(
      userId,
      codes,
      Math.floor(newest.getTime()),
      rows[0]?.created_at ?? newest,
      newest,
    );
  }

  /**
   * Replaces every code.
   *
   * @remarks Wholesale by definition, which is what "regenerate" means: a user who has lost
   * the old sheet must be able to say so, and any surviving code would keep a copy of the
   * sheet they believe is worthless. The previous digests go with it.
   *
   * @returns the new codes, which exist as plaintext only in this result.
   */
  regenerate(input: { count?: number; now?: Date } = {}): readonly RecoveryCode[] {
    const count = RecoveryCodeSet.assertCount(input.count ?? RECOVERY_CODE_COUNT_DEFAULT);
    const now = input.now ?? new Date();

    this.codes = [...RecoveryCode.mintSet(count, now)];
    this.updatedAt = now;
    // Forced monotonic: a clock that stepped backwards, or two regenerations inside one
    // millisecond, would otherwise reuse the previous version and lose the event.
    this.revisionAt = Math.max(now.getTime(), this.revisionAt + 1);
    this.announce();

    return this.codes;
  }

  /**
   * Burns the code matching `presented`.
   *
   * @remarks Single use, enforced twice: the digest has to match *and* the row has to be
   * unconsumed. A consumed code keeps its row so a reuse attempt is visible to the caller and
   * to anyone reading `consumed_at` afterwards.
   *
   * @returns the index of the consumed code, or `null` when nothing matched — including when
   * the right code was presented a second time.
   */
  consume(presented: string, now: Date = new Date()): number | null {
    Ensure.notEmpty(presented, 'recovery code');

    const match = this.codes.find((code) => !code.isConsumed && code.matches(presented));
    if (!match) return null;

    // `consume` cannot fail here: the search above already excluded consumed rows.
    match.consume(now);
    this.updatedAt = now;

    return match.index;
  }

  get remaining(): number {
    return this.codes.filter((code) => !code.isConsumed).length;
  }

  get total(): number {
    return this.codes.length;
  }

  /** Digest rows for `recovery_codes`. Never the plaintext. */
  toRows(): readonly RecoveryCodeRow[] {
    return this.codes.map((code) => ({
      code_index: code.index,
      code_digest: code.digest,
      consumed_at: code.consumedAt,
      created_at: code.createdAt,
    }));
  }

  /** Fail fast on a count that came from configuration rather than from code. */
  private static assertCount(count: number): number {
    if (!Number.isInteger(count) || count < 1 || count > RECOVERY_CODE_COUNT_MAX) {
      throw new Error(
        `recovery code count must be an integer between 1 and ${RECOVERY_CODE_COUNT_MAX}`,
      );
    }
    return count;
  }

  private announce(): void {
    this.addDomainEvent(
      new RecoveryCodesRegenerated(
        this.id,
        { userId: this.id, codeCount: this.codes.length },
        this.revisionAt,
      ),
    );
  }
}

export type RecoveryCodeEvent = RecoveryCodesRegenerated;

export const isRecoveryCodeEvent = (event: IDomainEvent): event is RecoveryCodeEvent =>
  event.aggregateType === RECOVERY_CODE_SET_AGGREGATE;