import type { Role } from '../role.aggregate';

export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');

/**
 * Storage port for the Role aggregate.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the aggregate can ask
 * to be persisted without knowing that Postgres exists — and so the unit tests can use a
 * plain object instead of a database.
 */
export interface RoleRepositoryPort {
  /**
   * Persists the role and writes its pending domain events in the same transaction.
   *
   * @remarks Both halves must commit together. Writing the row and the events separately
   * leaves a window where a role exists that nobody has been told about, and a consumer that
   * mints permission claims from events would keep serving the old set.
   */
  save(role: Role): Promise<void>;

  /** Exact match: role names are lower-cased on the way in, so lookup is case-insensitive. */
  findByName(name: string): Promise<Role | null>;

  existsByName(name: string): Promise<boolean>;

  /**
   * Several roles in one round trip.
   *
   * @remarks Answering "what does this user hold" is a single question asked on every
   * authenticated request; one query per role turns it into N, and N is the number of roles
   * an administrator has accumulated.
   */
  findByNames(names: readonly string[]): Promise<Role[]>;

  /** Ordered by name so a listing is stable between pages. */
  findAll(): Promise<Role[]>;

  count(): Promise<number>;

  /**
   * Hard-deletes a role and, by cascade, its assignments and policies.
   *
   * @remarks Takes the aggregate rather than an id so the `role.deleted` fact is written in
   * the same transaction as the delete, and unreachable for a system role: the guard lives
   * on {@link Role.remove}, and a caller that skips it would take the platform's baseline
   * authorisation with it.
   */
  delete(role: Role): Promise<void>;
}