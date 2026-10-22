/**
 * @fileoverview Storage port for the {@link MfaFactor} aggregate.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the aggregate can ask
 * to be persisted without knowing that Postgres exists — and so the unit suite can use a plain
 * object instead of a database.
 */

import type { MfaMethod } from '../value-objects/mfa-method.vo';
import type { MfaFactor } from '../mfa-factor.aggregate';

export const MFA_FACTOR_REPOSITORY = Symbol('MFA_FACTOR_REPOSITORY');

export interface MfaFactorRepositoryPort {
  /**
   * Persists the factor, its spent-step marker and its pending domain events.
   *
   * @remarks All three halves commit together. A verification that advanced the factor without
   * recording the spent counter would let the same code through twice — the counter *is* the
   * replay defence, so writing it separately from the factor it protects is the one thing that
   * cannot be allowed to happen.
   *
   * @remarks Joins whatever transaction is already open. The aggregate's consistency boundary
   * spans `mfa_factors` and `totp_used_counters`, so this method must never open one of its
   * own.
   */
  save(factor: MfaFactor): Promise<void>;

  /**
   * Loads a factor with its spent-step marker.
   *
   * @remarks The include is not optional and not a "nice to have". Rehydration without the
   * counter resets the replay guard to `null`, which silently accepts every previously spent
   * code — a bug that would only ever appear as "sometimes a replayed code works".
   */
  findById(id: string): Promise<MfaFactor | null>;

  /** Every factor a user holds, newest first, including disabled ones. */
  findByUser(userId: string): Promise<MfaFactor[]>;

  /** The user's active factor for a method, if there is exactly one. */
  findActiveByUserAndMethod(
    userId: string,
    method: MfaMethod,
  ): Promise<MfaFactor | null>;

  /** Row count, for the readiness probe. */
  count(): Promise<number>;
}