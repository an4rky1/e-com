/**
 * @fileoverview The five write paths.
 *
 * @remarks Commands are the only place mutations happen, so authorisation, auditing and event
 * publication have exactly one hook rather than one per entry point.
 *
 * @remarks Two invariants run through every handler here:
 *
 * 1. **One transaction per command**, opened through the unit of work. A verification writes
 *    the factor, its spent-step marker and the outbox rows together — a replay guard whose
 *    write can be separated from the state it protects is not a replay guard.
 * 2. **A refusal is counted in a transaction of its own.** The aggregate throws without
 *    mutating and the handler records the attempt afterwards, because counting it inside the
 *    failing transaction would count nothing: the exception rolls the increment back, and a
 *    brute-forcer would get unlimited guesses for free.
 */

import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ValidationException } from '@auth/platform/error-handling';
import type { IClock } from '@auth/core';
import {
  MfaDomainError,
  MfaErrorReason,
  isMfaDomainError,
  type MfaDomainError as MfaDomainErrorType,
} from '../../domain/errors/mfa-domain.error';
import { MfaFactor } from '../../domain/mfa-factor.aggregate';
import type { MfaPolicy } from '../../domain/mfa-policy';
import { RecoveryCodeSet } from '../../domain/recovery-code-set.aggregate';
import {
  MFA_FACTOR_REPOSITORY,
  type MfaFactorRepositoryPort,
} from '../../domain/ports/mfa-factor-repository.port';
import {
  RECOVERY_CODE_SET_REPOSITORY,
  type RecoveryCodeSetRepositoryPort,
} from '../../domain/ports/recovery-code-set-repository.port';
import {
  CLOCK,
  MFA_UNIT_OF_WORK,
  type MfaUnitOfWork,
} from '../../domain/ports/mfa-unit-of-work.port';
import {
  RECOVERY_CODES,
  type RecoveryCodePort,
} from '../../domain/ports/recovery-code.port';
import {
  SECRET_VAULT,
  type SecretVaultPort,
} from '../../domain/ports/secret-vault.port';
import {
  TOTP_ENGINE,
  type TotpEnginePort,
} from '../../domain/ports/totp.port';
import {
  ENROLLABLE_METHODS,
  MfaMethod,
  TOTP_ALGORITHM,
} from '../../domain/value-objects/mfa-method.vo';
import { MfaStatus } from '../../domain/value-objects/mfa-status.vo';
import { MFA_CONFIG, enrollmentTtlMs, toPolicy, type MfaConfig } from '../../mfa.config';
import { toAppException, toMissingFactorException } from '../errors/mfa-error-translation';
import {
  BeginEnrollmentCommand,
  ConfirmEnrollmentCommand,
  DisableMfaCommand,
  RegenerateRecoveryCodesCommand,
  VerifyFactorCommand,
  toFactorSummary,
  type EnrollmentSecretBundle,
  type FactorVerificationResult,
  type MfaFactorSummary,
  type RecoveryCodeBundle,
} from './mfa.commands';

// ---- shared helpers -------------------------------------------------------------

const MIN_RECOVERY_CODES = 1;

interface FailureRecorderDeps {
  readonly factors: MfaFactorRepositoryPort;
  readonly uow: MfaUnitOfWork;
  readonly clock: IClock;
  readonly policy: MfaPolicy;
}

/**
 * Counts one settled failure against the factor, in its own transaction.
 *
 * @remarks Called *after* the failing transaction has unwound, which is the only point at
 * which the increment can survive. `factor` may be `null` — a caller who named a factor that
 * does not exist has not touched anything, and creating one to record the attempt would let
 * an unauthenticated caller fill the table.
 */
async function recordFailure(
  factor: MfaFactor | null,
  error: MfaDomainErrorType,
  deps: FailureRecorderDeps,
): Promise<void> {
  if (factor === null || !error.countsAsAttempt) return;

  factor.registerFailure(error.reason, deps.clock.now(), deps.policy);
  await deps.uow.runInTransaction(() => deps.factors.save(factor));
}

/** A factor the caller is allowed to act on, or the one answer that must not distinguish. */
async function loadOwnedFactor(
  factors: MfaFactorRepositoryPort,
  factorId: string,
  userId: string,
): Promise<MfaFactor> {
  const factor = await factors.findById(factorId);
  // Ownership is checked on the way out, not the way in: "no such factor" and "not yours"
  // have to be indistinguishable, or the endpoint becomes a user-enumeration oracle.
  if (!factor || factor.userId !== userId) {
    throw toMissingFactorException(factorId, userId);
  }
  return factor;
}

// ---- enrollment -----------------------------------------------------------------

@Injectable()
@CommandHandler(BeginEnrollmentCommand)
export class BeginEnrollmentHandler
  implements ICommandHandler<BeginEnrollmentCommand, EnrollmentSecretBundle>
{
  constructor(
    @Inject(MFA_FACTOR_REPOSITORY) private readonly factors: MfaFactorRepositoryPort,
    @Inject(MFA_UNIT_OF_WORK) private readonly uow: MfaUnitOfWork,
    @Inject(TOTP_ENGINE) private readonly totp: TotpEnginePort,
    @Inject(SECRET_VAULT) private readonly vault: SecretVaultPort,
    @Inject(CLOCK) private readonly clock: IClock,
    @Inject(MFA_CONFIG) private readonly config: MfaConfig,
  ) {}

  /**
   * Mints a secret, encrypts it, and parks the envelope on a `pending` factor.
   *
   * @remarks The plaintext exists here and in the response, and nowhere else. It is generated
   * server-side, handed to {@link SECRET_VAULT} immediately, and the only form the aggregate
   * ever sees is the envelope — so a defect in persistence cannot leak a usable secret.
   */
  async execute(command: BeginEnrollmentCommand): Promise<EnrollmentSecretBundle> {
    if (!ENROLLABLE_METHODS.includes(command.method)) {
      throw new ValidationException('method is not enrollable', {
        method: command.method,
        enrollable: [...ENROLLABLE_METHODS],
      });
    }

    // At most one live factor per (user, method). Re-enrolling on top of an existing one
    // would leave two `active` rows and no rule for which is the user's second factor; the
    // honest resolution is that turning MFA off is a separate, code-proven command.
    const live =
      (await this.factors.findActiveByUserAndMethod(command.userId, command.method)) ??
      (await this.factors.findByUser(command.userId)).find(
        (candidate) =>
          candidate.method === command.method && candidate.status === MfaStatus.PENDING,
      );
    if (live) {
      throw new ValidationException(
        'an unfinished or active factor already exists for this method',
        { method: command.method, factorId: live.id },
      );
    }

    const now = this.clock.now();
    const secret = this.totp.generateSecret();
    const secretCiphertext = await this.vault.encrypt(secret);

    const factor = MfaFactor.beginEnrollment({
      userId: command.userId,
      method: command.method,
      secretCiphertext,
      enrollmentTtlMs: enrollmentTtlMs(this.config),
      accountLabel: command.accountLabel ?? null,
      destinationHint: command.destinationHint ?? null,
      now,
    });

    await this.uow.runInTransaction(() => this.factors.save(factor));

    return {
      factorId: factor.id,
      method: factor.method,
      secret,
      otpauthUri: this.otpauthUri(secret, command.accountLabel),
      issuer: this.config.totpIssuer,
      expiresAt: (factor.pendingSecretExpiresAt ?? factor.createdAt).toISOString(),
    };
  }

  /**
   * The `otpauth://` URI an authenticator app scans.
   *
   * @remarks Digits and period are taken from configuration rather than hard-coded, because the
   * URI is a second, independent copy of the parameters the server verifies with. If the two
   * ever disagreed the app would show codes this service never accepts — and the user would
   * be told their authenticator is broken.
   */
  private otpauthUri(secret: string, accountLabel?: string | null): string {
    const label = this.config.totpIssuer;
    const account = accountLabel?.trim() || 'user';
    const params = new URLSearchParams({
      secret,
      issuer: label,
      algorithm: TOTP_ALGORITHM,
      digits: String(this.config.totpDigits),
      period: String(this.config.totpPeriodSec),
    });
    return `otpauth://totp/${encodeURIComponent(`${label}:${account}`)}?${params.toString()}`;
  }
}

@Injectable()
@CommandHandler(ConfirmEnrollmentCommand)
export class ConfirmEnrollmentHandler
  implements ICommandHandler<ConfirmEnrollmentCommand, MfaFactorSummary>
{
  private readonly policy: MfaPolicy;

  constructor(
    @Inject(MFA_FACTOR_REPOSITORY) private readonly factors: MfaFactorRepositoryPort,
    @Inject(MFA_UNIT_OF_WORK) private readonly uow: MfaUnitOfWork,
    @Inject(TOTP_ENGINE) private readonly totp: TotpEnginePort,
    @Inject(SECRET_VAULT) private readonly vault: SecretVaultPort,
    @Inject(CLOCK) private readonly clock: IClock,
    @Inject(MFA_CONFIG) config: MfaConfig,
  ) {
    this.policy = toPolicy(config);
  }

  async execute(command: ConfirmEnrollmentCommand): Promise<MfaFactorSummary> {
    const factor = await loadOwnedFactor(this.factors, command.factorId, command.userId);

    try {
      // Decrypted here, not in the aggregate: the aggregate's job is the state machine, and
      // giving it a decryption function would make "what does the aggregate hold" ambiguous.
      const envelope = factor.pendingSecretValue;
      if (envelope === null) {
        throw new MfaDomainError(
          MfaErrorReason.FACTOR_NOT_ACTIVE,
          'this factor has no secret awaiting confirmation',
          { factorId: factor.id },
        );
      }

      const secret = await this.vault.decrypt(envelope);

      factor.confirmEnrollment({
        code: command.code,
        secret,
        now: this.clock.now(),
        totp: this.totp,
        policy: this.policy,
      });

      await this.uow.runInTransaction(() => this.factors.save(factor));
    } catch (error) {
      if (!isMfaDomainError(error)) throw error;
      await recordFailure(factor, error, {
        factors: this.factors,
        uow: this.uow,
        clock: this.clock,
        policy: this.policy,
      });
      throw toAppException(error);
    }

    return toFactorSummary(factor);
  }
}

// ---- verification ---------------------------------------------------------------

@Injectable()
@CommandHandler(VerifyFactorCommand)
export class VerifyFactorHandler
  implements ICommandHandler<VerifyFactorCommand, FactorVerificationResult>
{
  private readonly policy: MfaPolicy;

  constructor(
    @Inject(MFA_FACTOR_REPOSITORY) private readonly factors: MfaFactorRepositoryPort,
    @Inject(RECOVERY_CODE_SET_REPOSITORY) private readonly sets: RecoveryCodeSetRepositoryPort,
    @Inject(RECOVERY_CODES) private readonly codes: RecoveryCodePort,
    @Inject(MFA_UNIT_OF_WORK) private readonly uow: MfaUnitOfWork,
    @Inject(TOTP_ENGINE) private readonly totp: TotpEnginePort,
    @Inject(SECRET_VAULT) private readonly vault: SecretVaultPort,
    @Inject(CLOCK) private readonly clock: IClock,
    @Inject(MFA_CONFIG) config: MfaConfig,
  ) {
    this.policy = toPolicy(config);
  }

  async execute(command: VerifyFactorCommand): Promise<FactorVerificationResult> {
    return command.method === MfaMethod.BACKUP_CODE
      ? this.verifyRecoveryCode(command)
      : this.verifyTotp(command);
  }

  /**
   * The TOTP path.
   *
   * @remarks The factor, the spent-step marker and `mfa.verified` commit together. Splitting
   * them would allow a crash between the counter write and the factor write — or between the
   * factor write and the counter write — and either ordering has a version of the same bug:
   * a code that verifies twice, or one that never verifies after a rollback.
   */
  private async verifyTotp(
    command: VerifyFactorCommand,
  ): Promise<FactorVerificationResult> {
    const now = this.clock.now();
    const factor = command.factorId
      ? await loadOwnedFactor(this.factors, command.factorId, command.userId)
      : await this.factors.findActiveByUserAndMethod(command.userId, command.method);

    if (!factor || factor.userId !== command.userId) {
      throw toMissingFactorException(command.factorId ?? '', command.userId);
    }

    try {
      const envelope = factor.secretCiphertext;
      if (envelope === null) {
        throw new MfaDomainError(
          MfaErrorReason.FACTOR_NOT_ACTIVE,
          'this factor has no active secret',
          { factorId: factor.id, status: factor.status },
        );
      }

      const counter = factor.verifyTotp({
        code: command.code,
        secret: await this.vault.decrypt(envelope),
        now,
        totp: this.totp,
        policy: this.policy,
      });

      await this.uow.runInTransaction(() => this.factors.save(factor));

      return {
        userId: command.userId,
        method: factor.method,
        factorId: factor.id,
        counter: counter.toString(),
        verifiedAt: now.toISOString(),
      };
    } catch (error) {
      if (!isMfaDomainError(error)) throw error;
      await recordFailure(factor, error, {
        factors: this.factors,
        uow: this.uow,
        clock: this.clock,
        policy: this.policy,
      });
      throw toAppException(error);
    }
  }

  /**
   * The recovery-code path.
   *
   * @remarks Every unspent digest in the set is compared; the winner is then spent with a
   * conditional `UPDATE`. Local exclusivity proves nothing about two requests racing, so the
   * compare-and-set in storage is the step that actually makes a code single-use, and the
   * aggregate's mark is what the caller is told about.
   *
   * @remarks No attempt budget here, and the omission is considered: a code is 50 bits of
   * CSPRNG output, so the guessable space is far past anything a lockout policy could police,
   * and there is no per-code budget to exhaust. The factor-level lockout still applies to the
   * TOTP path, which is the one with six digits to guess.
   */
  private async verifyRecoveryCode(
    command: VerifyFactorCommand,
  ): Promise<FactorVerificationResult> {
    const now = this.clock.now();
    const set = await this.sets.findByUser(command.userId);

    if (!set) {
      throw toAppException(
        new MfaDomainError(
          MfaErrorReason.NO_RECOVERY_CODES,
          'this account holds no recovery codes',
          { userId: command.userId },
        ),
      );
    }

    const index = set
      .unconsumedIndexes()
      .find((candidate) =>
        this.codes.matches(command.code, set.salt, set.digestAt(candidate)),
      );

    if (index === undefined) {
      throw toAppException(
        new MfaDomainError(MfaErrorReason.CODE_INVALID, 'the code does not match', {
          userId: command.userId,
        }),
      );
    }

    try {
      set.consumeAt(index, now);
    } catch (error) {
      if (!isMfaDomainError(error)) throw error;
      throw toAppException(error);
    }

    await this.uow.runInTransaction(async () => {
      const won = await this.sets.consumeCode(set.id, index, now);
      if (!won) {
        throw new MfaDomainError(
          MfaErrorReason.CODE_INVALID,
          'this recovery code has already been used',
          { userId: command.userId },
        );
      }
      await this.sets.save(set);
    });

    return {
      userId: command.userId,
      method: MfaMethod.BACKUP_CODE,
      factorId: null,
      counter: null,
      verifiedAt: now.toISOString(),
    };
  }
}

// ---- revocation -----------------------------------------------------------------

@Injectable()
@CommandHandler(DisableMfaCommand)
export class DisableMfaHandler implements ICommandHandler<DisableMfaCommand, void> {
  private readonly policy: MfaPolicy;

  constructor(
    @Inject(MFA_FACTOR_REPOSITORY) private readonly factors: MfaFactorRepositoryPort,
    @Inject(MFA_UNIT_OF_WORK) private readonly uow: MfaUnitOfWork,
    @Inject(TOTP_ENGINE) private readonly totp: TotpEnginePort,
    @Inject(SECRET_VAULT) private readonly vault: SecretVaultPort,
    @Inject(CLOCK) private readonly clock: IClock,
    @Inject(MFA_CONFIG) config: MfaConfig,
  ) {
    this.policy = toPolicy(config);
  }

  /**
   * Turns a factor off, and destroys its secret.
   *
   * @remarks A code is required even though the caller already holds a session: disabling MFA
   * is the step an attacker takes immediately after a password reset, so the request has to
   * prove the very thing being revoked.
   */
  async execute(command: DisableMfaCommand): Promise<void> {
    const factor = await loadOwnedFactor(this.factors, command.factorId, command.userId);

    try {
      const envelope = factor.secretCiphertext;
      if (envelope === null) {
        throw new MfaDomainError(
          MfaErrorReason.FACTOR_NOT_ACTIVE,
          'this factor has no active secret',
          { factorId: factor.id, status: factor.status },
        );
      }

      factor.disable({
        code: command.code,
        secret: await this.vault.decrypt(envelope),
        now: this.clock.now(),
        totp: this.totp,
        policy: this.policy,
      });

      await this.uow.runInTransaction(() => this.factors.save(factor));
    } catch (error) {
      if (!isMfaDomainError(error)) throw error;
      await recordFailure(factor, error, {
        factors: this.factors,
        uow: this.uow,
        clock: this.clock,
        policy: this.policy,
      });
      throw toAppException(error);
    }
  }
}

@Injectable()
@CommandHandler(RegenerateRecoveryCodesCommand)
export class RegenerateRecoveryCodesHandler
  implements ICommandHandler<RegenerateRecoveryCodesCommand, RecoveryCodeBundle>
{
  constructor(
    @Inject(RECOVERY_CODE_SET_REPOSITORY) private readonly sets: RecoveryCodeSetRepositoryPort,
    @Inject(RECOVERY_CODES) private readonly codes: RecoveryCodePort,
    @Inject(MFA_UNIT_OF_WORK) private readonly uow: MfaUnitOfWork,
    @Inject(CLOCK) private readonly clock: IClock,
    @Inject(MFA_CONFIG) private readonly config: MfaConfig,
  ) {}

  /**
   * Issues a fresh set, invalidating whatever the user held before.
   *
   * @remarks The plaintext codes are returned exactly once. They are hashed with a fresh
   * per-set salt on the way through, so the stored rows are not merely obfuscated — they
   * cannot be turned back into usable codes by anyone with read access, which is the only
   * reason a *recovery* mechanism is acceptable to store at all.
   *
   * @remarks Not gated on possession of the second factor. The caller is inside an
   * authenticated session and this command cannot weaken it: it replaces codes with codes, and
   * it is the rotation a user performs precisely when they no longer trust the old set.
   */
  async execute(command: RegenerateRecoveryCodesCommand): Promise<RecoveryCodeBundle> {
    const now = this.clock.now();
    const count = Math.min(
      Math.max(command.count ?? this.config.recoveryCodeCount, MIN_RECOVERY_CODES),
      this.config.recoveryCodeCount,
    );

    const salt = this.codes.newSalt();
    const plaintext = this.codes.generate(count);
    const entries = plaintext.map((code) => ({
      code,
      digest: this.codes.digest(code, salt),
      consumedAt: null,
    }));

    const existing = await this.sets.findByUser(command.userId);
    let set: RecoveryCodeSet;

    if (existing) {
      existing.rotate({ salt, entries, now });
      set = existing;
    } else {
      set = RecoveryCodeSet.issue({ userId: command.userId, salt, entries, now });
    }

    // `replace` deletes the previous generation before inserting this one, so every code the
    // user (or an attacker) photographed stops working the moment this commits.
    await this.uow.runInTransaction(() => this.sets.replace(set));

    return {
      codes: plaintext,
      count: plaintext.length,
      issuedAt: (existing?.issuedAt ?? now).toISOString(),
      regenerated: existing !== null,
    };
  }
}