/**
 * @fileoverview Storage port for the ApiKey aggregate.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the aggregate can ask
 * to be persisted without knowing that Postgres exists — and so the unit tests can use a
 * plain object instead of a database.
 */
import type { ISpecification } from '@auth/ddd-core';
import type { ApiKey } from '../api-key.aggregate';

export const API_KEY_REPOSITORY = Symbol('API_KEY_REPOSITORY');

export interface ApiKeyRepositoryPort {
  /**
   * Persists one key and writes its pending domain events in the same transaction.
   *
   * @remarks Both halves must commit together. Writing the row and the events separately
   * leaves a window where the key exists but `api_key.created` never fires, and no consumer
   * ever learns it was issued.
   */
  save(key: ApiKey): Promise<void>;

  /**
   * Persists several keys atomically.
   *
   * @remarks The port exists for rotation, which changes two rows by definition: the new key
   * is useless until the old one stops working, and the old one is a live credential until it
   * does. Saving them one at a time allows a crash between the two to leave an owner with two
   * working keys or none.
   */
  saveMany(keys: readonly ApiKey[]): Promise<void>;

  findById(id: string): Promise<ApiKey | null>;

  /**
   * Locates a key by the prefix a presented credential carries.
   *
   * @remarks The prefix is unique, non-secret and non-guessable, which is what lets
   * authentication cost one indexed lookup instead of a scan of every digest. The digest
   * remains the *check*: a caller holding a real prefix and a wrong body still fails.
   */
  findByPrefix(prefix: string): Promise<ApiKey | null>;

  findByUser(userId: string): Promise<ApiKey[]>;

  /** The `(user_id, name)` unique index, checked up front so the common case is a clean 409. */
  existsByName(userId: string, name: string): Promise<boolean>;

  find(spec: ApiKeySpecification): Promise<ApiKey[]>;

  count(spec: ApiKeySpecification): Promise<number>;
}

/**
 * Predicate over api keys.
 *
 * @remarks In-memory predicates rather than query-builder fragments: a specification has to
 * be evaluable in a unit test without a database, which is the only way the domain rules stay
 * honest.
 */
export abstract class ApiKeySpecification implements ISpecification<ApiKey> {
  abstract isSatisfiedBy(key: ApiKey): boolean;

  and(other: ApiKeySpecification): ApiKeySpecification {
    return new CompositeApiKeySpecification(
      (key) => this.isSatisfiedBy(key),
      (key) => other.isSatisfiedBy(key),
      (left, right) => left && right,
    );
  }

  or(other: ApiKeySpecification): ApiKeySpecification {
    return new CompositeApiKeySpecification(
      (key) => this.isSatisfiedBy(key),
      (key) => other.isSatisfiedBy(key),
      (left, right) => left || right,
    );
  }

  not(): ApiKeySpecification {
    return new CompositeApiKeySpecification(
      (key) => this.isSatisfiedBy(key),
      () => true,
      (left) => !left,
    );
  }
}

/**
 * Two predicates and how to join them.
 *
 * @remarks Predicates rather than a pair of specifications, so the combination closes over its
 * operands instead of aliasing `this` into a local — which reads better and keeps the composition
 * reusable for a predicate that is not itself a specification.
 */
class CompositeApiKeySpecification extends ApiKeySpecification {
  constructor(
    private readonly left: (key: ApiKey) => boolean,
    private readonly right: (key: ApiKey) => boolean,
    private readonly combine: (left: boolean, right: boolean) => boolean,
  ) {
    super();
  }

  isSatisfiedBy(key: ApiKey): boolean {
    return this.combine(this.left(key), this.right(key));
  }
}

/** Keys that are neither revoked nor past their deadline. */
export class UsableKeys extends ApiKeySpecification {
  constructor(private readonly now: Date = new Date()) {
    super();
  }

  isSatisfiedBy(key: ApiKey): boolean {
    return key.isUsableAt(this.now);
  }
}

/** Everything a user owns, revoked and expired included — a revocation is a record, not a deletion. */
export class ByUser extends ApiKeySpecification {
  constructor(private readonly userId: string) {
    super();
  }

  isSatisfiedBy(key: ApiKey): boolean {
    return key.userId === this.userId;
  }
}