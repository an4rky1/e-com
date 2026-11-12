import { Inject, Injectable } from '@nestjs/common';
import type { PrismaService } from '@auth/infra/prisma';
import { DOMAIN_EVENT_SINK, type DomainEventSink } from '@auth/infra/events';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  CREDENTIAL_REPOSITORY,
  type CredentialRepositoryPort,
  type CredentialSpecification,
} from '../../domain/ports/credential-repository.port';
import { PASSWORD_HASHER, type PasswordHasherPort } from '../../domain/ports/password-hasher.port';
import { PasswordCredential } from '../../domain/password-credential.aggregate';
import { RecoveryCodeSet } from '../../domain/recovery-code-set.aggregate';
import { VAULT_PRISMA } from '../../credential-vault.config';

@Injectable()
export class PrismaCredentialRepository implements CredentialRepositoryPort {
  constructor(
    @Inject(VAULT_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
    @Inject(DOMAIN_EVENT_SINK) private readonly sink: DomainEventSink,
  ) {}

  /**
   * Writes the credential and its events atomically.
   *
   * @remarks This is the transactional-outbox guarantee in its shortest form: the sink puts
   * the row and the outbox entries in one transaction, so either a consumer eventually hears
   * about the new secret or nothing about it exists at all. Publishing to Kafka after a
   * separate commit would leave a window where a rotated password is live and unannounced.
   */
  async save(credential: PasswordCredential): Promise<void> {
    await this.saveAll([credential]);
  }

  /**
   * One transaction for every credential in the batch.
   *
   * @remarks `revokeAll` over five credentials has to leave all five revoked or none: a
   * sequence of independent transactions interrupted halfway would leave a user who believes
   * they signed out everywhere still able to sign in somewhere.
   */
  async saveAll(credentials: readonly PasswordCredential[]): Promise<void> {
    if (credentials.length === 0) return;

    const events = credentials.flatMap((credential) => credential.clearDomainEvents());
    await this.sink.run(this.prisma, events, (client) => this.writeRows(client, credentials));
  }

  /**
   * The state half of {@link saveAll} and {@link revokeAllCredentials}: the credential rows,
   * no events.
   *
   * @remarks Split out so {@link revokeAllCredentials} can compose the credential writes and
   * the recovery-code deletion inside a single sink transaction of its own.
   */
  private async writeRows(
    client: PrismaClient,
    credentials: readonly PasswordCredential[],
  ): Promise<void> {
    for (const credential of credentials) {
      await this.upsertCredential(client, credential);
    }
  }

  /**
   * Writes one credential, respecting the "one active credential per (user, method)" rule.
   *
   * @remarks The database enforces that with a *partial* unique index on
   * `(user_id, method) WHERE status = 'active'`. A plain `upsert({ where: { id } })` cannot
   * satisfy it: setting a password again mints a new credential id, the `id` lookup misses,
   * and the insert then violates the index — turning "change my password" into a 500. So the
   * natural key is resolved first and the existing active row is updated in place.
   *
   * @remarks The unit tests never caught this because they use an in-memory repository, where
   * a plain upsert on a fresh id quietly succeeds.
   */
  private async upsertCredential(
    client: PrismaClient,
    credential: PasswordCredential,
  ): Promise<void> {
    const row = this.toRow(credential);

    const active = await client.credentials.findFirst({
      where: { user_id: credential.userId, method: credential.method, status: 'active' },
      select: { id: true },
    });

    if (active) {
      await client.credentials.update({ where: { id: active.id }, data: row });
      return;
    }

    await client.credentials.create({ data: row });
  }

  async findByUser(
    userId: string,
    options: { includeRevoked?: boolean } = {},
  ): Promise<readonly PasswordCredential[]> {
    const rows = await this.prisma.tx.credentials.findMany({
      where: {
        user_id: userId,
        ...(options.includeRevoked === false ? { NOT: { status: 'revoked' } } : {}),
      },
      orderBy: { created_at: 'desc' },
    });

    return rows.map((row) => PasswordCredential.fromRow(row, this.hasher));
  }

  /**
   * The credential a presented password belongs to.
   *
   * @remarks No status filter, on purpose. The caller has to be able to tell "there is no such
   * credential" from "this one is locked" in order to record the right failure — but it must
   * not be able to tell the caller. Filtering here would make a locked account and an unknown
   * one take different code paths before the message is chosen.
   */
  async findPasswordCredential(
    userId: string,
    identifier?: string,
  ): Promise<PasswordCredential | null> {
    const row = await this.prisma.tx.credentials.findFirst({
      where: {
        user_id: userId,
        method: 'password',
        ...(identifier ? { identifier } : {}),
      },
      orderBy: { created_at: 'desc' },
    });

    return row ? PasswordCredential.fromRow(row, this.hasher) : null;
  }

  async findRecoveryCodeSet(userId: string): Promise<RecoveryCodeSet | null> {
    const rows = await this.prisma.tx.recovery_codes.findMany({
      where: { user_id: userId },
      orderBy: { code_index: 'asc' },
    });

    return rows.length === 0 ? null : RecoveryCodeSet.fromRows(userId, rows);
  }

  /**
   * Replaces the whole set in one transaction.
   *
   * @remarks Delete-then-insert rather than an upsert: "regenerate" is defined as invalidating
   * the previous codes, and a user who asked for fewer than they had would otherwise keep the
   * surplus rows alive. Both halves commit together with the event, so a crash cannot leave a
   * user with an announced new set that was never written, or a deleted old set whose event
   * says otherwise.
   */
  async saveRecoveryCodeSet(set: RecoveryCodeSet): Promise<void> {
    const events = set.clearDomainEvents();
    const rows = set.toRows();

    await this.sink.run(this.prisma, events, async (client) => {
      await client.recovery_codes.deleteMany({ where: { user_id: set.id } });

      if (rows.length > 0) {
        await client.recovery_codes.createMany({
          data: rows.map((row) => ({
            user_id: set.id,
            code_index: row.code_index,
            code_digest: row.code_digest,
            consumed_at: row.consumed_at,
            created_at: row.created_at,
          })),
          skipDuplicates: true,
        });
      }
    });
  }

  async deleteRecoveryCodes(userId: string): Promise<void> {
    await this.prisma.tx.recovery_codes.deleteMany({ where: { user_id: userId } });
  }

  /**
   * Revokes every live credential and drops the recovery codes, in one transaction.
   *
   * @remarks The rows are written first and the events go through the same sink transaction,
   * so a consumer either hears about every revocation or none — never half of them. The
   * recovery codes are deleted in that same transaction: revoking the passwords and then
   * failing on the delete would leave an account with no password and a working bypass, which
   * is the one outcome worse than having done nothing.
   */
  async revokeAllCredentials(input: {
    userId: string;
    reason: string;
    now?: Date;
  }): Promise<number> {
    const now = input.now ?? new Date();
    const rows = await this.prisma.tx.credentials.findMany({
      where: { user_id: input.userId, NOT: { status: 'revoked' } },
      orderBy: { created_at: 'asc' },
    });

    const revoked: PasswordCredential[] = [];
    for (const row of rows) {
      const credential = PasswordCredential.fromRow(row, this.hasher);
      // `revoke` is a no-op on an already-revoked aggregate, so the status filter above is a
      // belt-and-braces guard rather than the mechanism.
      credential.revoke(input.reason, now, true);
      revoked.push(credential);
    }

    const events = revoked.flatMap((credential) => credential.clearDomainEvents());
    await this.sink.run(this.prisma, events, async (client) => {
      if (revoked.length > 0) {
        await this.writeRows(client, revoked);
      }
      await client.recovery_codes.deleteMany({ where: { user_id: input.userId } });
    });

    return revoked.length;
  }

  async find(spec: CredentialSpecification): Promise<readonly PasswordCredential[]> {
    const rows = await this.prisma.tx.credentials.findMany({ orderBy: { created_at: 'desc' } });
    return rows
      .map((row) => PasswordCredential.fromRow(row, this.hasher))
      .filter((credential) => spec.isSatisfiedBy(credential));
  }

  async count(spec: CredentialSpecification): Promise<number> {
    // Evaluated against the aggregate so the domain's predicate stays the single definition
    // of "matches" — a second, SQL-side implementation would drift from it.
    const rows = await this.prisma.tx.credentials.findMany();
    return rows
      .map((row) => PasswordCredential.fromRow(row, this.hasher))
      .filter((credential) => spec.isSatisfiedBy(credential)).length;
  }

  private toRow(credential: PasswordCredential) {
    return {
      id: credential.id.value,
      user_id: credential.userId,
      identifier: credential.identifier,
      method: credential.method,
      secret_hash: credential.hasSecret ? credential.digest : null,
      // The parameters travel with the hash: without them `needsRehash` cannot tell a weak
      // hash from an old one, and the upgrade could never happen after a policy bump.
      secret_parameters: {
        algorithm: credential.hashParameters.algorithm,
        memoryCost: credential.hashParameters.memoryCost,
        timeCost: credential.hashParameters.timeCost,
        parallelism: credential.hashParameters.parallelism,
        hashLength: credential.hashParameters.hashLength,
        version: credential.hashParameters.version,
        peppered: this.hasher.peppered,
      } as unknown as Prisma.InputJsonValue,
      status: credential.status,
      failed_attempts: credential.failedAttempts,
      locked_until: credential.lockedUntil,
      last_verified_at: credential.lastVerifiedAt,
      version: credential.version,
      created_at: credential.createdAt,
      updated_at: credential.updatedAt,
      revoked_at: credential.revokedAt,
      revoked_reason: credential.revokedReason,
    };
  }
}

export { CREDENTIAL_REPOSITORY };