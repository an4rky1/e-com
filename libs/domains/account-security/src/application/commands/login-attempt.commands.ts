/**
 * @fileoverview The commands that change what this service knows.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a gRPC
 * field never reaches the domain.
 *
 * @remarks A class, not an interface. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off whatever it is given. A
 * plain object therefore cannot dispatch at all, and `@CommandHandler('Name')` throws at import
 * because `Reflect.hasOwnMetadata` rejects a non-object.
 */
import { Command } from '@nestjs/cqrs';
import type { DeviceSignals } from '../../domain/value-objects/device-fingerprint.vo';
import type { RiskLevel } from '../../domain/value-objects/risk-score.vo';

/**
 * What a recorded attempt produced.
 *
 * @remarks The shape `RecordLoginAttemptResponse` is built from, minus the transport names.
 * `locked` and `lockedUntil` are here as *advice*: the caller has to be the one that refuses,
 * and what this service owes it is the state it would refuse on.
 */
export interface AttemptOutcome {
  readonly loginId: string | null;
  readonly succeeded: boolean;
  readonly locked: boolean;
  readonly lockedUntil: Date | null;
  readonly retryAfterSeconds: number;
  readonly failedAttempts: number;
  readonly ipFailedAttempts: number;
  readonly riskScore: number;
  readonly riskLevel: RiskLevel;
  readonly riskFactors: readonly string[];
  /** Ids of the `security_signals` rows this attempt raised, newest first. */
  readonly signalIds: readonly string[];
  /** Id of the fact that records this attempt: a signal, or the login row when nothing was odd. */
  readonly securityEventId: string;
}

/** One sign-in, as the caller knows it. */
export interface LoginAttemptInput {
  readonly userId?: string | null;
  readonly email?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly sessionId?: string | null;
  readonly deviceFingerprint?: string | null;
  readonly device?: DeviceSignals | null;
  readonly country?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
}

export class RecordLoginAttemptCommand extends Command<AttemptOutcome> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly succeeded: boolean,
    readonly input: LoginAttemptInput = {},
  ) {
    super();
  }
}

/**
 * Locks an account on an operator's say-so.
 *
 * @remarks Separate from `RecordLoginAttemptCommand` because the two are different decisions.
 * A lockout is this service noticing a run of failures; this is a human saying so, and it has
 * to be a command somebody chose to send rather than a side effect of a failed sign-in.
 */
export class LockAccountCommand extends Command<{ lockedUntil: Date; reason: string }> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly reason: string,
    readonly ipAddress?: string | null,
    readonly deviceFingerprint?: string | null,
  ) {
    super();
  }
}

export class UnlockAccountCommand extends Command<{ unlocked: boolean }> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly reason = 'manual_unlock',
    readonly ipAddress?: string | null,
  ) {
    super();
  }
}

/** Retires a device: the next login from it is scored as a new one. */
export class RevokeDeviceCommand extends Command<{ ok: boolean; signalId: string }> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly deviceId: string,
    readonly reason = 'user_revoked_device',
  ) {
    super();
  }
}

export const toRecordLoginAttemptCommand = (input: LoginAttemptInput, succeeded: boolean) =>
  new RecordLoginAttemptCommand(succeeded, input);

export const toLockAccountCommand = (input: {
  userId: string;
  reason: string;
  ipAddress?: string;
  deviceFingerprint?: string;
}) => new LockAccountCommand(input.userId, input.reason, input.ipAddress, input.deviceFingerprint);

export const toUnlockAccountCommand = (input: { userId: string; reason?: string; ipAddress?: string }) =>
  new UnlockAccountCommand(input.userId, input.reason, input.ipAddress);

export const toRevokeDeviceCommand = (input: { userId: string; deviceId: string; reason?: string }) =>
  new RevokeDeviceCommand(input.userId, input.deviceId, input.reason);