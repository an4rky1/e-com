/**
 * @fileoverview The three commands and the one query.
 *
 * @remarks What these tests share is a bias towards the *outbound* surface: what an event
 * carries, what ends up stored, and what a caller may read back. The domain rules live in
 * `api-key.aggregate.spec.ts`; the point here is that the wiring around them never widens what
 * leaves the service.
 *
 * @remarks Handlers are constructed directly. There is no `TestingModule`, because a handler
 * takes two ports and a config object — a container would only make the wiring under test *less*
 * visible, and these are the paths where "it worked in the container" is not the same claim as
 * "the port was called with the right thing".
 */

import 'reflect-metadata';
import {
  PermissionDeniedException,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
  ValidationException,
} from '@auth/platform/error-handling';
import { Topics } from '@auth/contracts';
import { CreateApiKeyHandler } from '../src/application/commands/create-api-key.handler';
import { RevokeApiKeyHandler } from '../src/application/commands/revoke-api-key.handler';
import { RotateApiKeyHandler } from '../src/application/commands/rotate-api-key.handler';
import {
  CreateApiKeyCommand,
  RevokeApiKeyCommand,
  RotateApiKeyCommand,
} from '../src/application/commands/api-key.command';
import {
  ListUserApiKeysHandler,
  ListUserApiKeysQuery,
} from '../src/application/queries/api-key.queries';
import { ApiKey } from '../src/domain/api-key.aggregate';
import { ApiKeyPrefix } from '../src/domain/value-objects/api-key-prefix.vo';
import { ApiKeyScope } from '../src/domain/value-objects/api-key-scope.vo';
import { ApiKeyStatus } from '../src/domain/value-objects/api-key-status.vo';
import {
  FakeApiKeyCrypto,
  InMemoryApiKeyRepository,
  OTHER_USER_ID,
  T0,
  USER_ID,
  testApiKeyConfig,
} from './support/fakes';
import { rejection, stored } from './support/helpers';

/** The `api_key.*` -> topic mapping the real repository uses. */
const TOPICS = {
  'api_key.created': Topics.API_KEY_CREATED,
  'api_key.rotated': Topics.API_KEY_ROTATED,
  'api_key.revoked': Topics.API_KEY_REVOKED,
} as const;

/** Shared so a seeded aggregate's material and a command's material come from one place. */
const crypto = new FakeApiKeyCrypto();

const context = (seed: ConstructorParameters<typeof InMemoryApiKeyRepository>[0] = []) => {
  const repository = new InMemoryApiKeyRepository(seed, TOPICS);
  const config = testApiKeyConfig();

  return {
    crypto,
    repository,
    config,
    create: new CreateApiKeyHandler(repository, crypto, config),
    rotate: new RotateApiKeyHandler(repository, crypto, config),
    revoke: new RevokeApiKeyHandler(repository),
    list: new ListUserApiKeysHandler(repository),
  };
};

describe('CreateApiKeyCommand', () => {
  it('returns the plaintext exactly once, and stores only its digest', async () => {
    const { create, repository } = context();

    const result = await create.execute(
      new CreateApiKeyCommand(USER_ID, 'billing exporter', [ApiKeyScope.READ]),
    );

    expect(result.key).toMatch(/^test_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}$/);
    expect(result.prefix).toBe(result.key.split('_').slice(0, 2).join('_'));
    expect(result.scopes).toEqual([ApiKeyScope.READ]);

const row = stored(repository.rows, result.apiKeyId);
    expect(row.secret_hash).not.toBe(result.key);
    expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.prefix).toBe(result.prefix);
    expect(JSON.stringify([...repository.rows.values()])).not.toContain(result.key);
  });

  it('expires on the configured default when the caller says nothing', async () => {
    const { create, config } = context();

    const result = await create.execute(new CreateApiKeyCommand(USER_ID, 'ci runner'));

    const lifetimeSec = (result.expiresAt?.getTime() ?? 0) - Date.now();
    expect(lifetimeSec).toBeGreaterThan(config.defaultTtlSec * 1_000 - 60_000);
    expect(lifetimeSec).toBeLessThanOrEqual(config.defaultTtlSec * 1_000 + 1_000);
  });

  it('refuses a deadline in the past rather than issuing a key that is already dead', async () => {
    const { create, repository } = context();

    // A credential the caller can never use and cannot understand why.
    await expect(
      create.execute(
        new CreateApiKeyCommand(USER_ID, 'ci runner', undefined, new Date(Date.now() - 1_000)),
      ),
    ).rejects.toBeInstanceOf(ValidationException);

    expect(repository.saved).toHaveLength(0);
  });

  it('refuses a lifetime beyond the ceiling', async () => {
    const { create } = context();

    await expect(
      create.execute(
        new CreateApiKeyCommand(
          USER_ID,
          'ci runner',
          undefined,
          new Date(Date.now() + 10 * 365 * 24 * 3_600 * 1_000),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('refuses a name that is missing or absurdly long', async () => {
    const { create } = context();

    await expect(create.execute(new CreateApiKeyCommand(USER_ID, ' '))).rejects.toBeInstanceOf(
      ValidationException,
    );
    await expect(
      create.execute(new CreateApiKeyCommand(USER_ID, 'x'.repeat(65))),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('refuses an unknown scope by name rather than quietly issuing fewer rights', async () => {
    const { create, repository } = context();

    const error = (await rejection(
      create.execute(
        new CreateApiKeyCommand(USER_ID, 'superuser', ['read', 'superuser'] as never),
      ),
    )) as ValidationException;

    expect(error).toBeInstanceOf(ValidationException);
    expect(error.context.received).toEqual(['superuser']);
    expect(repository.saved).toHaveLength(0);
  });

  it('reports a duplicate name as a 409 rather than letting the unique index raise', async () => {
    const { create } = context();

    await create.execute(new CreateApiKeyCommand(USER_ID, 'billing exporter'));
    await expect(
      create.execute(new CreateApiKeyCommand(USER_ID, 'billing exporter')),
    ).rejects.toBeInstanceOf(ResourceAlreadyExistsException);
  });

  it('announces the issue without the key, on the created topic', async () => {
    const { create, repository } = context();

    const result = await create.execute(
      new CreateApiKeyCommand(USER_ID, 'billing exporter', [ApiKeyScope.WRITE]),
    );

    expect(repository.outbox.map((event) => event.eventType)).toEqual(['api_key.created']);
    expect(repository.outbox[0]).toMatchObject({
      aggregateId: result.apiKeyId,
      topic: Topics.API_KEY_CREATED,
      dedupKey: `api_key.created:${result.apiKeyId}:1`,
    });
    expect(repository.outbox[0].payload).toMatchObject({
      apiKeyId: result.apiKeyId,
      prefix: result.prefix,
      scopes: [ApiKeyScope.WRITE],
    });
    expect(JSON.stringify(repository.outbox)).not.toContain(result.key);
  });

  it('never hands out the same key twice', async () => {
    const { create } = context();

    const first = await create.execute(new CreateApiKeyCommand(USER_ID, 'exporter one'));
    const second = await create.execute(new CreateApiKeyCommand(USER_ID, 'exporter two'));

    expect(second.key).not.toBe(first.key);
    expect(second.prefix).not.toBe(first.prefix);
  });
});

describe('RotateApiKeyCommand', () => {
  const seed = async () => {
    const harness = context();
    const created = await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'billing exporter', [ApiKeyScope.READ, ApiKeyScope.WRITE]),
    );
    harness.repository.outbox.length = 0;
    return { ...harness, created };
  };

  it('issues a successor and stops the original working, in one transaction', async () => {
    const { rotate, repository, created } = await seed();
    const commitsBefore = repository.commits;

    const result = await rotate.execute(new RotateApiKeyCommand(created.apiKeyId));

    // One boundary for two rows: the new key is useless until the old one stops working, and the
    // old one is a live credential until it does.
    expect(repository.commits - commitsBefore).toBe(1);

    const previous = stored(repository.rows, created.apiKeyId);
    const successor = stored(repository.rows, result.apiKeyId);

    expect(previous.status).toBe(ApiKeyStatus.REVOKED);
    expect(previous.revoke_reason).toBe('rotated');
    expect(successor.status).toBe(ApiKeyStatus.ACTIVE);
    expect(successor.rotated_from_id).toBe(created.apiKeyId);
    expect(successor.rotation_count).toBe(1);
    expect(successor.scopes).toEqual([ApiKeyScope.READ, ApiKeyScope.WRITE]);
  });

  it('returns the new plaintext and names the key it replaced', async () => {
    const { rotate, created } = await seed();

    const result = await rotate.execute(new RotateApiKeyCommand(created.apiKeyId));

    expect(result.key).toMatch(/^test_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}$/);
    expect(result.key).not.toBe(created.key);
    expect(result.previousApiKeyId).toBe(created.apiKeyId);
    expect(result.previousPrefix).toBe(created.prefix);
    expect(result.prefix).not.toBe(created.prefix);
    expect(result.revokedAt).toBeInstanceOf(Date);
  });

  it('keeps the successor in the family the original was minted in', async () => {
    const { create, rotate } = context();

    const created = await create.execute(
      new CreateApiKeyCommand(USER_ID, 'live key', undefined, undefined, 'live'),
    );
    const result = await rotate.execute(new RotateApiKeyCommand(created.apiKeyId));

    expect(result.key.startsWith('live_')).toBe(true);
  });

  it('publishes both facts and neither key', async () => {
    const { rotate, repository, created } = await seed();

    const result = await rotate.execute(new RotateApiKeyCommand(created.apiKeyId));

    expect(repository.outbox.map((event) => event.eventType).sort()).toEqual([
      'api_key.revoked',
      'api_key.rotated',
    ]);
    expect(repository.outbox.map((event) => event.topic)).toEqual(
      expect.arrayContaining([Topics.API_KEY_REVOKED, Topics.API_KEY_ROTATED]),
    );
    expect(JSON.stringify(repository.outbox)).not.toContain(result.key);
    expect(JSON.stringify(repository.outbox)).not.toContain(created.key);
  });

  it('refuses to rotate a key that does not exist', async () => {
    const { rotate } = context();

    await expect(
      rotate.execute(new RotateApiKeyCommand('3f6b2c1e-8b1a-4b3f-9c2d-1e2f3a4b5c6d')),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('refuses a deadline beyond the ceiling', async () => {
    const { rotate, repository, created } = await seed();
    const commitsBefore = repository.commits;

    await expect(
      rotate.execute(
        new RotateApiKeyCommand(
          created.apiKeyId,
          undefined,
          new Date(Date.now() + 10 * 365 * 24 * 3_600 * 1_000),
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationException);

    // Nothing was written: the refusal happens before the mint, so no orphan row is left behind.
    expect(repository.commits).toBe(commitsBefore);
  });

  it('gives a successor whose original deadline has already passed a fresh lifetime', async () => {
    // Inheriting an elapsed deadline would mint a credential that is dead on arrival, which is
    // worse than useless: the owner sees a key in their list and cannot use it.
    const stale = ApiKey.issue({
      userId: USER_ID,
      name: 'long expired',
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
      expiresAt: new Date(Date.now() - 60_000),
    });
    const harness = context([stale]);

    const result = await harness.rotate.execute(new RotateApiKeyCommand(stale.id.value));

    expect(result.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(result.key).toMatch(/^test_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}$/);
  });
});

describe('RevokeApiKeyCommand', () => {
  it('withdraws the key and says so', async () => {
    const harness = context();
    const created = await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'billing exporter'),
    );
    harness.repository.outbox.length = 0;

    const result = await harness.revoke.execute(
      new RevokeApiKeyCommand(created.apiKeyId, 'leaked', USER_ID),
    );

    expect(result).toMatchObject({
      apiKeyId: created.apiKeyId,
      userId: USER_ID,
      reason: 'leaked',
      changed: true,
    });
    expect(stored(harness.repository.rows, created.apiKeyId).status).toBe(
      ApiKeyStatus.REVOKED,
    );
    expect(harness.repository.outbox[0]).toMatchObject({
      eventType: 'api_key.revoked',
      topic: Topics.API_KEY_REVOKED,
    });
  });

  it('is a no-op the second time, and says that it changed nothing', async () => {
    const harness = context();
    const created = await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'billing exporter'),
    );

    await harness.revoke.execute(new RevokeApiKeyCommand(created.apiKeyId, 'leaked'));
    harness.repository.outbox.length = 0;
    const again = await harness.revoke.execute(
      new RevokeApiKeyCommand(created.apiKeyId, 'leaked'),
    );

    expect(again.changed).toBe(false);
    expect(harness.repository.outbox).toHaveLength(0);
  });

  it('refuses a key that belongs to somebody else', async () => {
    const harness = context();
    const created = await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'billing exporter'),
    );

    await expect(
      harness.revoke.execute(
        new RevokeApiKeyCommand(created.apiKeyId, 'leaked', OTHER_USER_ID),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedException);

    expect(stored(harness.repository.rows, created.apiKeyId).status).toBe(ApiKeyStatus.ACTIVE);
  });

  it('refuses a key that does not exist', async () => {
    const { revoke } = context();

    await expect(revoke.execute(new RevokeApiKeyCommand('nope'))).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('announces the revocation without the key', async () => {
    const harness = context();
    const created = await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'billing exporter'),
    );
    harness.repository.outbox.length = 0;

    await harness.revoke.execute(new RevokeApiKeyCommand(created.apiKeyId, 'leaked'));

    expect(JSON.stringify(harness.repository.outbox)).not.toContain(created.key);
  });
});

describe('ListUserApiKeysQuery', () => {
  it('lists what a user owns, newest first, with no digest in sight', async () => {
    const harness = context();
    const first = await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'exporter one'),
    );
    await harness.create.execute(
      new CreateApiKeyCommand(OTHER_USER_ID, 'somebody else', [ApiKeyScope.ADMIN]),
    );
    await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'exporter two', [ApiKeyScope.DELETE]),
    );

    const listed = await harness.list.execute(new ListUserApiKeysQuery(USER_ID, false, T0));

    expect(listed).toHaveLength(2);
    expect(listed.every((entry) => entry.name.startsWith('exporter'))).toBe(true);
    // A listing is the surface most likely to be logged, cached and rendered.
    expect(JSON.stringify(listed)).not.toContain(first.key);
    expect(JSON.stringify(listed)).not.toMatch(/secret_hash/);
  });

  it('keeps revoked keys in the list, and reports them as unusable', async () => {
    const harness = context();
    const created = await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'billing exporter'),
    );
    await harness.revoke.execute(new RevokeApiKeyCommand(created.apiKeyId, 'leaked'));

    const [entry] = await harness.list.execute(new ListUserApiKeysQuery(USER_ID, false, T0));

    expect(entry).toMatchObject({
      apiKeyId: created.apiKeyId,
      status: ApiKeyStatus.REVOKED,
      usable: false,
      prefix: created.prefix,
    });
  });

  it('narrows to what still works on request', async () => {
    const harness = context();
    const doomed = await harness.create.execute(new CreateApiKeyCommand(USER_ID, 'doomed'));
    await harness.create.execute(new CreateApiKeyCommand(USER_ID, 'live one'));
    await harness.revoke.execute(new RevokeApiKeyCommand(doomed.apiKeyId, 'leaked'));

    const usable = await harness.list.execute(new ListUserApiKeysQuery(USER_ID, true, T0));

    expect(usable).toHaveLength(1);
    expect(usable[0].usable).toBe(true);
  });

  it('evaluates usability against the deadline, not only the status', async () => {
    const harness = context();
    const deadline = new Date(Date.now() + 1_000);
    await harness.create.execute(
      new CreateApiKeyCommand(USER_ID, 'short lived', undefined, deadline),
    );

    expect(
      await harness.list.execute(
        new ListUserApiKeysQuery(USER_ID, true, new Date(deadline.getTime() - 1)),
      ),
    ).toHaveLength(1);
    // The status is still `active`; the deadline alone takes the key out of service.
    expect(
      await harness.list.execute(
        new ListUserApiKeysQuery(USER_ID, true, new Date(deadline.getTime() + 1_000)),
      ),
    ).toHaveLength(0);
  });

  it('answers an empty list for a user who holds nothing', async () => {
    const { list } = context();

    await expect(list.execute(new ListUserApiKeysQuery('no-such-user'))).resolves.toEqual([]);
  });
});