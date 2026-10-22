/**
 * @fileoverview Credential status, as a read model.
 *
 * @remarks The only query in this service, and it exists because the other five services need
 * to render "does this account have a password, is it locked, how many backup codes are left"
 * without a cross-database join. It answers about *credentials* only: whether the account
 * behind them exists, is suspended or has verified its email is identity's fact, and mixing
 * the two here would make one database join necessary for every sign-in screen.
 *
 * @remarks Like every other query in this workspace it is a class: `QueryBus.execute` resolves
 * a handler from `query.constructor`, and `@QueryHandler('Name')` throws at import because
 * `Reflect.hasOwnMetadata` rejects a non-object.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepositoryPort,
} from '../../domain/ports/credential-repository.port';
import type { PasswordCredential } from '../../domain/password-credential.aggregate';
import type { CredentialStatus } from '../../domain/value-objects/credential-status.vo';

/**
 * Projection of the credential state for callers.
 *
 * @remarks A distinct type rather than returning the aggregate: the aggregate carries
 * invariants, a `PasswordHasherPort` and a buffered event list, and exposing any of those
 * turns this service's internals into a public contract. Note what is *absent* — there is no
 * digest, no `secret_parameters` and no recovery code. A read model that carried a hash would
 * leak it into every log and every cache it passed through.
 */
export interface CredentialStatusReadModel {
  userId: string;
  /** False when the user has never set a password, or every credential was revoked. */
  hasCredential: boolean;
  credentialId: string | null;
  status: CredentialStatus | null;
  failedAttempts: number;
  locked: boolean;
  lockedUntil: Date | null;
  /** Seconds until a lock lifts; zero when not locked. */
  retryAfterSeconds: number;
  lastVerifiedAt: Date | null;
  /** Unconsumed recovery codes. Zero is also the answer for a user who holds none. */
  recoveryCodesRemaining: number;
}

export const toCredentialStatusReadModel = (
  credential: PasswordCredential | null,
  recoveryCodesRemaining: number,
  userId: string,
  now: Date = new Date(),
): CredentialStatusReadModel => ({
  userId,
  hasCredential: credential !== null && credential.hasSecret,
  credentialId: credential?.id.value ?? null,
  status: credential?.status ?? null,
  failedAttempts: credential?.failedAttempts ?? 0,
  locked: credential?.isLocked(now) ?? false,
  lockedUntil: credential?.lockedUntil ?? null,
  retryAfterSeconds: credential?.retryAfterSeconds(now) ?? 0,
  lastVerifiedAt: credential?.lastVerifiedAt ?? null,
  recoveryCodesRemaining,
});

export class GetCredentialStatusQuery extends Query<CredentialStatusReadModel> {
  readonly queryId: string = crypto.randomUUID();

  constructor(readonly userId: string) {
    super();
  }
}

/**
 * @remarks Returns a populated, all-zero model for a user who holds nothing rather than
 * throwing `ResourceNotFoundException`. This service never asserts that a user exists — a
 * 404 here would be an account-existence oracle on the one surface that is otherwise
 * indifferent to the question.
 */
@Injectable()
@QueryHandler(GetCredentialStatusQuery)
export class GetCredentialStatusHandler
  implements IQueryHandler<GetCredentialStatusQuery, CredentialStatusReadModel>
{
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepositoryPort,
  ) {}

  async execute(query: GetCredentialStatusQuery): Promise<CredentialStatusReadModel> {
    const [credential, codes] = await Promise.all([
      this.credentials.findPasswordCredential(query.userId),
      this.credentials.findRecoveryCodeSet(query.userId),
    ]);

    return toCredentialStatusReadModel(credential, codes?.remaining ?? 0, query.userId);
  }
}