/**
 * @fileoverview Storage port for {@link RecoveryCodeSet}.
 *
 * @remarks Two write paths rather than one, because they are genuinely different operations.
 * {@link replace} discards a generation and installs another — a rotation, safe to repeat.
 * {@link consumeCode} spends exactly one row and reports whether *this* caller was the one
 * that spent it, which is what makes single-use hold under concurrency.
 */

import type { RecoveryCodeSet } from '../recovery-code-set.aggregate';

export const RECOVERY_CODE_SET_REPOSITORY = Symbol('RECOVERY_CODE_SET_REPOSITORY');

export interface RecoveryCodeSetRepositoryPort {
  /**
   * Installs `set` as *the* user's set, discarding any previous one.
   *
   * @remarks Destructive on purpose, and that is the whole of what "regenerating invalidates
   * the previous set" means. Merging the new codes into the old ones would leave every code
   * an attacker had photographed working, which is the opposite of what a user rotates for.
   *
   * @remarks The unique `user_id` on `mfa_recovery_code_sets` is what makes "the user's set"
   * singular; the delete is ordered before the insert so the constraint is never violated.
   */
  replace(set: RecoveryCodeSet): Promise<void>;

  /**
   * Persists the spend markers and the pending events, leaving the generation alone.
   *
   * @remarks Separate from {@link replace} because the two are different operations: one
   * throws away a generation, the other burns a single row. Routing a spend through
   * `replace` would re-insert every sibling code on every verification and turn a
   * single-use check into a full rewrite of the set.
   */
  save(set: RecoveryCodeSet): Promise<void>;

  findByUser(userId: string): Promise<RecoveryCodeSet | null>;

  /**
   * Spends one code, atomically.
   *
   * @returns `true` when this caller was the one that spent it, `false` when it was already
   * gone. False is the honest answer under concurrency, and the handler turns it into a
   * rejection rather than a success.
   */
  consumeCode(setId: string, codeIndex: number, now: Date): Promise<boolean>;
}