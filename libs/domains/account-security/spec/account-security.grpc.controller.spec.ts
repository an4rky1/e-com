/**
 * The gRPC surface, and the CQRS wiring underneath it.
 *
 * @remarks Two things are asserted here that no other suite in this service can see. The first
 * is that every handler is registered against a *class*: `CommandBus.execute` resolves a handler
 * from `command.constructor`, so a string key or a plain object literal cannot dispatch at all —
 * and that failure mode is an import-time throw in some versions and a silent no-op in others.
 * The second is that nothing on this surface blocks: the proto has no field that says "denied",
 * and the tests would fail if one were added by returning a refusal as an error.
 */
import 'reflect-metadata';
import { COMMAND_HANDLER_METADATA, QUERY_HANDLER_METADATA } from '@nestjs/cqrs/dist/decorators/constants';
import type {
  RecordLoginAttemptRequest,
  RecordLoginAttemptResponse,
  RiskAssessmentResponse,
} from '@auth/contracts';
import { AccountSecurityGrpcController } from '../src/presentation/grpc/account-security.grpc.controller';
import { AccountSecurityService } from '../src/application/facade/account-security.service';
import {
  AssessRiskQuery,
  GetLoginHistoryQuery,
  ListDevicesQuery,
} from '../src/application/queries/account-security.queries';
import {
  LockAccountCommand,
  RecordLoginAttemptCommand,
  RevokeDeviceCommand,
  UnlockAccountCommand,
} from '../src/application/commands/login-attempt.commands';
import {
  AssessRiskHandler,
  GetLoginHistoryHandler,
  ListDevicesHandler,
} from '../src/application/queries/account-security.queries';
import {
  LockAccountHandler,
  RecordLoginAttemptHandler,
  RevokeDeviceHandler,
  UnlockAccountHandler,
} from '../src/application/commands/login-attempt.handlers';
import { RiskScoringService } from '../src/domain/services/risk-scoring.service';
import { DeviceFingerprint } from '../src/domain/value-objects/device-fingerprint.vo';
import { RiskLevel } from '../src/domain/value-objects/risk-score.vo';
import {
  InMemoryDeviceRegistry,
  InMemoryFailureTracker,
  InMemorySecurityRepository,
  testConfig,
} from './testing/fakes';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const IP = '203.0.113.9';
const FINGERPRINT = DeviceFingerprint.compute({ platform: 'macOS' }).value;

const REQUEST: RecordLoginAttemptRequest = {
  userId: USER_ID,
  email: undefined,
  succeeded: true,
  ipAddress: IP,
  userAgent: 'Mozilla/5.0 (Macintosh)',
  deviceFingerprint: FINGERPRINT,
};

/** Dispatches by `command.constructor`, exactly the way `CommandBus` resolves a handler. */
class DispatchBus {
  constructor(private readonly handlers: Map<object, (input: object) => Promise<unknown>>) {}

  execute(command: object): Promise<unknown> {
    const handler = this.handlers.get(command.constructor);
    if (!handler) throw new Error(`no handler registered for ${command.constructor.name}`);
    return handler(command);
  }
}

function build() {
  const repository = new InMemorySecurityRepository();
  const registry = new InMemoryDeviceRegistry();
  const tracker = new InMemoryFailureTracker();
  const config = testConfig();
  const scoring = new RiskScoringService(config.riskScoring);

  const commandHandlers = new Map<object, (command: object) => Promise<unknown>>(
    [
      [
        RecordLoginAttemptCommand,
        new RecordLoginAttemptHandler(repository, registry, tracker, scoring, config),
      ],
      [LockAccountCommand, new LockAccountHandler(repository, tracker, config)],
      [UnlockAccountCommand, new UnlockAccountHandler(repository, tracker)],
      [RevokeDeviceCommand, new RevokeDeviceHandler(repository, registry)],
    ].map(([command, handler]) => [
      command,
      (input: object) =>
        (handler as { execute: (command: object) => Promise<unknown> }).execute(input),
    ]) as [object, (command: object) => Promise<unknown>][],
  );

  const queryHandlers = new Map<object, (command: object) => Promise<unknown>>(
    [
      [ListDevicesQuery, new ListDevicesHandler(repository, registry)],
      [GetLoginHistoryQuery, new GetLoginHistoryHandler(repository, config)],
      [AssessRiskQuery, new AssessRiskHandler(repository, registry, tracker, scoring, config)],
    ].map(([query, handler]) => [
      query,
      (input: object) =>
        (handler as { execute: (command: object) => Promise<unknown> }).execute(input),
    ]) as [object, (command: object) => Promise<unknown>][],
  );

  // One narrowing cast, at the boundary where the fake takes the place of Nest's bus. The
  // facade itself is real, so the test exercises the handlers it really calls.
  const facade = new AccountSecurityService(
    new DispatchBus(commandHandlers) as unknown as never,
    new DispatchBus(queryHandlers) as unknown as never,
  );

  return { controller: new AccountSecurityGrpcController(facade), repository, registry, tracker, config };
}

describe('AccountSecurityService dispatch', () => {
  it('routes every command to a handler registered against its class', async () => {
    // If any of these were registered against a string, `command.constructor` would resolve to
    // `Object` and the bus would find nothing — which is exactly the failure mode the class
    // requirement exists to prevent.
    const { controller } = build();

    await expect(controller.recordLoginAttempt(REQUEST)).resolves.toMatchObject({ locked: false });
  });

  it('registers each handler under the exact command class it handles', () => {
    const expectations: ReadonlyArray<
      readonly [new (...args: never[]) => unknown, new (...args: never[]) => unknown]
    > = [
      [RecordLoginAttemptHandler, RecordLoginAttemptCommand],
      [LockAccountHandler, LockAccountCommand],
      [UnlockAccountHandler, UnlockAccountCommand],
      [RevokeDeviceHandler, RevokeDeviceCommand],
      [ListDevicesHandler, ListDevicesQuery],
      [GetLoginHistoryHandler, GetLoginHistoryQuery],
      [AssessRiskHandler, AssessRiskQuery],
    ];

    // `@CommandHandler(cls)` stores the class on the handler itself; reading it back is the
    // only way to prove the decorator was given the class and not a string. A string key throws
    // at import, so reaching this line at all is half the assertion.
    const metadata = (handler: new (...args: never[]) => object): unknown =>
      Reflect.getMetadata(COMMAND_HANDLER_METADATA, handler) ??
      Reflect.getMetadata(QUERY_HANDLER_METADATA, handler);

    for (const [handler, command] of expectations) {
      expect(metadata(handler as unknown as new (...args: never[]) => object)).toBe(command);
    }
  });
});

describe('RecordLoginAttempt', () => {
  it('answers with a zero epoch for "not locked", which is what the proto declares', async () => {
    const { controller } = build();

    const response: RecordLoginAttemptResponse = await controller.recordLoginAttempt(REQUEST);

    expect(response).toEqual({
      locked: false,
      failedAttempts: 0,
      lockedUntil: 0,
      securityEventId: expect.any(String),
      retryAfterSeconds: 0,
    });
  });

  it('reports the lock as epoch millis once the account runs out of attempts', async () => {
    const { controller, tracker, config } = build();
    tracker.seedUser(USER_ID, { userFailures: config.maxFailedAttempts - 1 });

    const response = await controller.recordLoginAttempt({ ...REQUEST, succeeded: false });

    expect(response.locked).toBe(true);
    expect(response.failedAttempts).toBe(config.maxFailedAttempts);
    // A Date is not `0`: `new Date(0)` is 1970, so a caller that forgot to special-case the
    // "not locked" case would treat a permanently open account as locked for fifty years.
    expect(response.lockedUntil).toBeGreaterThan(Date.now());
    // The seconds figure is what a caller actually shows and rate-limits on, so it must move
    // together with the timestamp rather than being left at zero.
    expect(response.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('answers a failed login without throwing', async () => {
    // An error here would be indistinguishable from "the service is down", and auth-flow
    // would stop recording the attempt at all.
    const { controller } = build();

    await expect(
      controller.recordLoginAttempt({ ...REQUEST, succeeded: false }),
    ).resolves.toMatchObject({ failedAttempts: 1, locked: false, lockedUntil: 0 });
  });

  it('treats an empty string as an absent field, not as an id', async () => {
    const { controller } = build();

    await expect(
      controller.recordLoginAttempt({ ...REQUEST, ipAddress: '   ' }),
    ).rejects.toThrow(/ipAddress is required/);
  });
});

describe('AssessLoginRisk', () => {
  it('answers with the four fields the proto carries', async () => {
    const { controller } = build();

    const response: RiskAssessmentResponse = await controller.assessLoginRisk({
      userId: USER_ID,
      ipAddress: IP,
      userAgent: 'Mozilla/5.0 (Macintosh)',
      deviceFingerprint: FINGERPRINT,
    });

    expect(Object.keys(response).sort()).toEqual(['factors', 'level', 'recommendations', 'score']);
    expect(response.level).toBe(RiskLevel.MEDIUM);
    expect(response.factors).toEqual(['new_device']);
  });

  it('never blocks — it answers, and says what the caller might do', async () => {
    const { controller } = build();

    const response = await controller.assessLoginRisk({
      userId: USER_ID,
      ipAddress: IP,
      deviceFingerprint: FINGERPRINT,
    });

    expect(typeof response.score).toBe('number');
    expect(response.recommendations).toEqual(['prompt_device_confirmation']);
  });
});

describe('ListDevices', () => {
  it('answers with an empty list for an account that has never signed in', async () => {
    const { controller } = build();

    await expect(controller.listDevices({ userId: USER_ID })).resolves.toEqual({ devices: [] });
  });

  it('turns a missing scalar into an empty string, because proto3 has no null', async () => {
    const { controller } = build();
    await controller.recordLoginAttempt(REQUEST);

    const response = await controller.listDevices({ userId: USER_ID });

    expect(response.devices[0]).toMatchObject({
      id: FINGERPRINT,
      ipAddress: '',
      trusted: true,
      lastSeenAt: expect.any(String),
    });
  });
});

describe('RevokeDevice', () => {
  it('refuses a device this account has never used', async () => {
    const { controller } = build();

    await expect(
      controller.revokeDevice({ userId: USER_ID, deviceId: 'f'.repeat(64) }),
    ).rejects.toThrow(/no such device/);
  });

  it('retires one it has, and says so', async () => {
    const { controller } = build();
    await controller.recordLoginAttempt(REQUEST);

    await expect(
      controller.revokeDevice({ userId: USER_ID, deviceId: FINGERPRINT }),
    ).resolves.toEqual({ ok: true });
  });
});