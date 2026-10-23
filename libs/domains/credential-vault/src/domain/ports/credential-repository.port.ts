/**
 * @fileoverview Storage ports for credential-vault.
 *
 * @remarks Declared in the domain and implemented in infrastructure so the aggregate can ask
 * to be persisted without knowing that Postgres exists — and so the unit tests can use a
 * plain object instead of a database.
 */
import type { ISpecification } from '@auth/core';
import type { PasswordCredential } from '../password-credential.aggregate';
import type { RecoveryCodeSet } from '../recovery-code-set.aggregate';

export const CREDENTIAL_REPOSITORY = Symbol('CREDENTIAL_REPOSITORY');

export interface CredentialRepositoryPort {
  /**
   * Persists the credential and writes its pending domain events in the same transaction.
   *
   * @remarks Both halves must commit together. Writing the row and the events separately
   * leaves a window where a password is live but the `credential.rotated` event never fires,
   * and nothing downstream ever learns the secret changed.
   */
  save(credential: PasswordCredential): Promise<void>;

  /**
   * One transaction for the whole batch.
   *
   * @remarks A batch is not a loop of `save`s: revoking every credential of a user has to
   * either leave *all* of them revoked or none, and a sequence of independent transactions
   * could be interrupted halfway through.
   */
  saveAll(credentials: readonly PasswordCredential[]): Promise<void>;

  /**
   * Every credential of a user, newest first.
   *
   * @remarks By default revoked rows are included: an operator asking what a user holds needs
   * the retired rows too. Pass `includeRevoked: false` for the authentication path, where a
   * revoked row must not be mistaken for a usable one.
   */
  findByUser(
    userId: string,
    options?: { includeRevoked?: boolean },
  ): Promise<readonly PasswordCredential[]>;

  /**
   * The credential a presented password would be checked against.
   *
   * @remarks Returns the row whether or not it is revoked or locked: the caller must be able
   * to distinguish "no such credential" from "wrong password" for its own bookkeeping, but
   * it may not tell that difference to the person presenting the password.
   */
  findPasswordCredential(
    userId: string,
    identifier?: string,
  ): Promise<PasswordCredential | null>;

  findRecoveryCodeSet(userId: string): Promise<RecoveryCodeSet | null>;

  /**
   * Replaces a user's whole recovery-code set.
   *
   * @remarks Wholesale rather than incremental: regenerating is defined as invalidating the
   * previous codes, so a caller that *appends* would leave codes alive that the user has
   * already thrown away.
   */
  saveRecoveryCodeSet(set: RecoveryCodeSet): Promise<void>;

  /**
   * Retires every live credential of a user and deletes their recovery codes, in one
   * transaction.
   *
   * @remarks A single method rather than "load, revoke in a loop, save, then delete the codes"
   * in the handler, because the last step has to commit with the first. Splitting them leaves
   * an account whose password is gone and whose bypass codes still work — a state no caller
   * can observe and no user could undo.
   *
   * @returns the number of credentials actually revoked, which is zero for a user who holds
   * none. Already-revoked rows are skipped rather than counted: a second `revokeAll` must be
   * a no-op, not a fresh event per retired row.
   */
  revokeAllCredentials(input: {
    userId: string;
    reason: string;
    now?: Date;
  }): Promise<number>;

  /** Deletes a user's recovery codes. Used when every credential is revoked. */
  deleteRecoveryCodes(userId: string): Promise<void>;

  find(spec: CredentialSpecification): Promise<readonly PasswordCredential[]>;

  count(spec: CredentialSpecification): Promise<number>;
}

/**
 * Predicate over credentials.
 *
 * @remarks In-memory predicates rather than query-builder fragments: a specification has to
 * be evaluable in a unit test without a database, which is the only way the domain rules stay
 * honest.
 */
export abstract class CredentialSpecification implements ISpecification<PasswordCredential> {
  abstract isSatisfiedBy(credential: PasswordCredential): boolean;

  and(other: CredentialSpecification): CredentialSpecification {
    return new AndSpecification(this, other);
  }

  or(other: CredentialSpecification): CredentialSpecification {
    return new OrSpecification(this, other);
  }

  not(): CredentialSpecification {
    return new NotSpecification(this);
  }
}

/**
 * The three combinators as real classes rather than `const self = this` closures.
 *
 * @remarks An anonymous subclass capturing `this` in a local reads well and breaks the moment
 * someone aliases it; named classes also give a failing spec assertion a stack frame that
 * names the composition rather than `<anonymous>`.
 */
class AndSpecification extends CredentialSpecification {
  constructor(
    private readonly left: CredentialSpecification,
    private readonly right: CredentialSpecification,
  ) {
    super();
  }

  isSatisfiedBy(credential: PasswordCredential): boolean {
    return this.left.isSatisfiedBy(credential) && this.right.isSatisfiedBy(credential);
  }
}

class OrSpecification extends CredentialSpecification {
  constructor(
    private readonly left: CredentialSpecification,
    private readonly right: CredentialSpecification,
  ) {
    super();
  }

  isSatisfiedBy(credential: PasswordCredential): boolean {
    return this.left.isSatisfiedBy(credential) || this.right.isSatisfiedBy(credential);
  }
}

class NotSpecification extends CredentialSpecification {
  constructor(private readonly operand: CredentialSpecification) {
    super();
  }

  isSatisfiedBy(credential: PasswordCredential): boolean {
    return !this.operand.isSatisfiedBy(credential);
  }
}

/** Credentials that may still be used to sign in. */
export class VerifiableCredentials extends CredentialSpecification {
  isSatisfiedBy(credential: PasswordCredential): boolean {
    return credential.isVerifiable();
  }
}

/** Every credential that has not been revoked. */
export class LiveCredentials extends CredentialSpecification {
  isSatisfiedBy(credential: PasswordCredential): boolean {
    return !credential.isRevoked();
  }
}