/**
 * @fileoverview In-memory doubles for the ports, plus the fixed clock the suite runs on.
 *
 * @remarks Hand-written rather than auto-mocked. A mock asserts on the calls a test *expects*,
 * which is the opposite of what a replay test needs: the question there is "does the second
 * request fail", and only the *state* can answer it.
 *
 * @remarks Both repositories store **rehydrated copies**, not the aggregates they were handed.
 * That is deliberate and load-bearing: it means a suite assertion about `lastUsedCounter`
 * proves the spent-step marker reached storage, rather than proving it is still sitting in an
 * object the handler happens to be holding. It also exercises `fromRow` on every write.
 */

import type { IUnitOfWork } from '@auth/ddd-core';
import type { MfaMethod } from '../../src/domain/value-objects/mfa-method.vo';
import type { MfaFactorRepositoryPort } from '../../src/domain/ports/mfa-factor-repository.port';
import type { RecoveryCodeSetRepositoryPort } from '../../src/domain/ports/recovery-code-set-repository.port';
import { MfaFactor, type MfaFactorRow } from '../../src/domain/mfa-factor.aggregate';
import {
  RecoveryCodeSet,
  type RecoveryCodeSetRow,
} from '../../src/domain/recovery-code-set.aggregate';
import { NodeTotpService } from '../../src/infrastructure/crypto/node-totp.service';
import { NodeRecoveryCodeService } from '../../src/infrastructure/crypto/node-recovery-codes.service';
import { AesGcmSecretVault } from '../../src/infrastructure/crypto/aes-gcm-secret-vault';
import { FixedClock } from '../../src/infrastructure/time/system-clock';
import { TOTP_DIGITS, TOTP_PERIOD_SEC } from '../../src/domain/value-objects/mfa-method.vo';
import type { MfaConfig } from '../../src/mfa.config';
import { randomBytes } from 'node:crypto';

/** 2023-11-14T22:13:20.000Z — a whole TOTP step boundary, so nothing is off by a period. */
export const T0 = new Date('2023-11-14T22:13:20.000Z');

export const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const OTHER_USER_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

/**
 * The RFC 4226 / 6238 test secret: the ASCII `12345678901234567890`, base32-encoded.
 *
 * @remarks Not a random secret. The published vectors only exist for this key, and a test that
 * pins the implementation to them is the only way to know the arithmetic is right rather than
 * merely self-consistent.
 */
export const RFC_TEST_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/** 32 bytes of base64, as `MFA_SECRET_ENCRYPTION_KEY` would hold. */
export const TEST_ENCRYPTION_KEY = randomBytes(32).toString('base64');

export const testConfig = (overrides: Partial<MfaConfig> = {}): MfaConfig => ({
  totpIssuer: 'auth-platform-test',
  totpPeriodSec: TOTP_PERIOD_SEC,
  totpDigits: TOTP_DIGITS,
  totpWindow: 1,
  enrollmentTtlSec: 600,
  maxFailedAttempts: 5,
  lockoutSec: 300,
  recoveryCodeCount: 10,
  secretEncryptionKey: TEST_ENCRYPTION_KEY,
  ...overrides,
});

export const makeTotp = (periodSec = TOTP_PERIOD_SEC, digits = TOTP_DIGITS): NodeTotpService =>
  new NodeTotpService(periodSec, digits);

export const makeVault = (key = TEST_ENCRYPTION_KEY): AesGcmSecretVault =>
  new AesGcmSecretVault(key);

export const makeCodes = (): NodeRecoveryCodeService => new NodeRecoveryCodeService();

export const makeClock = (at: Date = T0): FixedClock => new FixedClock(at);

/** Flattens an aggregate into the row shape persistence would hand back. */
export const factorRowOf = (factor: MfaFactor): MfaFactorRow => ({
  id: factor.id,
  user_id: factor.userId,
  method: factor.method,
  status: factor.status,
  account_label: factor.accountLabel,
  destination_hint: factor.destinationHint,
  secret_ciphertext: factor.secretCiphertext,
  secret_hash: null,
  pending_secret_kind: factor.pendingSecretKind,
  pending_secret_value: factor.pendingSecretValue,
  pending_secret_expires_at: factor.pendingSecretExpiresAt,
  failed_attempts: factor.failedAttempts,
  locked_until: factor.lockedUntil,
  created_at: factor.createdAt,
  updated_at: factor.updatedAt,
  activated_at: factor.activatedAt,
  last_verified_at: factor.lastVerifiedAt,
  version: factor.factorVersion,
  totp_used_counters:
    factor.lastUsedCounter === null ? null : { last_counter: factor.lastUsedCounter },
});

/** Flattens a recovery-code set into the row shape persistence would hand back. */
export const recoverySetRowOf = (set: RecoveryCodeSet): RecoveryCodeSetRow => ({
  set_id: set.id,
  user_id: set.userId,
  salt: set.salt,
  created_at: set.issuedAt,
  regenerated_at: set.regeneratedAt,
  mfa_recovery_codes: set.entries().map((entry) => ({
    code_index: entry.index,
    digest: entry.digest,
    consumed_at: entry.consumedAt,
  })),
});

export class InMemoryFactorRepository implements MfaFactorRepositoryPort {
  /** Stored rows, rehydrated — what a later request would actually load. */
  readonly rows = new Map<string, MfaFactorRow>();

  /** Every row whose stored form was read back, for assertions about the marker. */
  spentCounters(): bigint[] {
    return [...this.rows.values()]
      .map((row) => row.totp_used_counters?.last_counter)
      .filter((value): value is bigint => value !== undefined && value !== null);
  }

  async save(factor: MfaFactor): Promise<void> {
    factor.clearDomainEvents();
    this.rows.set(factor.id, factorRowOf(factor));
  }

  async findById(id: string): Promise<MfaFactor | null> {
    const row = this.rows.get(id);
    return row ? MfaFactor.fromRow(row) : null;
  }

  async findByUser(userId: string): Promise<MfaFactor[]> {
    return [...this.rows.values()]
      .filter((row) => row.user_id === userId)
      .map((row) => MfaFactor.fromRow(row));
  }

  async findActiveByUserAndMethod(
    userId: string,
    method: MfaMethod,
  ): Promise<MfaFactor | null> {
    const row = [...this.rows.values()]
      .filter(
        (candidate) =>
          candidate.user_id === userId && candidate.method === method && candidate.status === 'active',
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    return row ? MfaFactor.fromRow(row) : null;
  }

  async count(): Promise<number> {
    return this.rows.size;
  }
}

export class InMemoryRecoverySetRepository implements RecoveryCodeSetRepositoryPort {
  row: RecoveryCodeSetRow | null = null;

  async replace(set: RecoveryCodeSet): Promise<void> {
    set.clearDomainEvents();
    // Destructive, exactly like the Prisma implementation: a rotation is not a merge.
    this.row = {
      set_id: set.id,
      user_id: set.userId,
      salt: set.salt,
      created_at: set.issuedAt,
      regenerated_at: set.regeneratedAt,
      mfa_recovery_codes: set.entries().map((entry) => ({
        code_index: entry.index,
        digest: entry.digest,
        consumed_at: entry.consumedAt,
      })),
    };
  }

  async save(set: RecoveryCodeSet): Promise<void> {
    set.clearDomainEvents();
    const codes = this.row?.mfa_recovery_codes;
    if (!codes) return;

    for (const entry of set.entries()) {
      const stored = codes.find((candidate) => candidate.code_index === entry.index);
      if (stored) stored.consumed_at = entry.consumedAt;
    }
  }

  async findByUser(userId: string): Promise<RecoveryCodeSet | null> {
    return this.row && this.row.user_id === userId
      ? RecoveryCodeSet.fromRow(this.row)
      : null;
  }

  /**
   * Compare-and-set, in the same shape as the conditional `UPDATE` in the real repository.
   *
   * @remarks Returns `false` for a code that is already spent, which is the only honest answer
   * available under concurrency — and the behaviour a single-use guarantee actually rests on.
   */
  async consumeCode(setId: string, codeIndex: number, now: Date): Promise<boolean> {
    const codes = this.row?.mfa_recovery_codes;
    if (!this.row || this.row.set_id !== setId) return false;

    const stored = codes?.find((candidate) => candidate.code_index === codeIndex);
    if (!stored || stored.consumed_at !== null) return false;

    stored.consumed_at = now;
    return true;
  }
}

/**
 * A unit of work that counts boundaries and refuses to nest.
 *
 * @remarks Nesting is refused rather than tolerated for the same reason the real one refuses
 * it: a nested transaction would give half a command its own commit point, and "one command,
 * one transaction" would stop being true in exactly the code path that cannot be tested.
 */
export class RecordingUnitOfWork implements IUnitOfWork {
  readonly commits: number[] = [];
  private depth = 0;

  async runInTransaction<TResult>(fn: () => Promise<TResult>): Promise<TResult> {
    if (this.depth > 0) {
      throw new Error('nested transaction');
    }
    this.depth += 1;
    try {
      return await fn();
    } finally {
      this.depth -= 1;
      this.commits.push(Date.now());
    }
  }

  isActive(): boolean {
    return this.depth > 0;
  }
}