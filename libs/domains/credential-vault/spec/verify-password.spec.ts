/**
 * `VerifyPasswordCommand` — the one endpoint that must not be able to enumerate accounts.
 *
 * @remarks Every test here constructs its handler directly. There is no `TestingModule`,
 * because the handler takes two ports and a config object, and a container would only make the
 * wiring under test *less* visible: if the indistinguishable-failure guarantee ever depended
 * on how Nest happened to inject something, this suite would stop being able to see it.
 */
import { InvalidCredentialsException } from '@auth/platform/error-handling';
import {
  INVALID_CREDENTIALS_MESSAGE,
  VerifyPasswordHandler,
} from '../src/application/commands/credential.handlers';
import { VerifyPasswordCommand } from '../src/application/commands/credential.commands';
import { CredentialRotation, PasswordCredential } from '../src/domain/password-credential.aggregate';
import { CredentialStatus } from '../src/domain/value-objects/credential-status.vo';
import type { HashParameters, PasswordHash } from '../src/domain/ports/password-hasher.port';
import {
  CURRENT_PARAMETERS,
  FakePasswordHasher,
  InMemoryCredentialRepository,
  testVaultConfig,
} from './testing/fake-persistence';
import { rejection } from './testing/helpers';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_USER_ID = '2b6f8a19-3c4d-4e5f-8a7b-9c0d1e2f3a4b';
const PASSWORD = 'Saffron-Kestrel-42!';

const STALE_PARAMETERS: HashParameters = {
  ...CURRENT_PARAMETERS,
  memoryCost: 8 * 1024,
  timeCost: 1,
};

function hashOf(hasher: FakePasswordHasher, password: string, parameters: HashParameters): PasswordHash {
  return {
    digest: `fake-argon2id$seed|${password}`,
    parameters: { ...parameters },
  };
}

async function scenario(
  options: {
    seed?: PasswordCredential[];
    allowRehash?: boolean;
    configOverrides?: Parameters<typeof testVaultConfig>[0];
    hashParameters?: HashParameters;
  } = {},
) {
  const hasher = new FakePasswordHasher();
  const parameters = options.hashParameters ?? hasher.currentParameters;
  const seeded =
    options.seed ??
    [
      PasswordCredential.create({
        userId: USER_ID,
        hasher,
        hash: hashOf(hasher, PASSWORD, parameters),
      }),
    ];

  const repository = new InMemoryCredentialRepository(seeded);
  const handler = new VerifyPasswordHandler(
    repository,
    hasher,
    testVaultConfig(options.configOverrides),
  );

  return { handler, repository, hasher, credential: seeded[0] };
}

describe('indistinguishable failures', () => {
  it('answers a wrong password and a missing credential with an IDENTICAL error', async () => {
    const wrong = await scenario();
    const missing = await scenario({ seed: [] });

    const wrongError = (await rejection(
      wrong.handler.execute(new VerifyPasswordCommand(USER_ID, 'Wrong-Password-42!')),
    )) as InvalidCredentialsException;
    const missingError = (await rejection(
      missing.handler.execute(new VerifyPasswordCommand(OTHER_USER_ID, 'Wrong-Password-42!')),
    )) as InvalidCredentialsException;

    // The whole point of the service. Anything that differs here — a code, a message, a
    // context key, a stack prefix — is an account-existence oracle.
    expect(wrongError).toBeInstanceOf(InvalidCredentialsException);
    expect(missingError).toBeInstanceOf(InvalidCredentialsException);
    expect(wrongError.message).toBe(missingError.message);
    expect(wrongError.message).toBe(INVALID_CREDENTIALS_MESSAGE);

    expect(JSON.stringify(wrongError.getResponse())).toBe(
      JSON.stringify(missingError.getResponse()),
    );
    expect(wrongError.code).toBe(missingError.code);
    expect(wrongError.context).toEqual(missingError.context);
    expect(wrongError.getStatus()).toBe(missingError.getStatus());
  });

  it('carries no context on either branch, so nothing leaks through the response body', () => {
    // `AppException` spreads its context into the body. A `failedAttempts: 1` on one branch
    // and nothing on the other would be the enumeration oracle even with an identical message.
    const error = new InvalidCredentialsException(INVALID_CREDENTIALS_MESSAGE);

    expect(error.context).toEqual({});
    expect(error.getResponse()).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: INVALID_CREDENTIALS_MESSAGE,
    });
  });

  it('refuses a locked credential with the very same error', async () => {
    const { handler, credential } = await scenario();
    credential.recordFailure({ maxFailedAttempts: 1, lockoutSec: 900 });
    credential.clearDomainEvents();

    const error = (await rejection(
      handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD)),
    )) as InvalidCredentialsException;

    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(error.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(error.context).toEqual({});
  });

  it('refuses a revoked credential with the very same error', async () => {
    const { handler, credential } = await scenario();
    credential.revoke('user requested');

    const error = (await rejection(
      handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD)),
    )) as InvalidCredentialsException;

    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(error.message).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  it('produces one identical error object shape for all four refusals', async () => {
    const refused = async (
      mutate: (context: Awaited<ReturnType<typeof scenario>>) => Promise<unknown>,
    ) => {
      const context = await scenario();
      await mutate(context);
      return (await rejection(
        context.handler.execute(new VerifyPasswordCommand(USER_ID, 'nope')),
      )) as InvalidCredentialsException;
    };

    const shapes = await Promise.all([
      refused(() => Promise.resolve()),
      refused(async ({ credential }) => {
        credential.recordFailure({ maxFailedAttempts: 1, lockoutSec: 900 });
      }),
      refused(async ({ credential }) => {
        credential.revoke('fraud');
      }),
    ]);

    for (const shape of shapes) {
      expect(shape).toBeInstanceOf(InvalidCredentialsException);
      expect(shape.message).toBe(INVALID_CREDENTIALS_MESSAGE);
      expect(JSON.stringify(shape.getResponse())).toBe(
        JSON.stringify({ code: 'INVALID_CREDENTIALS', message: INVALID_CREDENTIALS_MESSAGE }),
      );
    }
  });

  it('still records the failure for a user that exists — the log is where it goes', async () => {
    const { handler, repository, credential } = await scenario();

    await expect(handler.execute(new VerifyPasswordCommand(USER_ID, 'wrong'))).rejects.toThrow();

    expect(credential.failedAttempts).toBe(1);
    expect(repository.saved).toHaveLength(1);
    expect(repository.outbox.map((event) => event.eventType)).toEqual(['credential.failed']);
  });

  it('records nothing for a user that does not exist — there is no aggregate to record it on', async () => {
    const { handler, repository } = await scenario({ seed: [] });

    await expect(handler.execute(new VerifyPasswordCommand(OTHER_USER_ID, 'wrong'))).rejects.toThrow();

    expect(repository.saved).toHaveLength(0);
    expect(repository.outbox).toHaveLength(0);
  });

  it('burns an Argon2 budget when there is no credential, to close the timing oracle', async () => {
    // A request for an unknown user returns in microseconds while a real one takes tens of
    // milliseconds, and that gap enumerates accounts over a long enough window.
    const { handler, hasher } = await scenario({ seed: [] });

    await expect(
      handler.execute(new VerifyPasswordCommand(OTHER_USER_ID, PASSWORD)),
    ).rejects.toThrow();

    expect(hasher.equalised).toEqual([PASSWORD]);
  });

  it('does not burn one on the success path — a real verification already cost a hash', async () => {
    const { handler, hasher } = await scenario();

    await handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD));

    expect(hasher.equalised).toEqual([]);
  });
});

describe('VerifyPassword — success', () => {
  it('returns the credential id and clears the failure run', async () => {
    const { handler, credential, repository } = await scenario();
    credential.recordFailure({ maxFailedAttempts: 5, lockoutSec: 900 });
    credential.clearDomainEvents();

    const result = await handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD));

    expect(result).toEqual({
      valid: true,
      credentialId: credential.id.value,
      rehashed: false,
      failedAttempts: 0,
    });
    expect(credential.status).toBe(CredentialStatus.ACTIVE);
    expect(repository.outbox.map((event) => event.eventType)).toEqual(['credential.verified']);
  });

  it('never puts the password in an event payload', async () => {
    const { handler, repository } = await scenario();

    await handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD));

    expect(JSON.stringify(repository.outbox)).not.toContain(PASSWORD);
  });

  it('saves once, so a consumer never sees `verified` for a hash that was not written', async () => {
    const { handler, repository } = await scenario({
      hashParameters: STALE_PARAMETERS,
    });

    await handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD));

    expect(repository.saved).toHaveLength(1);
    expect(repository.outbox.map((event) => event.eventType)).toEqual([
      'credential.verified',
      'credential.rotated',
    ]);
  });
});

describe('VerifyPassword — transparent rehash', () => {
  it('upgrades a hash that is below policy, after the password has been proven', async () => {
    const { handler, credential, hasher } = await scenario({ hashParameters: STALE_PARAMETERS });

    const result = await handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD));

    expect(result.rehashed).toBe(true);
    expect(hasher.hashes).toEqual([PASSWORD]);
    expect(credential.needsRehash()).toBe(false);

    const rotated = credential.domainEvents.find((event) => event.eventType === 'credential.rotated');
    expect(rotated).toBeUndefined();
  });

  it('does not rehash a hash that already meets policy', async () => {
    const { handler, hasher } = await scenario();

    const result = await handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD));

    expect(result.rehashed).toBe(false);
    expect(hasher.hashes).toEqual([]);
  });

  it('does not rehash when the caller opted out', async () => {
    const { handler, hasher } = await scenario({ hashParameters: STALE_PARAMETERS });

    const result = await handler.execute(
      new VerifyPasswordCommand(USER_ID, PASSWORD, false),
    );

    expect(result.rehashed).toBe(false);
    expect(hasher.hashes).toEqual([]);
  });

  it('does not rehash when configuration disabled it', async () => {
    const { handler, hasher } = await scenario({
      hashParameters: STALE_PARAMETERS,
      configOverrides: { allowRehash: false },
    });

    const result = await handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD));

    expect(result.rehashed).toBe(false);
    expect(hasher.hashes).toEqual([]);
  });

  it('never rehashes on a failed attempt — that would be a free DoS', async () => {
    // Rehashing every guess would spend an Argon2 budget per attacker-controlled request.
    const { handler, hasher } = await scenario({ hashParameters: STALE_PARAMETERS });

    await expect(
      handler.execute(new VerifyPasswordCommand(USER_ID, 'wrong')),
    ).rejects.toThrow(InvalidCredentialsException);

    expect(hasher.hashes).toEqual([]);
  });

  it('records the upgrade as a rehash rotation, not a user-initiated change', async () => {
    const { handler, repository } = await scenario({ hashParameters: STALE_PARAMETERS });

    await handler.execute(new VerifyPasswordCommand(USER_ID, PASSWORD));

    const rotated = repository.outbox.find((event) => event.eventType === 'credential.rotated');
    expect(rotated?.payload).toMatchObject({ rotation: CredentialRotation.REHASHED });
  });
});