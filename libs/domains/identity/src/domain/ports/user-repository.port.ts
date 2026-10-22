import type { User } from '../user.aggregate';
import type { ISpecification } from '@auth/ddd-core';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

/**
 * Storage port for the User aggregate.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the aggregate can
 * ask to be persisted without knowing that Postgres exists — and so the unit tests can use a
 * plain object instead of a database.
 */
export interface UserRepositoryPort {
  /**
   * Persists the user and writes its pending domain events in the same transaction.
   *
   * @remarks Both halves must commit together. Writing the row and the events separately
   * leaves a window where the account exists but the `user.registered` event never fires, and
   * notification and access-control never learn the user exists.
   */
  save(user: User): Promise<void>;

  findById(id: string): Promise<User | null>;

  /**
   * Case-insensitive lookup.
   *
   * @remarks Matches the `lower(email)` unique index. Sign-in is case-insensitive in every
   * provider worth supporting, so a case-sensitive query here would produce duplicate
   * accounts that cannot both be signed into.
   */
  findByEmail(email: string): Promise<User | null>;

  existsByEmail(email: string): Promise<boolean>;

  find(spec: UserSpecification): Promise<User[]>;

  count(spec: UserSpecification): Promise<number>;
}

/**
 * Predicate over users.
 *
 * @remarks In-memory predicates rather than query-builder fragments: a specification has to
 * be evaluable in a unit test without a database, which is the only way the domain rules stay
 * honest.
 */
export abstract class UserSpecification implements ISpecification<User> {
  abstract isSatisfiedBy(user: User): boolean;

  and(other: UserSpecification): UserSpecification {
    return new AndUserSpecification(this, other);
  }

  or(other: UserSpecification): UserSpecification {
    return new OrUserSpecification(this, other);
  }

  not(): UserSpecification {
    return new NotUserSpecification(this);
  }
}

/**
 * Named combinator classes rather than inline anonymous subclasses.
 *
 * @remarks Capturing `this` into a local and returning an object literal trips
 * `no-this-alias`, and would mint a fresh anonymous class on every call — unreadable in a
 * stack trace and in assertion diffs.
 */
class AndUserSpecification extends UserSpecification {
  constructor(
    private readonly left: UserSpecification,
    private readonly right: UserSpecification,
  ) {
    super();
  }

  isSatisfiedBy(user: User): boolean {
    return this.left.isSatisfiedBy(user) && this.right.isSatisfiedBy(user);
  }
}

class OrUserSpecification extends UserSpecification {
  constructor(
    private readonly left: UserSpecification,
    private readonly right: UserSpecification,
  ) {
    super();
  }

  isSatisfiedBy(user: User): boolean {
    return this.left.isSatisfiedBy(user) || this.right.isSatisfiedBy(user);
  }
}

class NotUserSpecification extends UserSpecification {
  constructor(private readonly inner: UserSpecification) {
    super();
  }

  isSatisfiedBy(user: User): boolean {
    return !this.inner.isSatisfiedBy(user);
  }
}

export class ByStatus extends UserSpecification {
  constructor(private readonly status: User['status']) {
    super();
  }

  isSatisfiedBy(user: User): boolean {
    return user.status === this.status;
  }
}

export class NotDeleted extends UserSpecification {
  isSatisfiedBy(user: User): boolean {
    return !user.isDeleted;
  }
}