/**
 * @fileoverview The path an inbound credential actually takes.
 *
 * @remarks The bias here is towards *indistinguishability*. Four different facts — no such
 * prefix, a real prefix with the wrong body, revoked, expired — have to produce one error with
 * one message and no context, because a caller who can tell them apart learns which prefixes
 * exist and which of their keys are still alive.
 */

import 'reflect-metadata';
import { InvalidCredentialsException } from '@auth/platform/error-handling';
import {
  ApiKeyAuthenticationService,
  INVALID_API_KEY_MESSAGE,
} from '../src/application/authentication/api-key-authentication.service';
import { ApiKey } from '../src/domain/api-key.aggregate';
import { ApiKeyPrefix } from '../src/domain/value-objects/api-key-prefix.vo';
import { ApiKeyScope } from '../src/domain/value-objects/api-key-scope.vo';
import { ApiKeyStatus } from '../src/domain/value-objects/api-key-status.vo';
import type { ApiKeyConfig } from '../src/api-key.config';
import {
  FakeApiKeyCrypto,
  InMemoryApiKeyRepository,
  USER_ID,
  realCrypto,
  testApiKeyConfig,
} from './support/fakes';
import { rejection, stored } from './support/helpers';

const crypto = realCrypto();

const context = (configOverrides: Partial<ApiKeyConfig> = {}) => {
  const repository = new InMemoryApiKeyRepository();
  const config = testApiKeyConfig(configOverrides);
  return { repository, config, authenticator: new ApiKeyAuthenticationService(repository, crypto, config) };
};

/** Issues a key through the real crypto, so the digest under test is a real one. */
const issue = async (
  overrides: {
    scopes?: ApiKeyScope[];
    expiresAt?: Date | null;
    family?: ApiKeyPrefix;
    name?: string;
    userId?: string;
    config?: Partial<ApiKeyConfig>;
  } = {},
) => {
  const harness = context(overrides.config);
  const material = crypto.issueMaterial(overrides.family ?? ApiKeyPrefix.TEST);
  const key = ApiKey.issue({
    userId: overrides.userId ?? USER_ID,
    name: overrides.name ?? 'billing exporter',
    material,
    scopes: overrides.scopes ?? [ApiKeyScope.READ],
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 3_600_000),
    now: new Date(),
  });
  await harness.repository.save(key);
  return { ...harness, key, material, plaintext: material.secret.value };
};

describe('a live key', () => {
  it('authenticates, and says what it may do', async () => {
    const { authenticator, plaintext, key } = await issue({
      scopes: [ApiKeyScope.READ, ApiKeyScope.WRITE],
    });

    const principal = await authenticator.authenticate(plaintext);

    expect(principal).toEqual({
      apiKeyId: key.id.value,
      userId: USER_ID,
      prefix: key.prefix,
      family: ApiKeyPrefix.TEST,
      scopes: [ApiKeyScope.READ, ApiKeyScope.WRITE],
      status: ApiKeyStatus.ACTIVE,
    });
  });

  it('never carries the key, or anything derived from it, into the principal', async () => {
    const { authenticator, plaintext, key } = await issue();

    const principal = await authenticator.authenticate(plaintext);

    // The principal is attached to a request and read by every handler downstream.
    expect(JSON.stringify(principal)).not.toContain(plaintext);
    expect(JSON.stringify(principal)).not.toContain(key.secretHash);
    expect(Object.keys(principal)).not.toContain('secret_hash');
  });

  it('touches last_used_at and persists it', async () => {
    const { authenticator, repository, plaintext, key } = await issue();

    expect(stored(repository.rows, key.id.value).last_used_at).toBeNull();

    await authenticator.authenticate(plaintext);

    const row = stored(repository.rows, key.id.value);
    expect(row.last_used_at).toBeInstanceOf(Date);
    expect(row.last_used_at?.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('announces nothing when it does', async () => {
    // One `api_key.used` per authenticated request would bury `api_key.revoked` in noise.
    const { authenticator, repository, plaintext } = await issue();
    repository.outbox.length = 0;

    await authenticator.authenticate(plaintext);

    expect(repository.outbox).toHaveLength(0);
  });

  it('skips the touch when the operator turned it off', async () => {
    const harness = await issue({ config: { trackLastUsed: false } });

    await harness.authenticator.authenticate(harness.plaintext);

    expect(stored(harness.repository.rows, harness.key.id.value).last_used_at).toBeNull();
  });
});

describe('everything else is refused identically', () => {
  const refused = async (
    scenario: () => Promise<{ authenticator: ApiKeyAuthenticationService; plaintext: string }>,
  ): Promise<InvalidCredentialsException> => {
    const { authenticator, plaintext } = await scenario();
    return (await rejection(authenticator.authenticate(plaintext))) as InvalidCredentialsException;
  };

  it('refuses a malformed key, an unknown prefix and a wrong body the same way', async () => {
    const unknown = await issue({ name: 'known one' });
    const wrongBody = await issue({ name: 'known two' });
    // A real prefix with a body that is not its own: the attack a prefix lookup cannot stop.
    const tampered = `${wrongBody.key.prefix}_${'C'.repeat(43)}`;

    const cases = await Promise.all([
      refused(async () => ({ authenticator: unknown.authenticator, plaintext: '' })),
      refused(async () => ({ authenticator: unknown.authenticator, plaintext: 'not-a-key' })),
      refused(async () => ({
        authenticator: unknown.authenticator,
        plaintext: `test_ZZZZZZZZ_${'B'.repeat(43)}`,
      })),
      refused(async () => ({ authenticator: wrongBody.authenticator, plaintext: tampered })),
      refused(async () => ({ authenticator: wrongBody.authenticator, plaintext: unknown.plaintext })),
    ]);

    for (const error of cases) {
      expect(error).toBeInstanceOf(InvalidCredentialsException);
      expect(error.message).toBe(INVALID_API_KEY_MESSAGE);
      // A context key present on one branch and absent on another is the oracle even when the
      // message is identical, because `AppException` spreads it into the response body.
      expect(error.context).toEqual({});
      expect(error.getStatus()).toBe(cases[0].getStatus());
    }
  });

  it('refuses an expired key', async () => {
    const error = await refused(async () => {
      const harness = await issue({ expiresAt: new Date(Date.now() - 1_000) });
      return harness;
    });

    expect(error).toBeInstanceOf(InvalidCredentialsException);
  });

  it('refuses a revoked key, even while it is unexpired', async () => {
    const { authenticator, repository, key, plaintext } = await issue();
    key.revoke('leaked');
    await repository.save(key);

    const error = (await rejection(
      authenticator.authenticate(plaintext),
    )) as InvalidCredentialsException;

    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(error.message).toBe(INVALID_API_KEY_MESSAGE);
  });

  it('refuses the key a rotation superseded', async () => {
    const { authenticator, repository, key, plaintext } = await issue();

    const { revoked, successor } = ApiKey.rotate({
      current: key,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
      now: new Date(),
    });
    await repository.saveMany([revoked, successor]);

    await expect(authenticator.authenticate(plaintext)).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });

  it('refuses a test key on a live deployment, and keeps the reason to itself', async () => {
    const { repository, plaintext } = await issue({ family: ApiKeyPrefix.TEST });
    const live = new ApiKeyAuthenticationService(repository, crypto, testApiKeyConfig({ keyFamily: 'live' }));

    const error = (await rejection(live.authenticate(plaintext))) as InvalidCredentialsException;

    // A staging credential pasted into production must fail, and the caller is not told that
    // the *family* was the problem.
    expect(error).toBeInstanceOf(InvalidCredentialsException);
    expect(error.message).toBe(INVALID_API_KEY_MESSAGE);
  });

  it('still accepts a live key on a test deployment', async () => {
    // The reverse is not a security event, and refusing it would make a smoke test against
    // production credentials impossible for no gain.
    const { repository, plaintext } = await issue({ family: ApiKeyPrefix.LIVE });
    const staging = new ApiKeyAuthenticationService(
      repository,
      crypto,
      testApiKeyConfig({ keyFamily: 'test' }),
    );

    await expect(staging.authenticate(plaintext)).resolves.toMatchObject({
      family: ApiKeyPrefix.LIVE,
    });
  });
});

describe('a live key against a fake digest', () => {
  it('refuses a key whose stored digest is not its own', async () => {
    // Guards the lookup: the prefix finds the row, the digest decides. A repository that
    // returned the wrong row would otherwise authenticate anyone holding that prefix.
    const { repository, authenticator } = context();
    const fakeCrypto = new FakeApiKeyCrypto();
    const material = fakeCrypto.issueMaterial(ApiKeyPrefix.TEST);
    const key = ApiKey.issue({
      userId: USER_ID,
      name: 'seeded',
      material,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await repository.save(key);

    const realKey = crypto.issueMaterial(ApiKeyPrefix.TEST);
    await expect(authenticator.authenticate(realKey.secret.value)).rejects.toBeInstanceOf(
      InvalidCredentialsException,
    );
  });
});