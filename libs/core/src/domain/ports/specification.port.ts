import { DomainError } from '../errors/domain-error';

/**
 * Composite predicates for expressing read-side queries in the domain's language
 * ("active users", "users in a tenant") rather than in query-builder syntax.
 */
export abstract class Specification<TEntity> {
  abstract isSatisfiedBy(entity: TEntity): boolean;

  and(other: Specification<TEntity>): Specification<TEntity> {
    return new AndSpecification(this, other);
  }

  or(other: Specification<TEntity>): Specification<TEntity> {
    return new OrSpecification(this, other);
  }

  not(): Specification<TEntity> {
    return new NotSpecification(this);
  }

  /** Throws when the predicate is rejected — for guards that read better as assertions. */
  assert(entity: TEntity, message: string): void {
    if (!this.isSatisfiedBy(entity)) {
      throw new DomainError('INVARIANT_VIOLATION', message);
    }
  }
}

/**
 * Combinators are named classes rather than inline anonymous subclasses.
 *
 * @remarks The obvious way to write `and` captures `const self = this` and returns an object
 * literal extending the class. That trips `no-this-alias`, and more importantly produces a new
 * anonymous class on every call, which makes the predicate unreadable in a stack trace and in
 * test failure output.
 */
class AndSpecification<TEntity> extends Specification<TEntity> {
  constructor(
    private readonly left: Specification<TEntity>,
    private readonly right: Specification<TEntity>,
  ) {
    super();
  }

  isSatisfiedBy(entity: TEntity): boolean {
    return this.left.isSatisfiedBy(entity) && this.right.isSatisfiedBy(entity);
  }
}

class OrSpecification<TEntity> extends Specification<TEntity> {
  constructor(
    private readonly left: Specification<TEntity>,
    private readonly right: Specification<TEntity>,
  ) {
    super();
  }

  isSatisfiedBy(entity: TEntity): boolean {
    return this.left.isSatisfiedBy(entity) || this.right.isSatisfiedBy(entity);
  }
}

class NotSpecification<TEntity> extends Specification<TEntity> {
  constructor(private readonly inner: Specification<TEntity>) {
    super();
  }

  isSatisfiedBy(entity: TEntity): boolean {
    return !this.inner.isSatisfiedBy(entity);
  }
}

export class PredicateSpecification<TEntity> extends Specification<TEntity> {
  constructor(private readonly predicate: (entity: TEntity) => boolean) {
    super();
  }

  isSatisfiedBy(entity: TEntity): boolean {
    return this.predicate(entity);
  }
}