/**
 * @fileoverview Handlers for the commands that change what this service knows.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer.
 *
 * @remarks Every handler here resolves ports, never adapters. Where the work touches Prisma or
 * Redis it does so through an interface the domain declared, which is the only reason the rules
 * in `domain/` can be tested by calling them.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import type { AccountSecurityConfig } from '../../account-security.config';
import { ACCOUNT_SECURITY_CONFIG } from '../../account-security.config';
import { LoginAttempt, type LockoutPolicy } from '../../domain/login-attempt.aggregate';
import { SecuritySignal } from '../../domain/security-signal.aggregate';
import {
  DEVICE_REGISTRY,
  SECURITY_REPOSITORY,
  type DeviceRegistryPort,
  type SecurityRepositoryPort,
} from '../../domain/ports/security-repository.port';
import { FAILURE_TRACKER, type FailureTrackerPort } from '../../domain/ports/failure-tracker.port';
import { RISK_SCORING, type RiskScoringPort } from '../../domain/ports/risk-scoring.port';
import { DeviceFingerprint, type DeviceSignals } from '../../domain/value-objects/device-fingerprint.vo';
import type { GeoLocation } from '../../domain/value-objects/geo-location.vo';
import { RiskLevel, RiskScore, RISK_SCORE_MAX } from '../../domain/value-objects/risk-score.vo';
import { SecuritySignalType } from '../../domain/value-objects/security-signal-type.vo';
import type { FailureScope } from '../../domain/value-objects/failure-counters.vo';
import { toFingerprint, toLocation } from '../queries/risk-assessment.read-model';
import {
  LockAccountCommand,
  RecordLoginAttemptCommand,
  RevokeDeviceCommand,
  UnlockAccountCommand,
  type AttemptOutcome,
} from './login-attempt.commands';

/**
 * The score an operator-driven lock is recorded at.
 *
 * @remarks 100, because `security_signals.risk_score` is `NOT NULL` and a lock is the most
 * severe state this service can put an account in. The score column means "how alarming was
 * this", and an operator deciding to lock someone is the loudest possible answer to it.
 */
const MANUAL_LOCK_SCORE = RiskScore.create(RISK_SCORE_MAX);

/** A revocation is a defence, not a detection: the score describes the login, and there was none. */
const DEFENSIVE_SCORE = RiskScore.zero();

/** The fingerprint used for a command that arrived without one — an operator lock, not a device. */
const MANUAL_FINGERPRINT = DeviceFingerprint.fromValue('manual');

// ---- RecordLoginAttempt ----------------------------------------------------------

@Injectable()
@CommandHandler(RecordLoginAttemptCommand)
export class RecordLoginAttemptHandler
  implements ICommandHandler<RecordLoginAttemptCommand, AttemptOutcome>
{
  private readonly logger = new Logger(RecordLoginAttemptHandler.name);

  constructor(
    @Inject(SECURITY_REPOSITORY) private readonly repository: SecurityRepositoryPort,
    @Inject(DEVICE_REGISTRY) private readonly registry: DeviceRegistryPort,
    @Inject(FAILURE_TRACKER) private readonly tracker: FailureTrackerPort,
    @Inject(RISK_SCORING) private readonly scoring: RiskScoringPort,
    @Inject(ACCOUNT_SECURITY_CONFIG) private readonly config: AccountSecurityConfig,
  ) {}

  /**
   * Records one sign-in: scores it, moves the counters, and raises whatever signals it earned.
   *
   * @remarks The read model this assembles is deliberately *everything the caller knows* and
   * nothing it does not: it reports the lock and the score and lets auth-flow decide. The
   * service refuses nothing, because the one thing it cannot see — whether the person on the
   * other end is the account's owner — is the thing a block would hinge on.
   *
   * @remarks Order matters. The counters are saved *after* the durable write, so a database
   * that is down costs a counter update rather than a login that was recorded as successful and
   * never announced.
   */
  async execute(command: RecordLoginAttemptCommand): Promise<AttemptOutcome> {
    const now = new Date();
    const input = command.input;
    const userId = input.userId?.trim() || null;

    const ipAddress = input.ipAddress?.trim();
    if (!ipAddress) {
      // The per-ip counter is half the value of recording an attempt; without an address the
      // only thing left to store is a row nobody will read.
      throw new ValidationException('ipAddress is required to record a login attempt');
    }

    const fingerprint = toFingerprint(input);
    const location = toLocation(input);
    const scope: FailureScope = { userId, ipAddress };
    const counters = await this.tracker.load(scope);

    const attempt = LoginAttempt.create({
      userId,
      ipAddress,
      fingerprint,
      location,
      sessionId: input.sessionId ?? null,
      counters,
      now,
    });

    // Everything the score needs, gathered before the attempt is applied so a slow read cannot
    // make the `occurred_at` on the row disagree with the moment it was judged.
    const knownDevice =
      userId === null ? false : await this.registry.isKnown(userId, fingerprint.value);
    const previous =
      userId === null ? null : await this.repository.lastSeenElsewhere(userId, fingerprint.value);
    const usualHours =
      userId === null
        ? []
        : await this.repository.recentLoginHours(userId, this.config.riskScoring.usualHourSampleSize);

    const assessment = this.scoring.assess({
      fingerprint,
      knownDevice,
      location,
      previousLocation: previous?.location ?? null,
      failedAttempts: counters.userFailures,
      ipFailureCount: counters.ipFailures,
      hourOfDay: now.getUTCHours(),
      usualHours,
    });

    if (command.succeeded) {
      attempt.recordSuccess(now);
    } else {
      attempt.recordFailure(this.lockoutPolicy(), now);
    }

    const signals = this.raiseSignals({
      userId,
      attempt,
      succeeded: command.succeeded,
      knownDevice,
      fingerprint,
      device: input.device ?? null,
      location,
      previous,
      score: assessment.score,
      factors: assessment.factors.map((factor) => factor.factor),
    });

    await this.repository.saveAttempt(attempt, signals);
    await this.tracker.save(scope, attempt.counters);

    // Only after the login is durable: a device remembered for a login that was not written
    // would suppress the `new_device_detected` signal for the real owner.
    if (command.succeeded && userId !== null && !knownDevice) {
      await this.registry.remember(userId, fingerprint.value);
    }

    const after = attempt.counters;
    const locked = attempt.isLocked(now);
    const securityEventId = signals[0]?.id ?? attempt.toRow()?.login_id ?? attempt.id;

    return {
      loginId: attempt.toRow()?.login_id ?? null,
      succeeded: command.succeeded,
      locked,
      lockedUntil: locked ? after.lockedUntil : null,
      retryAfterSeconds: attempt.retryAfterSeconds(now),
      failedAttempts: after.userFailures,
      ipFailedAttempts: after.ipFailures,
      riskScore: assessment.score.value,
      riskLevel: assessment.score.level,
      riskFactors: assessment.factors.map((factor) => factor.factor),
      signalIds: signals.map((signal) => signal.id),
      securityEventId,
    };
  }

  /**
   * Turns an assessed attempt into the signals it earned.
   *
   * @remarks A failed login for a known user always raises one. It is the same trade
   * credential-vault makes with `credential.failed`: a failed sign-in is the event a rate
   * limiter, a notification rule and an audit screen are all built on, and storing it without
   * announcing it would make it invisible to every one of them.
   *
   * @remarks A successful login on a device that is new raises `new_device_detected`, because
   * a new device that *signed in* is the only version of that fact that matters — the failed
   * attempts leading up to it are already recorded as anomalies.
   *
   * @remarks `suspicious_login_detected` starts at `high`, not at `notifyAt`. A login scoring
   * `medium` gets a second factor from the `stepUpAt` recommendation on the assessment itself;
   * a persisted signal is for something a human should look at later.
   */
  private raiseSignals(input: {
    userId: string | null;
    attempt: LoginAttempt;
    succeeded: boolean;
    knownDevice: boolean;
    fingerprint: DeviceFingerprint;
    device: DeviceSignals | null;
    location: GeoLocation | null;
    previous: { location: GeoLocation; occurredAt: Date } | null;
    score: RiskScore;
    factors: readonly string[];
  }): SecuritySignal[] {
    const {
      userId,
      attempt,
      succeeded,
      knownDevice,
      fingerprint,
      device,
      location,
      previous,
      score,
      factors,
    } = input;
    if (userId === null) return [];

    const now = attempt.occurredAt;
    const base = {
      userId,
      score,
      factors,
      ipAddress: attempt.ipAddress,
      deviceFingerprint: fingerprint.value,
      now,
    };

    const signals: SecuritySignal[] = [];

    if (!succeeded) {
      signals.push(
        SecuritySignal.create({
          ...base,
          type: SecuritySignalType.ANOMALY_DETECTED,
          details: {
            outcome: 'failed',
            failedAttempts: attempt.counters.userFailures,
            ipFailedAttempts: attempt.counters.ipFailures,
            locked: attempt.isLocked(now),
            lockedUntil: attempt.lockedUntil?.toISOString() ?? null,
            level: score.level,
            country: location?.country ?? null,
          },
        }),
      );
    }

    if (succeeded && !knownDevice) {
      signals.push(
        SecuritySignal.create({
          ...base,
          type: SecuritySignalType.NEW_DEVICE_DETECTED,
          details: {
            outcome: 'succeeded',
            firstSeenAt: now.toISOString(),
            country: location?.country ?? null,
            previousCountry: previous?.location.country ?? null,
            // The raw signals ride on this one row. `login_history` stores a digest on purpose,
            // so this is the only place they are ever written down, and `ListDevices` reads
            // them back to give a device a name a person can recognise.
            ...(device ?? {}),
          },
        }),
      );
    }

    if (
      succeeded &&
      (score.level === RiskLevel.HIGH || score.level === RiskLevel.CRITICAL)
    ) {
      signals.push(
        SecuritySignal.create({
          ...base,
          type: SecuritySignalType.SUSPICIOUS_LOGIN_DETECTED,
          details: {
            outcome: 'succeeded',
            // The distance is what a human reads first when triaging this signal, so it is
            // stored rather than left to be recomputed from two other tables.
            distanceKm:
              location && previous ? Math.round(location.distanceToKm(previous.location)) : null,
            previousOccurredAt: previous?.occurredAt.toISOString() ?? null,
          },
        }),
      );
    }

    return signals;
  }

  private lockoutPolicy(): LockoutPolicy {
    return {
      maxFailedAttempts: this.config.maxFailedAttempts,
      maxIpFailedAttempts: this.config.maxIpFailedAttempts,
      lockoutSec: this.config.lockoutSec,
    };
  }
}

// ---- LockAccount -----------------------------------------------------------------

@Injectable()
@CommandHandler(LockAccountCommand)
export class LockAccountHandler
  implements ICommandHandler<LockAccountCommand, { lockedUntil: Date; reason: string }>
{
  private readonly logger = new Logger(LockAccountHandler.name);

  constructor(
    @Inject(SECURITY_REPOSITORY) private readonly repository: SecurityRepositoryPort,
    @Inject(FAILURE_TRACKER) private readonly tracker: FailureTrackerPort,
    @Inject(ACCOUNT_SECURITY_CONFIG) private readonly config: AccountSecurityConfig,
  ) {}

  /**
   * Locks an account until somebody says otherwise.
   *
   * @remarks A manual lock *replaces* the automatic expiry with a fresh one rather than
   * keeping the shorter of the two. An operator who locks an account under investigation means
   * "not until I have looked", and honouring a stale automatic expiry would unlock it out from
   * under them an hour later with nobody watching.
   */
  async execute(
    command: LockAccountCommand,
  ): Promise<{ lockedUntil: Date; reason: string }> {
    const now = new Date();
    const ipAddress = command.ipAddress?.trim() || 'unknown';

    const counters = await this.tracker.load({ userId: command.userId, ipAddress });
    const attempt = LoginAttempt.create({
      userId: command.userId,
      ipAddress,
      fingerprint: command.deviceFingerprint
        ? DeviceFingerprint.fromValue(command.deviceFingerprint)
        : MANUAL_FINGERPRINT,
      counters,
      now,
    });

    attempt.lock(command.reason, this.lockoutPolicy(), now);

    const signal = SecuritySignal.create({
      userId: command.userId,
      type: SecuritySignalType.ANOMALY_DETECTED,
      score: MANUAL_LOCK_SCORE,
      ipAddress: command.ipAddress ?? null,
      deviceFingerprint: attempt.fingerprint.value,
      factors: [],
      details: {
        action: 'account_locked',
        reason: command.reason,
        lockedUntil: attempt.lockedUntil?.toISOString() ?? null,
      },
      now,
    });

    await this.repository.saveSignals([signal]);
    await this.tracker.save({ userId: command.userId, ipAddress }, attempt.counters);

    this.logger.warn(`account ${command.userId} locked: ${command.reason}`);

    return { lockedUntil: attempt.lockedUntil as Date, reason: command.reason };
  }

  private lockoutPolicy(): LockoutPolicy {
    return {
      maxFailedAttempts: this.config.maxFailedAttempts,
      maxIpFailedAttempts: this.config.maxIpFailedAttempts,
      lockoutSec: this.config.lockoutSec,
    };
  }
}

// ---- UnlockAccount ---------------------------------------------------------------

@Injectable()
@CommandHandler(UnlockAccountCommand)
export class UnlockAccountHandler
  implements ICommandHandler<UnlockAccountCommand, { unlocked: boolean }>
{
  private readonly logger = new Logger(UnlockAccountHandler.name);

  constructor(
    @Inject(SECURITY_REPOSITORY) private readonly repository: SecurityRepositoryPort,
    @Inject(FAILURE_TRACKER) private readonly tracker: FailureTrackerPort,
  ) {}

  /**
   * Lifts a lock and forgets the run of failures behind it.
   *
   * @remarks Idempotent: unlocking an account that is not locked succeeds and writes one
   * `account_locked`-shaped signal, because "a support agent tried to unlock this" is itself
   * worth having in the record and a retry after a timeout must not fail.
   */
  async execute(command: UnlockAccountCommand): Promise<{ unlocked: boolean }> {
    const now = new Date();
    const ipAddress = command.ipAddress?.trim() || 'unknown';

    const counters = await this.tracker.load({ userId: command.userId, ipAddress });
    const attempt = LoginAttempt.create({
      userId: command.userId,
      ipAddress,
      fingerprint: MANUAL_FINGERPRINT,
      counters,
      now,
    });

    const wasLocked = attempt.isLocked(now) || counters.userFailures > 0;
    attempt.unlock(now, command.reason);

    const signal = SecuritySignal.create({
      userId: command.userId,
      type: SecuritySignalType.ANOMALY_DETECTED,
      score: DEFENSIVE_SCORE,
      ipAddress: command.ipAddress ?? null,
      factors: [],
      details: {
        action: 'account_unlocked',
        reason: command.reason,
        wasLocked,
      },
      now,
    });

    await this.repository.saveSignals([signal]);
    // Both counters, not just the lock: leaving the ip counter at its threshold would re-lock
    // the account on the very next mistyped password, which is the opposite of what the
    // operator asked for.
    await this.tracker.clear({ userId: command.userId, ipAddress: command.ipAddress ?? null });

    this.logger.log(`account ${command.userId} unlocked: ${command.reason}`);

    return { unlocked: true };
  }
}

// ---- RevokeDevice ----------------------------------------------------------------

@Injectable()
@CommandHandler(RevokeDeviceCommand)
export class RevokeDeviceHandler
  implements ICommandHandler<RevokeDeviceCommand, { ok: boolean; signalId: string }>
{
  private readonly logger = new Logger(RevokeDeviceHandler.name);

  constructor(
    @Inject(SECURITY_REPOSITORY) private readonly repository: SecurityRepositoryPort,
    @Inject(DEVICE_REGISTRY) private readonly registry: DeviceRegistryPort,
  ) {}

  /**
   * Retires a device so the next login from it reads as a new one.
   *
   * @remarks Does not delete anything. `login_history` is the evidence an incident review
   * needs, and a user who says "that is not my laptop" has not asked for the record of their
   * own sign-ins to disappear. Revocation withdraws trust; it does not erase the past.
   *
   * @remarks Raises a signal even though nothing was detected, because the revocation has to be
   * visible: a support agent who retired a device and a device that reappeared on its own
   * produce the same absence of evidence otherwise.
   */
  async execute(command: RevokeDeviceCommand): Promise<{ ok: boolean; signalId: string }> {
    const fingerprint = DeviceFingerprint.fromValue(command.deviceId);
    const devices = await this.repository.listDevices(command.userId);

    // Checked against the durable history rather than the cache, which a flush could empty and
    // turn into "no such device" for a device that demonstrably exists.
    const known = devices.some((device) => device.fingerprint === fingerprint.value);
    if (!known) {
      throw new ResourceNotFoundException('no such device for this user', {
        deviceId: fingerprint.value.slice(0, 16),
      });
    }

    await this.registry.revoke(command.userId, fingerprint.value);

    const signal = SecuritySignal.create({
      userId: command.userId,
      type: SecuritySignalType.ANOMALY_DETECTED,
      score: DEFENSIVE_SCORE,
      deviceFingerprint: fingerprint.value,
      factors: [],
      details: { action: 'device_revoked', reason: command.reason },
    });

    await this.repository.saveSignals([signal]);

    this.logger.log(`device ${fingerprint.value.slice(0, 16)} revoked for ${command.userId}`);

    return { ok: true, signalId: signal.id };
  }
}