/**
 * @fileoverview The only public surface of the account-security module.
 *
 * @remarks Controllers, gRPC handlers and other services depend on this class and nothing else,
 * so they cannot reach the repository, the Redis store or the scorer — which is what makes this
 * service's internals replaceable without touching a caller.
 *
 * @remarks Every method takes and returns plain data. The command and query classes are an
 * implementation detail of the bus: a caller that could construct one directly could bypass the
 * policy this facade exists to front.
 */
import { Injectable } from '@nestjs/common';
// Value import, not `import type`: these are constructor-injected, and
// `emitDecoratorMetadata` reads the emitted value binding to resolve them.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  LockAccountCommand,
  RecordLoginAttemptCommand,
  RevokeDeviceCommand,
  UnlockAccountCommand,
  type AttemptOutcome,
  type LoginAttemptInput,
} from '../commands/login-attempt.commands';
import {
  AssessRiskQuery,
  GetLoginHistoryQuery,
  ListDevicesQuery,
  type DeviceReadModel,
  type LoginHistoryPage,
  type RiskAssessmentReadModel,
} from '../queries/account-security.queries';

@Injectable()
export class AccountSecurityService {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Records one sign-in and reports what it looks like.
   *
   * @remarks Returns the lock state rather than enforcing it. auth-gateway is the entity that
   * refuses a login, and this service's whole value is that it can disagree with a refusal
   * rather than make one.
   *
   * @returns the outcome, including `securityEventId` — the `security_signals` row when the
   * attempt raised one, and the `login_history` row when nothing was wrong with it.
   */
  recordLoginAttempt(input: LoginAttemptInput, succeeded: boolean): Promise<AttemptOutcome> {
    return this.commandBus.execute<AttemptOutcome>(
      new RecordLoginAttemptCommand(succeeded, input),
    );
  }

  /**
   * Locks an account on an operator's say-so.
   *
   * @returns when the lock lifts. There is no "permanent" here: an operator can repeat the
   * command, and an account that cannot be un-locked is one this service should not offer.
   */
  lockAccount(input: {
    userId: string;
    reason: string;
    ipAddress?: string;
    deviceFingerprint?: string;
  }): Promise<{ lockedUntil: Date; reason: string }> {
    return this.commandBus.execute<{ lockedUntil: Date; reason: string }>(
      new LockAccountCommand(input.userId, input.reason, input.ipAddress, input.deviceFingerprint),
    );
  }

  /** Lifts a lock and forgets the run of failures behind it. Idempotent. */
  unlockAccount(input: { userId: string; reason?: string; ipAddress?: string }): Promise<{
    unlocked: boolean;
  }> {
    return this.commandBus.execute<{ unlocked: boolean }>(
      new UnlockAccountCommand(input.userId, input.reason, input.ipAddress),
    );
  }

  /**
   * Retires a device so the next login from it reads as a new one.
   *
   * @remarks Nothing is deleted. `login_history` is the evidence an incident review needs, and
   * "that is not my laptop" is not a request to erase the record of every sign-in from it.
   */
  revokeDevice(input: {
    userId: string;
    deviceId: string;
    reason?: string;
  }): Promise<{ ok: boolean; signalId: string }> {
    return this.commandBus.execute<{ ok: boolean; signalId: string }>(
      new RevokeDeviceCommand(input.userId, input.deviceId, input.reason),
    );
  }

  /** Every device an account has signed in from, newest first, revoked ones marked. */
  listDevices(userId: string): Promise<readonly DeviceReadModel[]> {
    return this.queryBus.execute<readonly DeviceReadModel[]>(new ListDevicesQuery(userId));
  }

  /** An account's logins, newest first. Says nothing about whether the account exists. */
  getLoginHistory(userId: string, limit?: number): Promise<LoginHistoryPage> {
    return this.queryBus.execute<LoginHistoryPage>(new GetLoginHistoryQuery(userId, limit));
  }

  /**
   * Scores a login that has not happened yet.
   *
   * @remarks Reads only. It never records, never moves a counter and never raises a signal, so
   * a caller may ask as often as it likes without altering the evidence.
   */
  assessRisk(input: LoginAttemptInput): Promise<RiskAssessmentReadModel> {
    return this.queryBus.execute<RiskAssessmentReadModel>(new AssessRiskQuery(input));
  }
}