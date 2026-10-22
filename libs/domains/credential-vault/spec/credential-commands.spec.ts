/**
 * The remaining commands, and the status query.
 *
 * @remarks What these tests share is a bias towards the *outbound* surface: what an event
 * carries, what a handler persists, and what a caller is allowed to read back. The domain
 * rules live in `password-credential.aggregate.spec.ts`; the point here is that the wiring
 * around them never widens what leaves the service.
 */
import { InvalidCredentialsException, ValidationException } from '@auth/platform/error-handling';
import {
  ChangePasswordHandler,
  RegenerateRecoveryCodesHandler,
  RevokeAllCredentialsHandler,
  SetPasswordHandler,
} from '../src/application/commands/credential.handlers';
import {
  ChangePasswordCommand,
  RegenerateRecoveryCodesCommand,
  RevokeAllCredentialsCommand,
  SetPasswordCommand,
} from '../src/application/commands/credential.commands';
import {
  GetCredentialStatusHandler,
  GetCredentialStatusQuery,
} from '../src/application/queries/credential.queries';
import { CredentialStatus } from '../src/domain/value-objects/credential-status.vo';
import { PasswordCredential } from '../src/domain/password-credential.aggregate';
import { RecoveryCodeSet } from '../src/domain/recovery-code-set.aggregate';
import type { PasswordHash } from '../src/domain/ports/password-hasher.port';
import {
  FakePasswordHasher,
  InMemoryCredentialRepository,
  testVaultConfig,
} from './testing/fake-persistence';
import { rejection } from './testing/helpers';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PASSWORD = 'Saffron-Kestrel-42!';
const NEW_PASSWORD = 'Tamarind-Lantern-73!';
const WEAK_PASSWORD = 'password';

/** Fails the test with a useful message rather than asserting on `undefined`. */
function stored<T>(source: Map<string, T>, key: string): T {
  const found = source.get(key);
  if (!found) throw new Error(`expected ${key} to be present`);
  return found;
}

function seedCredential(hasher: FakePasswordHasher, password = PASSWORD): PasswordCredential {
  const hash: PasswordHash = {
    digest: `fake-argon2id$seed|${password}`,
    parameters: { ...hasher.currentParameters },
  };
  return PasswordCredential.create({ userId: USER_ID, hasher, hash });
}

/**
 * A wired-up set of handlers over in-memory ports.
 *
 * @remarks `credential` is always defined. When `seed` is false it is simply *not* in the
 * repository, which is how the "this user holds nothing" scenarios are built without every
 * assertion having to narrow an optional first.
 */
function context(configOverrides?: Parameters<typeof testVaultConfig>[0], seed = true) {
  const hasher = new FakePasswordHasher();
  const credential = seedCredential(hasher);
  const repository = new InMemoryCredentialRepository(seed ? [credential] : []);
  const config = testVaultConfig(configOverrides);

  return {
    hasher,
    repository,
    config,
    credential,
    setPassword: new SetPasswordHandler(repository, hasher, config),
    changePassword: new ChangePasswordHandler(repository, hasher, config),
    revokeAll: new RevokeAllCredentialsHandler(repository),
    regenerate: new RegenerateRecoveryCodesHandler(repository, config),
    status: new GetCredentialStatusHandler(repository),
  };
}

describe('SetPasswordCommand', () => {
  it('creates the credential and announces a rotation', async () => {
    const { setPassword, repository } = context(undefined, false);

    const credentialId = await setPassword.execute(
      new SetPasswordCommand(USER_ID, PASSWORD),
    );

    expect(credentialId).toBeTruthy();
    expect(repository.credentials.get(credentialId)?.status).toBe(CredentialStatus.ACTIVE);
    expect(repository.outbox.map((event) => event.eventType)).toEqual(['credential.rotated']);
  });

  it('refuses a password the policy rejects, before anything is hashed', async () => {
    const { setPassword, hasher, repository } = context(undefined, false);

    // Hashing a weak password would spend an Argon2 budget storing something worth refusing.
    await expect(
      setPassword.execute(new SetPasswordCommand(USER_ID, WEAK_PASSWORD)),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(hasher.hashes).toEqual([]);
    expect(repository.saved).toHaveLength(0);
  });

  it('reports every policy violation in the exception context', async () => {
    const { setPassword } = context(undefined, false);

    const error = (await rejection(
      setPassword.execute(new SetPasswordCommand(USER_ID, 'abc')),
    )) as ValidationException;

    expect(error.context.violations).toEqual(
      expect.arrayContaining(['too_short', 'missing_uppercase', 'missing_digit', 'missing_symbol']),
    );
  });

  it('replaces an existing credential rather than adding a second live one', async () => {
    // Unseeded: this test is about what two consecutive sets do, and a fixture credential
    // with a different identifier would be a third thing entirely.
    const { setPassword, repository } = context(undefined, false);

    const first = await setPassword.execute(
      new SetPasswordCommand(USER_ID, NEW_PASSWORD),
    );
    const second = await setPassword.execute(
      new SetPasswordCommand(USER_ID, NEW_PASSWORD),
    );

    // Two live password credentials would mean two values that both authenticate, and
    // neither "change my password" nor revokeAll could describe what was meant. The lookup is
    // on (user, identifier) — the natural key the database's partial unique index enforces —
    // so a second set replaces the first rather than sitting beside it.
    expect(repository.credentials.size).toBe(1);
    expect([...repository.credentials.keys()]).toEqual([first]);
    expect(second).toBe(first);
  });

  it('falls back to the user id when no identifier is supplied', async () => {
    const { setPassword, repository } = context(undefined, false);

    const credentialId = await setPassword.execute(
      new SetPasswordCommand(USER_ID, PASSWORD, '   '),
    );

    // The identifier names the account, not the method — `method` already says "password".
    // Falling back to a method name wrote the literal "password" into a column with a partial
    // unique index on (lower(identifier), method), which rejected the second password ever
    // set anywhere in the platform. The user id is the stable key the vault can derive without
    // an email lookup it does not own.
    expect(repository.credentials.get(credentialId)?.identifier).toBe(USER_ID);
  });

  it('keeps a caller-supplied identifier', async () => {
    const { setPassword, repository } = context(undefined, false);

    const credentialId = await setPassword.execute(
      new SetPasswordCommand(USER_ID, PASSWORD, 'person@example.test'),
    );

    expect(repository.credentials.get(credentialId)?.identifier).toBe(
      'person@example.test',
    );
  });

  it('never puts the new password in an event payload', async () => {
    const { setPassword, repository } = context(undefined, false);

    await setPassword.execute(new SetPasswordCommand(USER_ID, PASSWORD));

    expect(JSON.stringify(repository.outbox)).not.toContain(PASSWORD);
  });
});

describe('ChangePasswordCommand', () => {
  it('rotates the secret for someone who can present the old one', async () => {
    const { changePassword, repository, credential } = context();

    await changePassword.execute(
      new ChangePasswordCommand(USER_ID, PASSWORD, NEW_PASSWORD),
    );

    expect(repository.credentials.get(credential.id.value)?.digest).toContain(NEW_PASSWORD);
    expect(repository.outbox.map((event) => event.eventType)).toEqual(['credential.rotated']);
  });

  it('refuses a wrong current password with the same error a sign-in would give', async () => {
    const { changePassword } = context();

    // A second account-enumeration oracle, opened by the "change my password" screen.
    const error = (await rejection(
      changePassword.execute(
        new ChangePasswordCommand(USER_ID, 'Wrong-Password-42!', NEW_PASSWORD),
      ),
    )) as InvalidCredentialsException;

    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(error.context).toEqual({});
  });

  it('refuses a user with no credential, identically', async () => {
    const { changePassword } = context(undefined, false);

    const error = (await rejection(
      changePassword.execute(new ChangePasswordCommand(USER_ID, PASSWORD, NEW_PASSWORD)),
    )) as InvalidCredentialsException;

    expect(error.message).toBe('invalid credentials');
  });

  it('counts a wrong current password as a failed attempt', async () => {
    const { changePassword, credential, repository } = context();

    await expect(
      changePassword.execute(new ChangePasswordCommand(USER_ID, 'nope', NEW_PASSWORD)),
    ).rejects.toThrow();

    expect(credential.failedAttempts).toBe(1);
    expect(repository.outbox.map((event) => event.eventType)).toEqual(['credential.failed']);
  });

  it('refuses a weak replacement without touching the stored secret', async () => {
    const { changePassword, credential } = context();
    const before = credential.digest;

    await expect(
      changePassword.execute(new ChangePasswordCommand(USER_ID, PASSWORD, WEAK_PASSWORD)),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(credential.digest).toBe(before);
  });
});

describe('RevokeAllCredentialsCommand', () => {
  it('revokes every credential and burns the recovery codes', async () => {
    const { revokeAll, repository } = context();
    await repository.saveRecoveryCodeSet(RecoveryCodeSet.issue({ userId: USER_ID, count: 3 }).set);

    const { revokedCount } = await revokeAll.execute(
      new RevokeAllCredentialsCommand(USER_ID, 'password reset'),
    );

    expect(revokedCount).toBe(1);
    // A recovery code is a bypass to the same account; leaving it alive would make this call
    // look like it worked when it did not.
    expect(repository.deletedRecoveryCodeUsers).toEqual([USER_ID]);
    expect([...repository.credentials.values()].every((c) => c.isRevoked())).toBe(true);
    expect(repository.outbox.at(-1)?.eventType).toBe('credential.revoked');
  });

  it('is a no-op for a user who holds nothing', async () => {
    const { revokeAll } = context(undefined, false);

    const { revokedCount } = await revokeAll.execute(
      new RevokeAllCredentialsCommand(USER_ID, 'password reset'),
    );

    expect(revokedCount).toBe(0);
  });

  it('records the reason on every revoked row', async () => {
    const { revokeAll, repository } = context();

    await revokeAll.execute(new RevokeAllCredentialsCommand(USER_ID, 'fraud'));

    expect([...repository.credentials.values()].map((c) => c.revokedReason)).toEqual(['fraud']);
  });
});

describe('RegenerateRecoveryCodesCommand', () => {
  it('issues a fresh set and returns the plaintext exactly once', async () => {
    const { regenerate, repository } = context(undefined, false);

    const result = await regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 4));

    expect(result.userId).toBe(USER_ID);
    expect(result.codes).toHaveLength(4);
    expect(new Set(result.codes).size).toBe(4);
    expect(repository.savedRecoveryCodeSets).toHaveLength(1);
  });

  it('stores digests only — the response is the one place a code is readable', async () => {
    const { regenerate, repository } = context(undefined, false);

    const result = await regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));

    const rows = repository.savedRecoveryCodeSets[0].toRows();
    expect(rows.map((row) => row.code_digest)).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toContain(result.codes[0].replace(/-/g, ''));
  });

  it('invalidates the previous set, so an old sheet stops working', async () => {
    const { regenerate, repository } = context(undefined, false);
    const first = await regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));
    const storedFirst = stored(repository.recoveryCodeSets, USER_ID);

    const second = await regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));

    for (const old of first.codes) {
      expect(storedFirst.consume(old)).toBeNull();
    }
    expect(stored(repository.recoveryCodeSets, USER_ID).consume(second.codes[0])).toBe(0);
  });

  it('announces each regeneration without carrying a code', async () => {
    const { regenerate, repository } = context(undefined, false);

    const result = await regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));
    await regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));

    expect(repository.outbox.map((event) => event.eventType)).toEqual([
      'credential.recovery_codes_regenerated',
      'credential.recovery_codes_regenerated',
    ]);
    expect(JSON.stringify(repository.outbox)).not.toContain(result.codes[0]);
  });

  it('refuses a count that came from nowhere sane', async () => {
    const { regenerate } = context(undefined, false);

    await expect(
      regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 10_000)),
    ).rejects.toBeInstanceOf(ValidationException);
  });
});

describe('GetCredentialStatusQuery', () => {
  it('summarises a live credential without leaking the digest', async () => {
    const { status, credential } = context();

    const result = await status.execute(new GetCredentialStatusQuery(USER_ID));

    expect(result).toMatchObject({
      userId: USER_ID,
      hasCredential: true,
      credentialId: credential.id.value,
      status: CredentialStatus.ACTIVE,
      failedAttempts: 0,
      locked: false,
      recoveryCodesRemaining: 0,
    });
    expect(JSON.stringify(result)).not.toContain(credential.digest);
  });

  it('reports the lock window and the remaining codes', async () => {
    const { status, repository, credential } = context();
    credential.recordFailure({ maxFailedAttempts: 1, lockoutSec: 900 });
    await repository.saveRecoveryCodeSet(RecoveryCodeSet.issue({ userId: USER_ID, count: 4 }).set);

    const result = await status.execute(new GetCredentialStatusQuery(USER_ID));

    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.recoveryCodesRemaining).toBe(4);
  });

  it('answers zeros for a user who holds nothing rather than 404-ing', async () => {
    // A 404 here would be an account-existence oracle on the one surface that is otherwise
    // completely indifferent to the question.
    const { status } = context(undefined, false);

    const result = await status.execute(new GetCredentialStatusQuery('no-such-user'));

    expect(result).toEqual({
      userId: 'no-such-user',
      hasCredential: false,
      credentialId: null,
      status: null,
      failedAttempts: 0,
      locked: false,
      lockedUntil: null,
      retryAfterSeconds: 0,
      lastVerifiedAt: null,
      recoveryCodesRemaining: 0,
    });
  });
});

describe('outbox contract', () => {
  it('gives every event of one aggregate a distinct version', async () => {
    // The version is the tail of `dedup_key`; a repeat would turn a real event into a
    // silently skipped duplicate on `skipDuplicates: true`.
    const { changePassword, repository } = context();

    await changePassword.execute(
      new ChangePasswordCommand(USER_ID, PASSWORD, NEW_PASSWORD),
    );
    await changePassword.execute(
      new ChangePasswordCommand(USER_ID, NEW_PASSWORD, PASSWORD),
    );

    const versions = repository.outbox.map((event) => event.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('gives every event a distinct id', async () => {
    const { changePassword, repository } = context();

    await changePassword.execute(new ChangePasswordCommand(USER_ID, PASSWORD, NEW_PASSWORD));

    expect(new Set(repository.outbox.map((event) => event.eventId)).size).toBe(
      repository.outbox.length,
    );
  });

  it('carries no plaintext secret in any payload the four topics would publish', async () => {
    const { setPassword, changePassword, regenerate, repository } = context(undefined, false);

    await setPassword.execute(new SetPasswordCommand(USER_ID, PASSWORD));
    await changePassword.execute(
      new ChangePasswordCommand(USER_ID, PASSWORD, NEW_PASSWORD),
    );
    await regenerate.execute(new RegenerateRecoveryCodesCommand(USER_ID, 3));

    const published = JSON.stringify(repository.outbox);
    for (const secret of [PASSWORD, NEW_PASSWORD]) {
      expect(published).not.toContain(secret);
      expect(published).not.toContain(secret.replace(/-/g, ''));
    }
  });
});

describe('hash parameter persistence', () => {
  it('hands the repository parameters that match the hash it just produced', async () => {
    const { setPassword, repository, hasher, config } = context(undefined, false);
    // A deployment that has raised its Argon2 cost: the parameters written next to the digest
    // have to be the *new* ones, or `needsRehash` could never tell a weak hash from an old
    // one and the upgrade could never happen after a policy bump.
    hasher.raisePolicy({ memoryCost: 4096, timeCost: 1, hashLength: 16 });

    await setPassword.execute(new SetPasswordCommand(USER_ID, PASSWORD));

    const stored = [...repository.credentials.values()][0];
    expect(stored.hashParameters).toEqual({
      algorithm: 'argon2id',
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
      hashLength: 16,
      version: 0x13,
    });
    // A fresh hash is never itself due an upgrade.
    expect(stored.needsRehash()).toBe(false);
    expect(config.argon2.algorithm).toBe('argon2id');
  });
});