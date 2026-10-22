/**
 * The `PasswordCredential` aggregate.
 *
 * @remarks The hasher is the fake from `testing/fake-persistence`, so these tests exercise the
 * *aggregate's* rules rather than Argon2's cost. What is asserted here is the part that has to
 * stay true no matter how the hashing is implemented: when a hash is due an upgrade, when a
 * lock engages, and what ends up in an event payload.
 */
import {
  CredentialRotation,
  DEFAULT_CREDENTIAL_IDENTIFIER,
  PasswordCredential,
  type LockoutPolicy,
  type PasswordCredentialRow,
} from '../src/domain/password-credential.aggregate';
import { CredentialStatus } from '../src/domain/value-objects/credential-status.vo';
import type { PasswordHash } from '../src/domain/ports/password-hasher.port';
import {
  CURRENT_PARAMETERS,
  FakePasswordHasher,
  type FakePasswordHasher as Hasher,
} from './testing/fake-persistence';
import { payloadOf } from './testing/helpers';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CREDENTIAL_ID = '1f3a5c7e-9b2d-4e6f-8a1b-2c3d4e5f6a7b';
const PASSWORD = 'Saffron-Kestrel-42!';

const LOCKOUT: LockoutPolicy = { maxFailedAttempts: 3, lockoutSec: 900 };

const hashWith = (parameters = CURRENT_PARAMETERS): PasswordHash => ({
  digest: 'argon2id$v=19$m=65536,t=3,p=1$Zm9vYmFy$YmF6',
  parameters,
});

/**
 * A credential that is already in the database.
 *
 * @remarks Its buffered events are drained on the way out, exactly as the real repository
 * drains them on a save — otherwise every assertion about "what did this transition emit"
 * would also be counting the creation event, which was published when the row was written.
 */
const makeCredential = (
  hasher: Hasher,
  parameters = CURRENT_PARAMETERS,
): PasswordCredential => {
  const credential = PasswordCredential.create({
    userId: USER_ID,
    id: CREDENTIAL_ID,
    hasher,
    hash: hashWith(parameters),
  });
  credential.clearDomainEvents();
  return credential;
};

describe('PasswordCredential.create', () => {
  it('starts active, unlocked, with no failures recorded', () => {
    const credential = makeCredential(new FakePasswordHasher());

    expect(credential.status).toBe(CredentialStatus.ACTIVE);
    expect(credential.failedAttempts).toBe(0);
    expect(credential.lockedUntil).toBeNull();
    expect(credential.lastVerifiedAt).toBeNull();
    expect(credential.isVerifiable()).toBe(true);
    expect(credential.hasSecret).toBe(true);
  });

  it('defaults the identifier to `password` and normalises a blank one', () => {
    const hasher = new FakePasswordHasher();

    expect(makeCredential(hasher).identifier).toBe(DEFAULT_CREDENTIAL_IDENTIFIER);
    expect(
      PasswordCredential.create({
        userId: USER_ID,
        hasher,
        hash: hashWith(),
        identifier: '   ',
      }).identifier,
    ).toBe(DEFAULT_CREDENTIAL_IDENTIFIER);
  });

  it('announces the first secret — a live password nobody was told about is not safe', () => {
    const credential = PasswordCredential.create({
      userId: USER_ID,
      hasher: new FakePasswordHasher(),
      hash: hashWith(),
    });

    const [event] = credential.domainEvents;
    expect(credential.domainEvents).toHaveLength(1);
    expect(event.eventType).toBe('credential.rotated');
    expect(payloadOf<{ rotation: string }>(event).rotation).toBe(CredentialRotation.SET);
    // Version 1, not 2: the row is written at version 1 and this is the event that made it
    // so, so the outbox dedup key and the stored version agree.
    expect(event.version).toBe(credential.version);
  });

  it('keeps a caller-supplied id so replaying the write is reproducible', () => {
    expect(makeCredential(new FakePasswordHasher()).id.value).toBe(CREDENTIAL_ID);
  });

  it('refuses a credential with no user or no digest', () => {
    const hasher = new FakePasswordHasher();

    expect(() =>
      PasswordCredential.create({ userId: '', hasher, hash: hashWith() }),
    ).toThrow(/userId/);
    expect(() =>
      PasswordCredential.create({
        userId: USER_ID,
        hasher,
        hash: { digest: '', parameters: CURRENT_PARAMETERS },
      }),
    ).toThrow(/hash\.digest/);
  });
});

describe('PasswordCredential.needsRehash', () => {
  it('is false for a hash made under the current policy', () => {
    const hasher = new FakePasswordHasher();
    expect(makeCredential(hasher).needsRehash()).toBe(false);
  });

  it('is true when the stored hash is below the current policy', () => {
    const hasher = new FakePasswordHasher();
    const credential = makeCredential(hasher, {
      ...CURRENT_PARAMETERS,
      memoryCost: 8 * 1024,
      timeCost: 1,
    });

    expect(credential.needsRehash()).toBe(true);
  });

  it('follows the policy, not the age: raising the policy makes a stored hash stale', () => {
    const hasher = new FakePasswordHasher();
    const credential = makeCredential(hasher);

    expect(credential.needsRehash()).toBe(false);

    // The deployment raised its Argon2 cost. Every hash on disk is now below policy, and this
    // is the signal that the next successful sign-in should upgrade it.
    hasher.raisePolicy({ memoryCost: CURRENT_PARAMETERS.memoryCost * 2 });
    expect(credential.needsRehash()).toBe(true);
  });

  it('is false for a hash stronger than the current policy', () => {
    const hasher = new FakePasswordHasher();
    const credential = makeCredential(hasher, {
      ...CURRENT_PARAMETERS,
      memoryCost: CURRENT_PARAMETERS.memoryCost * 2,
    });

    expect(credential.needsRehash()).toBe(false);
  });

  it('is false when there is no secret to upgrade', () => {
    const hasher = new FakePasswordHasher();
    const row: PasswordCredentialRow = {
      id: CREDENTIAL_ID,
      user_id: USER_ID,
      identifier: 'password',
      method: 'password',
      secret_hash: null,
      secret_parameters: {},
      status: 'active',
      failed_attempts: 0,
      locked_until: null,
      last_verified_at: null,
      revoked_at: null,
      revoked_reason: null,
      version: 1,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(PasswordCredential.fromRow(row, hasher).needsRehash()).toBe(false);
  });
});

describe('PasswordCredential.recordVerification', () => {
  it('clears the failure run and emits credential.verified without the password', () => {
    const credential = makeCredential(new FakePasswordHasher());
    credential.recordFailure(LOCKOUT);
    credential.recordFailure(LOCKOUT);
    credential.clearDomainEvents();

    const now = new Date('2026-03-03T12:00:00.000Z');
    credential.recordVerification(now);

    expect(credential.failedAttempts).toBe(0);
    expect(credential.lastVerifiedAt).toEqual(now);
    expect(credential.status).toBe(CredentialStatus.ACTIVE);

    const [event] = credential.domainEvents;
    expect(event.eventType).toBe('credential.verified');
    expect(JSON.stringify(payloadOf(event))).not.toContain(PASSWORD);
  });

  it('releases an expired lock', () => {
    const hasher = new FakePasswordHasher();
    const credential = makeCredential(hasher);
    const lockedAt = new Date('2026-03-03T12:00:00.000Z');
    for (let attempt = 0; attempt < LOCKOUT.maxFailedAttempts; attempt += 1) {
      credential.recordFailure(LOCKOUT, lockedAt);
    }
    expect(credential.status).toBe(CredentialStatus.LOCKED);

    const afterExpiry = new Date(lockedAt.getTime() + LOCKOUT.lockoutSec * 1000 + 1);
    credential.recordVerification(afterExpiry);

    expect(credential.status).toBe(CredentialStatus.ACTIVE);
    expect(credential.lockedUntil).toBeNull();
  });

  it('refuses to verify a revoked credential', () => {
    const credential = makeCredential(new FakePasswordHasher());
    credential.revoke('user request');

    expect(() => credential.recordVerification()).toThrow(/revoked/);
  });
});

describe('PasswordCredential.recordFailure', () => {
  it('counts attempts and emits one credential.failed per attempt', () => {
    const credential = makeCredential(new FakePasswordHasher());

    credential.recordFailure(LOCKOUT);
    expect(credential.failedAttempts).toBe(1);
    expect(credential.status).toBe(CredentialStatus.ACTIVE);

    const [event] = credential.domainEvents;
    expect(event.eventType).toBe('credential.failed');
    expect(payloadOf<{ attempt: number }>(event).attempt).toBe(1);
  });

  it('locks at the threshold and reports the remaining seconds', () => {
    const credential = makeCredential(new FakePasswordHasher());
    const now = new Date('2026-03-03T12:00:00.000Z');

    for (let attempt = 0; attempt < LOCKOUT.maxFailedAttempts; attempt += 1) {
      credential.recordFailure(LOCKOUT, now);
    }

    expect(credential.status).toBe(CredentialStatus.LOCKED);
    expect(credential.isLocked(now)).toBe(true);
    expect(credential.retryAfterSeconds(now)).toBe(LOCKOUT.lockoutSec);
    expect(credential.isVerifiable(now)).toBe(false);
  });

  it('keeps counting past the threshold, so a running attack keeps extending the lock', () => {
    // Deleting the attempt log at the threshold would hand an attacker a free restart after
    // every fifth guess — and silence the `credential.failed` stream that makes it visible.
    const credential = makeCredential(new FakePasswordHasher());
    const start = new Date('2026-03-03T12:00:00.000Z');

    for (let attempt = 0; attempt < LOCKOUT.maxFailedAttempts + 4; attempt += 1) {
      credential.recordFailure(LOCKOUT, start);
    }

    expect(credential.failedAttempts).toBe(LOCKOUT.maxFailedAttempts + 4);
    expect(credential.domainEvents).toHaveLength(LOCKOUT.maxFailedAttempts + 4);
  });

  it('treats a lock with no expiry as permanent rather than failing open', () => {
    const hasher = new FakePasswordHasher();
    const credential = PasswordCredential.fromRow(
      {
        ...rowOf(makeCredential(hasher)),
        status: 'locked',
        locked_until: null,
      },
      hasher,
    );

    // Failing open on a malformed row would hand an attacker the very credential the row was
    // meant to protect.
    expect(credential.isLocked()).toBe(true);
    expect(credential.isVerifiable()).toBe(false);
  });

  it('lifts a lock on its own once the window passes — no sweeper required', () => {
    const hasher = new FakePasswordHasher();
    const now = new Date('2026-03-03T12:00:00.000Z');
    const credential = makeCredential(hasher);
    for (let attempt = 0; attempt < LOCKOUT.maxFailedAttempts; attempt += 1) {
      credential.recordFailure(LOCKOUT, now);
    }

    // A user who mistypes six passwords must be able to sign in again; making them wait for
    // a background job to flip a column would be a lockout nobody asked for.
    const later = new Date(now.getTime() + LOCKOUT.lockoutSec * 1000 + 1);
    expect(credential.isLocked(later)).toBe(false);
    expect(credential.isVerifiable(later)).toBe(true);
  });
});

describe('PasswordCredential.replaceSecret', () => {
  it('installs the hash and clears the failure run and the lock', () => {
    const hasher = new FakePasswordHasher();
    const credential = makeCredential(hasher);
    for (let attempt = 0; attempt < LOCKOUT.maxFailedAttempts; attempt += 1) {
      credential.recordFailure(LOCKOUT);
    }
    credential.clearDomainEvents();

    const next = hashWith({ ...CURRENT_PARAMETERS, memoryCost: 99_999 });
    credential.replaceSecret(next, CredentialRotation.REHASHED);

    expect(credential.digest).toBe(next.digest);
    expect(credential.hashParameters.memoryCost).toBe(99_999);
    expect(credential.failedAttempts).toBe(0);
    expect(credential.lockedUntil).toBeNull();
    expect(credential.status).toBe(CredentialStatus.ACTIVE);

    const [event] = credential.domainEvents;
    expect(event.eventType).toBe('credential.rotated');
    expect(payloadOf<{ clearedLock: boolean }>(event).clearedLock).toBe(true);
  });

  it('refuses to resurrect a revoked credential — a new secret means a new credential', () => {
    const credential = makeCredential(new FakePasswordHasher());
    credential.revoke('fraud');

    expect(() =>
      credential.replaceSecret(hashWith(), CredentialRotation.CHANGED),
    ).toThrow(/revoked/);
  });
});

describe('PasswordCredential.revoke', () => {
  it('records why and when, and makes the credential unusable', () => {
    const credential = makeCredential(new FakePasswordHasher());
    const now = new Date('2026-03-03T12:00:00.000Z');

    credential.revoke('password reset requested', now);

    expect(credential.status).toBe(CredentialStatus.REVOKED);
    expect(credential.revokedReason).toBe('password reset requested');
    expect(credential.revokedAt).toEqual(now);
    expect(credential.isVerifiable()).toBe(false);
  });

  it('is idempotent — revoking twice is not two events', () => {
    const credential = makeCredential(new FakePasswordHasher());
    credential.revoke('first');
    credential.clearDomainEvents();

    credential.revoke('second');

    expect(credential.domainEvents).toHaveLength(0);
    expect(credential.revokedReason).toBe('first');
  });
});

describe('PasswordCredential.fromRow', () => {
  it('rehydrates without emitting events — the write already happened', () => {
    const hasher = new FakePasswordHasher();
    const credential = PasswordCredential.fromRow(rowOf(makeCredential(hasher)), hasher);

    expect(credential.domainEvents).toHaveLength(0);
    expect(credential.id.value).toBe(CREDENTIAL_ID);
    expect(credential.version).toBe(1);
  });

  it('falls back to current parameters when the JSON column cannot be read', () => {
    // `secret_parameters` is JSON, so its contents are whatever wrote them. Guessing them
    // could rehash a perfectly valid credential for nothing, so the fallback is "current
    // policy", which makes needsRehash answer false and leaves the hash alone.
    const hasher = new FakePasswordHasher();
    const credential = PasswordCredential.fromRow(
      { ...rowOf(makeCredential(hasher)), secret_parameters: 'not-an-object' },
      hasher,
    );

    expect(credential.hashParameters).toEqual(CURRENT_PARAMETERS);
    expect(credential.needsRehash()).toBe(false);
  });
});

describe('PasswordCredential versioning', () => {
  it('bumps the version on every mutation and rehydrates it from the column', () => {
    const hasher = new FakePasswordHasher();
    const credential = makeCredential(hasher);
    const start = credential.version;

    credential.recordVerification();
    credential.recordFailure(LOCKOUT);
    credential.replaceSecret(hashWith(), CredentialRotation.CHANGED);

    expect(credential.version).toBe(start + 3);

    // `AggregateRoot.version` derives from the buffered events and a repository drains that
    // buffer before it reads the row, so this override is the only thing that keeps the
    // outbox dedup key monotonic across saves.
    const afterSave = credential.version;
    credential.clearDomainEvents();
    expect(credential.version).toBe(afterSave);
  });

  it('gives every buffered event a distinct version', () => {
    const credential = makeCredential(new FakePasswordHasher());
    credential.recordVerification();
    credential.recordFailure(LOCKOUT);

    const versions = credential.domainEvents.map((event) => event.version);
    expect(new Set(versions).size).toBe(2);
  });
});

function rowOf(credential: PasswordCredential): PasswordCredentialRow {
  return {
    id: credential.id.value,
    user_id: credential.userId,
    identifier: credential.identifier,
    method: credential.method,
    secret_hash: credential.digest,
    secret_parameters: credential.hashParameters,
    status: credential.status,
    failed_attempts: credential.failedAttempts,
    locked_until: credential.lockedUntil,
    last_verified_at: credential.lastVerifiedAt,
    revoked_at: credential.revokedAt,
    revoked_reason: credential.revokedReason,
    version: credential.version,
    created_at: credential.createdAt,
    updated_at: credential.updatedAt,
  };
}