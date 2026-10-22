/**
 * @fileoverview In-memory doubles for the api-key ports.
 *
 * @remarks Hand-written rather than auto-mocked, for the same reason credential-vault's are: a
 * mock asserts on the calls a test *expects*, while the question these suites keep asking is
 * "what would be stored, and what would be published" — and only the resulting state answers
 * that.
 *
 * @remarks The repository stores **rehydrated rows**, not the aggregates it was handed. That is
 * load-bearing: an assertion about `last_used_at` or about a revoked key then proves the
 * transition reached storage, rather than proving it is sitting in an object the handler still
 * holds. It also runs `fromRow` on every read, which is where a column renamed on one side only
 * would show up.
 */

import { createHash } from 'node:crypto';
import type { IDomainEvent } from '@auth/ddd-core';
import type {
  ApiKeyRepositoryPort,
  ApiKeySpecification,
} from '../../src/domain/ports/api-key-repository.port';
import type { ApiKeyCryptoPort } from '../../src/domain/ports/api-key-crypto.port';
import { ApiKey, type ApiKeyRow } from '../../src/domain/api-key.aggregate';
import { ApiKeySecret, type IssuedApiKeyMaterial } from '../../src/domain/value-objects/api-key-secret.vo';
import type { ApiKeyPrefix } from '../../src/domain/value-objects/api-key-prefix.vo';
import { NodeApiKeyCrypto } from '../../src/infrastructure/crypto/node-api-key.crypto';
import type { ApiKeyConfig } from '../../src/api-key.config';

export const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const OTHER_USER_ID = '2b6f8a19-3c4d-4e5f-8a7b-9c0d1e2f3a4b';

/** 2023-11-14T22:13:20.000Z — every deadline in the suite is stated relative to this. */
export const T0 = new Date('2023-11-14T22:13:20.000Z');

export const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1_000);

/** A config object built literally, so no test ever reads `process.env`. */
export const testApiKeyConfig = (overrides: Partial<ApiKeyConfig> = {}): ApiKeyConfig => ({
  defaultTtlSec: 2_592_000,
  maxTtlSec: 31_536_000,
  keyFamily: 'test',
  trackLastUsed: true,
  maxPageSize: 100,
  ...overrides,
});

/** One row the repository would have written to `outbox_events`. */
export interface CapturedOutboxEvent {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly eventId: string;
  readonly dedupKey: string;
  readonly topic: string | null;
  readonly payload: unknown;
}

export class InMemoryApiKeyRepository implements ApiKeyRepositoryPort {
  /** Stored rows, rehydrated — what a later request would actually load. */
  readonly rows = new Map<string, ApiKeyRow>();

  /** Every aggregate handed to `save`, in call order. */
  readonly saved: ApiKey[] = [];

  /** Transaction boundaries. A rotation must add exactly one. */
  commits = 0;

  readonly outbox: CapturedOutboxEvent[] = [];

  constructor(
    seed: readonly ApiKey[] = [],
    private readonly topics: Readonly<Record<string, string>> = {},
  ) {
    for (const key of seed) {
      // A seeded key stands for a row that is already in the database, so its events have
      // already been published. Draining them keeps assertions about "what did *this* command
      // announce" from being polluted by the fixture.
      key.clearDomainEvents();
      this.rows.set(key.id.value, key.toRow());
    }
  }

  async save(key: ApiKey): Promise<void> {
    await this.saveMany([key]);
  }

  /**
   * Mirrors the real repository: one boundary for the whole batch, events drained on write.
   *
   * @remarks The drain order is the real one — buffered events go to the outbox, then the row
   * lands — because a repository that wrote the row and kept the events would produce a key no
   * consumer ever hears about.
   */
  async saveMany(keys: readonly ApiKey[]): Promise<void> {
    if (keys.length === 0) return;
    this.commits += 1;

    for (const key of keys) {
      const events = key.clearDomainEvents();
      this.saved.push(key);
      this.rows.set(key.id.value, key.toRow());

      for (const event of events) {
        this.outbox.push(capture(event, this.topics));
      }
    }
  }

  async findById(id: string): Promise<ApiKey | null> {
    const row = this.rows.get(id);
    return row ? ApiKey.fromRow(row) : null;
  }

  async findByPrefix(prefix: string): Promise<ApiKey | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.prefix === prefix);
    return row ? ApiKey.fromRow(row) : null;
  }

  async findByUser(userId: string): Promise<ApiKey[]> {
    return [...this.rows.values()]
      .filter((row) => row.user_id === userId)
      .map((row) => ApiKey.fromRow(row));
  }

  async existsByName(userId: string, name: string): Promise<boolean> {
    const trimmed = name.trim();
    return [...this.rows.values()].some(
      (row) => row.user_id === userId && row.name === trimmed,
    );
  }

  async find(spec: ApiKeySpecification): Promise<ApiKey[]> {
    return [...this.rows.values()]
      .map((row) => ApiKey.fromRow(row))
      .filter((key) => spec.isSatisfiedBy(key));
  }

  async count(spec: ApiKeySpecification): Promise<number> {
    return (await this.find(spec)).length;
  }
}

/**
 * The real crypto port.
 *
 * @remarks Not a fake: the properties under test — a real digest, a real CSPRNG, a real
 * constant-time comparison — are properties of `node:crypto` and cannot be asserted against a
 * stand-in. The tests that use it are fast because SHA-256 over 50 bytes is.
 */
export const realCrypto = (): ApiKeyCryptoPort => new NodeApiKeyCrypto();

/**
 * A deterministic stand-in for the crypto port.
 *
 * @remarks For the suites that are not about cryptography — handlers, authentication, guard —
 * where asserting on "the digest is the SHA-256 of the key" would be testing `node:crypto`
 * twice. Its `verifyKey` is the real algorithm's *shape*: a length check before the comparison.
 */
export class FakeApiKeyCrypto implements ApiKeyCryptoPort {
  readonly issued: IssuedApiKeyMaterial[] = [];
  private counter = 0;

  issueMaterial(family: ApiKeyPrefix): IssuedApiKeyMaterial {
    this.counter += 1;
    const prefix = `${family}_${String(this.counter).padStart(8, '0')}`;
    // A real `ApiKeySecret`, because the aggregate and the format guard both treat it as one;
    // only the *digest* is faked.
    const secret = ApiKeySecret.create(`${prefix}_${'B'.repeat(43)}`);

    const material: IssuedApiKeyMaterial = {
      prefix,
      family,
      secret,
      // Opaque and deterministic, and specifically *not* the plaintext with a marker in front
      // of it: "no stored row contains the key" is an assertion these suites make, and a fake
      // digest that embedded the key would make that assertion pass or fail for the wrong
      // reason.
      digest: fakeDigest(secret.value),
    };

    this.issued.push(material);
    return material;
  }

  digest(candidate: string): string {
    return fakeDigest(candidate);
  }

  verifyKey(candidate: string, digest: string): boolean {
    // The length guard is the part under test elsewhere; keeping it here means a suite that
    // swaps in this double cannot accidentally pass with a comparison that would throw.
    if (digest.length !== this.digest(candidate).length) return false;
    return this.digest(candidate) === digest;
  }
}

/** A stand-in digest: real SHA-256, so nothing here is reversible and no key is embedded. */
const fakeDigest = (candidate: string): string =>
  createHash('sha256').update(candidate, 'utf8').digest('hex');

function capture(event: IDomainEvent, topics: Readonly<Record<string, string>>): CapturedOutboxEvent {
  const candidate = event as unknown as { payload?: unknown };
  return {
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    version: event.version,
    eventId: event.eventId,
    dedupKey: `${event.eventType}:${event.aggregateId}:${event.version}`,
    topic: topics[event.eventType] ?? null,
    payload: candidate.payload ?? {},
  };
}