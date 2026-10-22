import type { Policy } from '../policy.aggregate';

export const POLICY_REPOSITORY = Symbol('POLICY_REPOSITORY');

/**
 * Storage port for the Policy aggregate.
 *
 * @remarks Policies are read on every authorisation decision that reaches the ABAC half, so
 * the read methods are scoped by role: a decision never needs a policy belonging to a role
 * the user does not hold.
 */
export interface PolicyRepositoryPort {
  /** Persists the policy and writes its pending domain events in the same transaction. */
  save(policy: Policy): Promise<void>;

  findById(id: string): Promise<Policy | null>;

  findByRole(role: string): Promise<Policy[]>;

  findByRoles(roles: readonly string[]): Promise<Policy[]>;

  /** Highest priority first, so the caller sees the most specific rules before the rest. */
  findAll(): Promise<Policy[]>;

  countByRole(role: string): Promise<number>;

  count(): Promise<number>;

  /**
   * Removes the rule and writes its pending events in the same transaction.
   *
   * @remarks Takes the aggregate rather than an id so the `policy.deleted` fact cannot be
   * separated from the delete — a rule that stops constraining decisions is exactly the fact
   * another service needs to hear about.
   */
  delete(policy: Policy): Promise<void>;
}