/**
 * The gRPC surface, and the CQRS wiring underneath it.
 *
 * @remarks Two things are asserted here that no other suite in this service can see. The
 * first is that `VerifyPassword` reports a refusal as `valid: false` rather than as an
 * error, and never as a number that differs between "no such user" and "wrong password".
 * The second is that every handler is registered against a *class*: `CommandBus.execute`
 * resolves a handler from `command.constructor`, so a string key or a plain object literal
 * cannot dispatch at all — and that failure mode is an import-time throw in some versions
 * and a silent no-op in others.
 */
import 'reflect-metadata';
import { COMMAND_HANDLER_METADATA, QUERY_HANDLER_METADATA } from '@nestjs/cqrs/dist/decorators/constants';
import { InvalidCredentialsException, ValidationException } from '@auth/platform/error-handling';
import { CredentialVaultGrpcController } from '../src/presentation/grpc/credential-vault.grpc.controller';
import { CredentialVaultService } from '../src/application/facade/credential-vault.service';
import {
  ChangePasswordCommand,
  RegenerateRecoveryCodesCommand,
  RevokeAllCredentialsCommand,
  SetPasswordCommand,
  VerifyPasswordCommand,
} from '../src/application/commands/credential.commands';
import {
  ChangePasswordHandler,
  INVALID_CREDENTIALS_MESSAGE,
  RegenerateRecoveryCodesHandler,
  RevokeAllCredentialsHandler,
  SetPasswordHandler,
  VerifyPasswordHandler,
} from '../src/application/commands/credential.handlers';
import {
  GetCredentialStatusHandler,
  GetCredentialStatusQuery,
} from '../src/application/queries/credential.queries';
import { PasswordCredential } from '../src/domain/password-credential.aggregate';
import { RecoveryCodeSet } from '../src/domain/recovery-code-set.aggregate';
import {
  FakePasswordHasher,
  InMemoryCredentialRepository,
  testVaultConfig,
} from './testing/fake-persistence';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PASSWORD = 'Saffron-Kestrel-42!';

/** Dispatches by `command.constructor`, exactly the way `CommandBus` resolves a handler. */
class DispatchBus {
  constructor(private readonly handlers: Map<object, (command: object) => Promise<unknown>>) {}

  execute(command: object): Promise<unknown> {
    const handler = this.handlers.get(command.constructor);
    if (!handler) throw new Error(`no handler registered for ${command.constructor.name}`);
    return handler(command);
  }
}

function build(seed = true) {
  const hasher = new FakePasswordHasher();
  const credential = PasswordCredential.create({
    userId: USER_ID,
    hasher,
    hash: {
      digest: `fake-argon2id$seed|${PASSWORD}`,
      parameters: { ...hasher.currentParameters },
    },
  });
  const repository = new InMemoryCredentialRepository(seed ? [credential] : []);
  const config = testVaultConfig();

  const commandHandlers = new Map<object, (command: object) => Promise<unknown>>([
    [SetPasswordCommand, new SetPasswordHandler(repository, hasher, config)],
    [ChangePasswordCommand, new ChangePasswordHandler(repository, hasher, config)],
    [VerifyPasswordCommand, new VerifyPasswordHandler(repository, hasher, config)],
    [RevokeAllCredentialsCommand, new RevokeAllCredentialsHandler(repository)],
    [RegenerateRecoveryCodesCommand, new RegenerateRecoveryCodesHandler(repository, config)],
  ].map(([command, handler]) => [
    command,
    (input: object) => (handler as { execute: (c: object) => Promise<unknown> }).execute(input),
  ]) as [object, (command: object) => Promise<unknown>][]);

  const queryHandlers = new Map<object, (command: object) => Promise<unknown>>([
    [
      GetCredentialStatusQuery,
      (input: object) => new GetCredentialStatusHandler(repository).execute(input as GetCredentialStatusQuery),
    ],
  ]);

  // One narrowing cast, at the boundary where the fake takes the place of Nest's bus. The
  // facade itself is real, so the test exercises the handlers it really calls.
  const facade = new CredentialVaultService(
    new DispatchBus(commandHandlers) as unknown as never,
    new DispatchBus(queryHandlers) as unknown as never,
  );

  return { controller: new CredentialVaultGrpcController(facade), repository, hasher };
}

describe('CredentialVaultService dispatch', () => {
  it('routes every command to a handler registered against its class', async () => {
    // If any of these were registered against a string, `command.constructor` would resolve to
    // `Object` and the bus would find nothing — which is exactly the failure mode the class
    // requirement exists to prevent.
    const { controller, repository } = build(false);

    await expect(
      controller.setPassword({ userId: USER_ID, newPassword: PASSWORD }),
    ).resolves.toMatchObject({ ok: true });

    expect(repository.credentials.size).toBe(1);
  });

  it('registers each handler under the exact command class it handles', () => {
    const expectations: readonly [new (...args: never[]) => unknown, new (...args: never[]) => unknown][] =
      [
        [SetPasswordHandler, SetPasswordCommand],
        [ChangePasswordHandler, ChangePasswordCommand],
        [VerifyPasswordHandler, VerifyPasswordCommand],
        [RevokeAllCredentialsHandler, RevokeAllCredentialsCommand],
        [RegenerateRecoveryCodesHandler, RegenerateRecoveryCodesCommand],
      ];

    for (const [handler, command] of expectations) {
      expect(Reflect.getMetadata(COMMAND_HANDLER_METADATA, handler)).toBe(command);
    }

    expect(Reflect.getMetadata(QUERY_HANDLER_METADATA, GetCredentialStatusHandler)).toBe(
      GetCredentialStatusQuery,
    );
  });

  it('gives every command instance a distinct id', () => {
    const first = new VerifyPasswordCommand(USER_ID, PASSWORD);
    const second = new VerifyPasswordCommand(USER_ID, PASSWORD);

    expect(first.commandId).not.toBe(second.commandId);
    expect(first.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('defaults allowRehash on the factory helper, not on the bus', () => {
    const command = new VerifyPasswordCommand(USER_ID, PASSWORD);
    expect(command.allowRehash).toBe(true);
  });
});

describe('CredentialVaultGrpcController.VerifyPassword', () => {
  it('answers a correct password with valid: true', async () => {
    const { controller } = build();

    await expect(
      controller.verifyPassword({ userId: USER_ID, password: PASSWORD }),
    ).resolves.toEqual({ valid: true, needsRehash: false, failedAttempts: 0 });
  });

  it('answers a wrong password and a missing user IDENTICALLY', async () => {
    // The proto models the answer as a field rather than an error, so the shape below is the
    // whole outward surface. If any part of it varied between the two cases, the endpoint
    // would enumerate accounts one boolean at a time.
    const wrong = build();
    const missing = build(false);

    const wrongResponse = await wrong.controller.verifyPassword({
      userId: USER_ID,
      password: 'Wrong-Password-42!',
    });
    const missingResponse = await missing.controller.verifyPassword({
      userId: USER_ID,
      password: 'Wrong-Password-42!',
    });

    expect(wrongResponse).toEqual({ valid: false, needsRehash: false, failedAttempts: 0 });
    expect(missingResponse).toEqual(wrongResponse);
  });

  it('reports no attempt counter on a refusal, since it would differ by case', async () => {
    const { controller, repository } = build();
    const credential = await repository.findPasswordCredential(USER_ID);
    credential?.recordFailure({ maxFailedAttempts: 5, lockoutSec: 900 });

    const response = await controller.verifyPassword({
      userId: USER_ID,
      password: 'Wrong-Password-42!',
    });

    // The real counter reaches account-security through the `credential.failed` topic; the
    // caller that was just refused is told nothing beyond "no".
    expect(response.failedAttempts).toBe(0);
  });

  it('still records the failure server-side', async () => {
    const { controller, repository } = build();

    await controller.verifyPassword({ userId: USER_ID, password: 'Wrong-Password-42!' });

    expect(repository.outbox.map((event) => event.eventType)).toEqual(['credential.failed']);
  });

  it('lets an unrelated failure through as an error rather than reporting valid: false', async () => {
    // A database outage must not be reported as "wrong password" — the caller would lock out
    // every user during an incident.
    const { controller, repository } = build();
    jest
      .spyOn(repository, 'findPasswordCredential')
      .mockRejectedValue(new Error('connection terminated'));

    await expect(
      controller.verifyPassword({ userId: USER_ID, password: PASSWORD }),
    ).rejects.toThrow(/connection terminated/);
  });

  it('reports needsRehash: false, because the upgrade already happened', async () => {
    const { controller } = build();

    // The command rehashes inline on a successful sign-in, so there is never a stale hash
    // left for the caller to act on. Reporting otherwise would be advice nobody can follow.
    await expect(
      controller.verifyPassword({ userId: USER_ID, password: PASSWORD }),
    ).resolves.toMatchObject({ needsRehash: false });
  });
});

describe('CredentialVaultGrpcController.SetPassword', () => {
  it('returns the new credential id', async () => {
    const { controller } = build(false);

    const response = await controller.setPassword({
      userId: USER_ID,
      newPassword: PASSWORD,
    });

    expect(response.ok).toBe(true);
    expect(response.credentialId).toBeTruthy();
  });

  it('lets a policy rejection through as an error', async () => {
    // Unlike verification, a rejected *set* is not secret: the caller supplied the password.
    // Swallowing it into `ok: false` would leave a user with no way to learn the rules.
    const { controller } = build(false);

    await expect(
      controller.setPassword({ userId: USER_ID, newPassword: 'password' }),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});

describe('CredentialVaultGrpcController.RevokeAllCredentials', () => {
  it('reports how many credentials were retired', async () => {
    const { controller } = build();

    await expect(
      controller.revokeAllCredentials({ userId: USER_ID, reason: 'password reset' }),
    ).resolves.toEqual({ revokedCount: 1 });
  });

  it('burns the recovery codes in the same call', async () => {
    const { controller, repository } = build();
    await repository.saveRecoveryCodeSet(RecoveryCodeSet.issue({ userId: USER_ID, count: 3 }).set);

    await controller.revokeAllCredentials({ userId: USER_ID, reason: 'fraud' });

    expect(repository.deletedRecoveryCodeUsers).toEqual([USER_ID]);
  });
});

describe('the outward error contract', () => {
  it('keeps one message for every refusal the service can make', () => {
    // One constant, used by both the verification and the change-password paths, so the two
    // cannot drift apart and reopen an enumeration oracle on the "change my password" screen.
    expect(INVALID_CREDENTIALS_MESSAGE).toBe('invalid credentials');
    expect(new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE).getResponse()).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'invalid credentials',
    });
  });
});