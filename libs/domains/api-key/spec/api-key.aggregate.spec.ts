/**
 * @fileoverview The `ApiKey` aggregate: issue, expire, revoke, rotate.
 *
 * @remarks Every state transition is exercised against a fixed clock rather than `new Date()`.
 * Expiry is the one rule in this service that is *only* evaluated against the wall clock, so a
 * test that used the wall clock would be asserting on a race it does not control.
 *
 * @remarks The rotation tests assert on both sides of the pair. A rotation that only produced
 * the successor would leave the old key working — which is the failure that turns "we rotated
 * it" into a security incident nobody notices.
 */

import 'reflect-metadata';
import { DomainError } from '@auth/ddd-core';
import {
  ApiKey,
  ROTATED_REVOKE_REASON,
  type ApiKeyRow,
} from '../src/domain/api-key.aggregate';
import { ApiKeyPrefix } from '../src/domain/value-objects/api-key-prefix.vo';
import { ApiKeyScope } from '../src/domain/value-objects/api-key-scope.vo';
import { ApiKeyStatus } from '../src/domain/value-objects/api-key-status.vo';
import { FakeApiKeyCrypto, T0, USER_ID, at } from './support/fakes';
import { payloadFor, thrown } from './support/helpers';

const crypto = new FakeApiKeyCrypto();

const issue = (overrides: Partial<Parameters<typeof ApiKey.issue>[0]> = {}): ApiKey => {
  const material = overrides.material ?? crypto.issueMaterial(ApiKeyPrefix.TEST);
  return ApiKey.issue({
    userId: USER_ID,
    name: 'billing exporter',
    material,
    expiresAt: at(3_600),
    now: T0,
    ...overrides,
  });
};

describe('ApiKey.issue', () => {
  it('stores the digest and the prefix, and never the plaintext', () => {
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);
    const key = issue({ material });

    expect(key.secretHash).toBe(material.digest);
    expect(key.secretHash).not.toBe(material.secret.value);
    expect(key.prefix).toBe(material.prefix);
    expect(JSON.stringify(key.toRow())).not.toContain(material.secret.value);
  });

  it('starts active, unused, un-rotated, and says so with one event', () => {
    const key = issue();

    expect(key.status).toBe(ApiKeyStatus.ACTIVE);
    expect(key.isActive).toBe(true);
    expect(key.lastUsedAt).toBeNull();
    expect(key.revokedAt).toBeNull();
    expect(key.rotationCount).toBe(0);
    expect(key.rotatedFromId).toBeNull();
    expect(key.domainEvents.map((event) => event.eventType)).toEqual(['api_key.created']);
  });

  it('reads its family back off the prefix', () => {
    expect(issue().family).toBe(ApiKeyPrefix.TEST);
    expect(issue({ material: crypto.issueMaterial(ApiKeyPrefix.LIVE) }).family).toBe(
      ApiKeyPrefix.LIVE,
    );
  });

  it('publishes the prefix and the id, and never the key', () => {
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);
    const key = issue({ material, scopes: [ApiKeyScope.READ] });

    const payload = payloadFor(key.domainEvents, 'api_key.created');

    expect(payload).toMatchObject({
      apiKeyId: key.id.value,
      prefix: material.prefix,
      family: ApiKeyPrefix.TEST,
      scopes: [ApiKeyScope.READ],
    });
    // The one assertion in this file that would fail the build rather than a test if it broke.
    expect(JSON.stringify(key.domainEvents)).not.toContain(material.secret.value);
  });

  it('refuses an issue with no owner or no name', () => {
    expect(thrown(() => issue({ userId: '' }))).toBeInstanceOf(DomainError);
    expect(thrown(() => issue({ name: '   ' }))).toBeInstanceOf(DomainError);
  });
});

describe('expiry', () => {
  it('works right up to its deadline and not one millisecond past it', () => {
    const key = issue({ expiresAt: at(60) });

    expect(key.isExpiredAt(at(59))).toBe(false);
    expect(key.isUsableAt(at(59))).toBe(true);
    expect(key.isExpiredAt(at(60))).toBe(true);
    expect(key.isUsableAt(at(60))).toBe(false);
  });

  it('treats a key with no deadline as one that never expires on its own', () => {
    const key = issue({ expiresAt: null });

    expect(key.expiresAt).toBeNull();
    expect(key.isExpiredAt(at(10 ** 9))).toBe(false);
    expect(key.isUsableAt(at(10 ** 9))).toBe(true);
  });

  it('keeps the status `active` after the deadline passes', () => {
    // No sweeper, no `expired` transition. A key stops working the instant its deadline passes,
    // and nothing has to notice that it did.
    const key = issue({ expiresAt: at(60) });

    expect(key.isUsableAt(at(3_600))).toBe(false);
    expect(key.status).toBe(ApiKeyStatus.ACTIVE);
  });
});

describe('revoke', () => {
  it('stops the key working, records when and why, and announces it', () => {
    const key = issue();

    key.revoke('leaked', at(120));

    expect(key.status).toBe(ApiKeyStatus.REVOKED);
    expect(key.isUsableAt(at(120))).toBe(false);
    expect(key.revokedAt).toEqual(at(120));
    expect(key.revokeReason).toBe('leaked');
    expect(key.domainEvents.map((event) => event.eventType)).toEqual([
      'api_key.created',
      'api_key.revoked',
    ]);
  });

  it('is idempotent: a second call publishes nothing', () => {
    // Operator tooling queues "disable this key" jobs and retries them. A second `api_key.revoked`
    // for a fact already announced is a duplicate event, not a state change.
    const key = issue();
    key.revoke('leaked', at(120));
    const buffered = key.domainEvents.length;

    key.revoke('again', at(300));

    expect(key.domainEvents).toHaveLength(buffered);
    expect(key.revokeReason).toBe('leaked');
    expect(key.revokedAt).toEqual(at(120));
  });

  it('moves the key forward in its own event stream', () => {
    // The version is the tail of `dedup_key`; two events sharing one would make the second a
    // silently skipped duplicate.
    const key = issue();
    const issued = key.version;

    key.revoke('leaked', at(120));

    expect(key.version).toBeGreaterThan(issued);
  });
});

describe('rotate', () => {
  it('issues a successor and revokes the original, both observable', () => {
    const current = issue({ scopes: [ApiKeyScope.READ] });
    current.clearDomainEvents();
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    const { revoked, successor } = ApiKey.rotate({ current, material, now: at(60) });

    // The old credential stops working...
    expect(revoked.status).toBe(ApiKeyStatus.REVOKED);
    expect(revoked.revokeReason).toBe(ROTATED_REVOKE_REASON);
    expect(revoked.isUsableAt(at(60))).toBe(false);
    // ...and the new one exists, with different material.
    expect(successor.status).toBe(ApiKeyStatus.ACTIVE);
    expect(successor.isUsableAt(at(60))).toBe(true);
    expect(successor.secretHash).toBe(material.digest);
    expect(successor.secretHash).not.toBe(current.secretHash);
    expect(successor.prefix).not.toBe(current.prefix);
  });

  it('records the lineage, the carried-over authority and the name', () => {
    const current = issue({ scopes: [ApiKeyScope.READ, ApiKeyScope.WRITE] });
    const { successor } = ApiKey.rotate({
      current,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
      now: at(60),
    });

    expect(successor.rotatedFromId).toBe(current.id.value);
    expect(successor.rotationCount).toBe(current.rotationCount + 1);
    // Same name, so the owner sees one key in their list and `(user_id, name)` stays satisfied.
    expect(successor.name).toBe(current.name);
    expect(successor.userId).toBe(current.userId);
    expect(successor.scopes).toEqual([ApiKeyScope.READ, ApiKeyScope.WRITE]);
  });

  it('announces a rotation rather than a creation', () => {
    // A consumer that cannot tell a fresh key from a replacement cannot alert on the event an
    // operator has to be able to act on.
    const current = issue();
    current.clearDomainEvents();
    const { revoked, successor } = ApiKey.rotate({
      current,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
      now: at(60),
    });

    expect(successor.domainEvents.map((event) => event.eventType)).toEqual(['api_key.rotated']);
    expect(revoked.domainEvents.map((event) => event.eventType)).toEqual(['api_key.revoked']);

    const payload = payloadFor(successor.domainEvents, 'api_key.rotated');
    expect(payload).toMatchObject({
      apiKeyId: successor.id.value,
      previousApiKeyId: current.id.value,
      previousPrefix: current.prefix,
    });
  });

  it('publishes neither old nor new key in the two payloads', () => {
    const current = issue();
    const material = crypto.issueMaterial(ApiKeyPrefix.TEST);

    const { revoked, successor } = ApiKey.rotate({ current, material, now: at(60) });
    const published = JSON.stringify([...revoked.domainEvents, ...successor.domainEvents]);

    expect(published).not.toContain(material.secret.value);
    expect(published).not.toContain(crypto.issued[0].secret.value);
  });

  it('inherits the original deadline, rather than rolling it forward', () => {
    // A continuously-rotated leaked key that outlived its original lifetime would never expire.
    const current = issue({ expiresAt: at(3_600) });

    const { successor } = ApiKey.rotate({
      current,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
      now: at(60),
    });

    expect(successor.expiresAt).toEqual(at(3_600));
    expect(successor.isUsableAt(at(3_601))).toBe(false);
  });

  it('refuses to rotate a key that is already revoked', () => {
    const current = issue();
    current.revoke('leaked', at(60));
    current.clearDomainEvents();

    const error = thrown(() =>
      ApiKey.rotate({
        current,
        material: crypto.issueMaterial(ApiKeyPrefix.TEST),
        now: at(120),
      }),
    ) as DomainError;

    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('CONFLICTING_STATE');
  });

  it('rotates twice in a row, and the chain stays connected', () => {
    const first = issue();
    const second = ApiKey.rotate({
      current: first,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
      now: at(60),
    }).successor;
    const third = ApiKey.rotate({
      current: second,
      material: crypto.issueMaterial(ApiKeyPrefix.TEST),
      now: at(120),
    }).successor;

    expect(third.rotatedFromId).toBe(second.id.value);
    expect(third.rotationCount).toBe(2);
    expect(third.rotatedFromId).not.toBe(first.id.value);
  });
});

describe('markUsed', () => {
  it('touches last_used_at and announces nothing', () => {
    // An event per authenticated request would bury `api_key.revoked` in noise, and an
    // unauthenticated caller must not be able to move a key's position in its event stream.
    const key = issue();
    const version = key.version;

    key.markUsed(at(60));

    expect(key.lastUsedAt).toEqual(at(60));
    expect(key.domainEvents).toHaveLength(1);
    expect(key.version).toBe(version);
  });

  it('is idempotent within the same instant', () => {
    const key = issue();

    key.markUsed(at(60));
    key.markUsed(at(60));

    expect(key.lastUsedAt).toEqual(at(60));
  });

  it('does not resurrect a revoked key by making it look used', () => {
    const key = issue();
    key.revoke('leaked', at(30));

    key.markUsed(at(60));

    expect(key.lastUsedAt).toBeNull();
    expect(key.isUsableAt(at(60))).toBe(false);
  });
});

describe('the scopes a key satisfies', () => {
  it('lets admin through every requirement', () => {
    const key = issue({ scopes: [ApiKeyScope.ADMIN] });

    expect(key.satisfies([ApiKeyScope.READ])).toBe(true);
    expect(key.satisfies([ApiKeyScope.WRITE])).toBe(true);
    expect(key.satisfies([ApiKeyScope.DELETE])).toBe(true);
    expect(key.hasScope(ApiKeyScope.DELETE)).toBe(true);
  });

  it('does not let read stand in for write', () => {
    const key = issue({ scopes: [ApiKeyScope.READ] });

    expect(key.hasScope(ApiKeyScope.READ)).toBe(true);
    expect(key.hasScope(ApiKeyScope.WRITE)).toBe(false);
    expect(key.satisfies([ApiKeyScope.WRITE])).toBe(false);
    expect(key.satisfies([])).toBe(true);
  });
});

describe('rehydration', () => {
  it('round-trips through a row without losing the credential', () => {
    const key = issue({ scopes: [ApiKeyScope.READ, ApiKeyScope.WRITE] });
    key.markUsed(at(60));
    key.revoke('leaked', at(120));

    const row: ApiKeyRow = key.toRow();
    const loaded = ApiKey.fromRow(row);

    expect(loaded.prefix).toBe(key.prefix);
    expect(loaded.secretHash).toBe(key.secretHash);
    expect(loaded.scopes).toEqual([ApiKeyScope.READ, ApiKeyScope.WRITE]);
    expect(loaded.status).toBe(ApiKeyStatus.REVOKED);
    expect(loaded.revokedAt).toEqual(at(120));
    expect(loaded.lastUsedAt).toEqual(at(60));
    expect(loaded.id.value).toBe(key.id.value);
    // Rehydration is not a transition, so it announces nothing.
    expect(loaded.domainEvents).toHaveLength(0);
  });

  it('drops a scope a newer build wrote rather than refusing the row', () => {
    const key = issue({ scopes: [ApiKeyScope.READ] });
    const row = { ...key.toRow(), scopes: ['read', 'superuser'] };

    // Throwing here would turn a routine rollout into an outage of the whole service, and
    // dropping an unknown scope can only remove authority, never grant it.
    expect(ApiKey.fromRow(row).scopes).toEqual([ApiKeyScope.READ]);
  });
});