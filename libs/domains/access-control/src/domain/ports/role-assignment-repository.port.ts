import type { RoleAssignment } from '../role-assignment.aggregate';

export const ROLE_ASSIGNMENT_REPOSITORY = Symbol('ROLE_ASSIGNMENT_REPOSITORY');

/**
 * Storage port for the RoleAssignment aggregate.
 *
 * @remarks Reads are filtered on `revoked_at IS NULL` in the query rather than in the
 * aggregate: an operator listing a user's active roles should not have to load every
 * historical grant to find the current ones.
 */
export interface RoleAssignmentRepositoryPort {
  /**
   * Persists the assignment and writes its pending domain events in the same transaction.
   *
   * @remarks `role.granted` and `role.revoked` are the only facts other services learn
   * access from, so a grant that is durable but unannounced is a permission the rest of the
   * platform never hears about.
   */
  save(assignment: RoleAssignment): Promise<void>;

  findById(id: string): Promise<RoleAssignment | null>;

  /**
   * The live assignment of this role to this user, if there is one.
   *
   * @remarks Uniqueness is enforced here rather than by a database index because
   * `role_assignments` carries no such constraint: a grant is a command that may be replayed
   * (a retried request, an at-least-once message) and the second one has to be a no-op, not
   * a second row that makes the permission appear twice in a claim.
   */
  findActiveByUserAndRole(userId: string, role: string): Promise<RoleAssignment | null>;

  /** Every live assignment — expired and revoked grants are excluded. */
  findActiveByUser(userId: string): Promise<RoleAssignment[]>;

  countActiveByUser(userId: string): Promise<number>;
}