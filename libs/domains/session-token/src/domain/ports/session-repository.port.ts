import type { ISpecification } from '@auth/ddd-core';
import type { IssuedRefreshToken } from '../refresh-token.entity';
import type { Session } from '../session.aggregate';

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');

/** A presented refresh token together with the session that owns it. */
export interface RefreshTokenMatch {
  readonly session: Session;
  readonly token: IssuedRefreshToken;
}

/**
 * Storage port for the Session aggregate.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the aggregate can ask
 * to be persisted without knowing that Postgres exists — and so the unit tests can use a
 * plain object instead of a database.
 */
export interface SessionRepositoryPort {
  /**
   * Persists one session and writes its pending domain events in the same transaction.
   *
   * @remarks Both halves must commit together. Writing the row and the events separately
   * leaves a window where the session exists but `session.issued` never fires, and
   * account-security never learns a login happened.
   */
  save(session: Session): Promise<void>;

  /**
   * Persists several sessions atomically.
   *
   * @remarks The port exists for the two operations that touch more than one session —
   * revoke-all-but-current and family-wide reuse revocation — and both are all-or-nothing by
   * definition. Saving them one at a time would allow a crash halfway through to leave a user
   * half signed out, or half protected.
   */
  saveMany(sessions: readonly Session[]): Promise<void>;

  findById(id: string): Promise<Session | null>;

  find(spec: SessionSpecification): Promise<Session[]>;

  count(spec: SessionSpecification): Promise<number>;

  /**
   * Sessions a user can still use, optionally excluding the caller's own.
   *
   * @remarks Exclusion is a filter rather than a post-processing step so the excluded session
   * is never loaded — a caller passing its own id must not be able to revoke itself by
   * accident, and not fetching it is the cheapest way to be sure it is not touched.
   */
  findActiveByUser(userId: string, exceptSessionId?: string): Promise<Session[]>;

  /**
   * Every session sharing a token family.
   *
   * @remarks The reuse path loads exactly this set before revoking it. Missing a member
   * leaves a live session behind after a theft, so the filter is on the family id and nothing
   * else — not on status, not on expiry.
   */
  findByFamilyId(tokenFamilyId: string): Promise<Session[]>;

  /**
   * Locates a presented refresh token by its digest.
   *
   * @remarks The digest is the only thing available at the boundary: the caller holds the
   * secret and nothing else. Returns `null` rather than throwing so the caller can tell an
   * unknown token from a known-but-consumed one — the difference between "you sent nonsense"
   * and "someone replayed a token", which is a security event.
   */
  findRefreshTokenByDigest(digest: string): Promise<RefreshTokenMatch | null>;
}

/**
 * Predicate over sessions.
 *
 * @remarks In-memory predicates rather than query-builder fragments: a specification has to
 * be evaluable in a unit test without a database, which is the only way the domain rules stay
 * honest.
 */
export abstract class SessionSpecification implements ISpecification<Session> {
  abstract isSatisfiedBy(session: Session): boolean;

  and(other: SessionSpecification): SessionSpecification {
    return combined(
      (session) => this.isSatisfiedBy(session) && other.isSatisfiedBy(session),
    );
  }

  or(other: SessionSpecification): SessionSpecification {
    return combined(
      (session) => this.isSatisfiedBy(session) || other.isSatisfiedBy(session),
    );
  }

  not(): SessionSpecification {
    return combined((session) => !this.isSatisfiedBy(session));
  }
}

/**
 * A specification built from a predicate rather than a subclass.
 *
 * @remarks The combinators capture `this` in an arrow function instead of aliasing it to a
 * local: the alias compiles identically but reads as a workaround, and there is nothing to
 * work around here.
 */
function combined(
  predicate: (session: Session) => boolean,
): SessionSpecification {
  return new (class extends SessionSpecification {
    isSatisfiedBy(session: Session): boolean {
      return predicate(session);
    }
  })();
}

export class ByUser extends SessionSpecification {
  constructor(private readonly userId: string) {
    super();
  }

  isSatisfiedBy(session: Session): boolean {
    return session.userId === this.userId;
  }
}

export class ByStatus extends SessionSpecification {
  constructor(private readonly status: Session['status']) {
    super();
  }

  isSatisfiedBy(session: Session): boolean {
    return session.status === this.status;
  }
}

/** Still usable and still inside its lifetime — the predicate an operator listing wants. */
export class ActiveSessions extends SessionSpecification {
  constructor(private readonly now: Date = new Date()) {
    super();
  }

  isSatisfiedBy(session: Session): boolean {
    return session.isActive && !session.isExpiredAt(this.now);
  }
}