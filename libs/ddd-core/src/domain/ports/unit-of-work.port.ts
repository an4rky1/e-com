/**
 * @fileoverview Transaction boundary.
 *
 * Why: "save the aggregate and its events together" is only true if both run inside one
 * transaction. Handing the business transaction to the persistence adapter (rather than
 * letting handlers open `$transaction` themselves) is what makes that guarantee hold at
 * every call site instead of only the ones that remembered.
 */

export interface IUnitOfWork {
  /**
   * Runs `fn` inside a transaction.
   *
   * @remarks Nesting is not supported. Calling `runInTransaction` from inside an existing
   * transaction silently joins the outer one, which makes rollback behaviour depend on
   * where the outer call happened — re-entrant calls must reuse the ambient transaction
   * via {@link getCurrent}, never open a second one.
   */
  runInTransaction<TResult>(fn: () => Promise<TResult>): Promise<TResult>;

  /** True when `fn` is already executing inside a transaction. */
  isActive(): boolean;
}

export interface IClock {
  now(): Date;
  /** Milliseconds since the Unix epoch, for backoff and token arithmetic. */
  timestamp(): number;
}