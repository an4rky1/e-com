import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import type { IDomainEvent } from '@auth/ddd-core';
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

/**
 * The domain-event -> topic mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one function means adding an event cannot accidentally
 * invent a topic name that no consumer subscribes to.
 *
 * @remarks `credential.revoked` rides on the rotation topic deliberately. The catalogue gives
 * credential-vault four topics and none of them is a revocation; every one of these events
 * says the same thing to a consumer — whatever secret this credential held, it does not hold
 * it now — and the payload's `rotation`/`reason` fields say which. A fifth topic would mean a
 * second subscription for a fact that already has one.
 */
const TOPIC_FOR_EVENT: Record<string, string> = {
  'credential.verified': Topics.CREDENTIAL_VERIFIED,
  'credential.failed': Topics.CREDENTIAL_FAILED,
  'credential.rotated': Topics.CREDENTIAL_ROTATED,
  'credential.revoked': Topics.CREDENTIAL_ROTATED,
  'credential.recovery_codes_regenerated': Topics.CREDENTIAL_RECOVERY_CODES_REGENERATED,
};

@Injectable()
export class PrismaCredentialRepository implements CredentialRepositoryPort {
  private readonly logger = new Logger(PrismaCredentialRepository.name);

  constructor(
    @Inject(VAULT_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasherPort,
  ) {}

  /**
   * Writes the credential and its events atomically.
   *
   * @remarks This is the transactional-outbox guarantee in its shortest form. The row and the
   * event envelopes go in through `runInTransaction`, so either a consumer eventually hears
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
    await this.prisma.runInTransaction((client) => this.writeAll(client, credentials));
  }

  /**
   * The body of {@link saveAll}, without the transaction wrapper.
   *
   * @remarks Split out so {@link revokeAllCredentials} can compose the credential writes and
   * the recovery-code deletion inside a *single* transaction of its own. Wrapping each half
   * in `runInTransaction` would have produced two commits and none of the guarantee.
   */
  private async writeAll(
    client: PrismaClient,
    credentials: readonly PasswordCredential[],
  ): Promise<void> {
    const pending = credentials.map((credential) => ({
      credential,
      events: credential.clearDomainEvents(),
    }));

    for (const { credential } of pending) {
      await this.upsertCredential(client, credential);
    }

    for (const { credential, events } of pending) {
      for (const event of events) {
        await this.enqueue(client, event, credential.id.value, credential.userId);
      }
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

  /**
   * Writes one outbox row per domain event.
   *
   * @remarks `dedup_key` is what makes a redelivered command safe: the unique index on
   * `(dedup_key, type)` turns a second insert of the same fact into a no-op instead of a
   * duplicate `credential.rotated`. The key ends in the event's version, so two *different*
   * rotations of the same credential are still two events.
   */
  private async enqueue(
    client: PrismaClient,
    event: IDomainEvent,
    credentialId: string,
    userId: string,
  ): Promise<void> {
    const topic = TOPIC_FOR_EVENT[event.eventType];
    if (!topic) {
      // An unmapped event is a build-time oversight. Logging and continuing is deliberate:
      // failing the transaction would roll back a perfectly valid password change over a
      // topic that has not been wired up yet.
      this.logger.warn(`No topic mapped for domain event "${event.eventType}"`);
      return;
    }

    const dedupKey = `${event.eventType}:${credentialId}:${event.version}`;
    const payload = readPayload(event);

    await client.outbox_events.createMany({
      data: [
        {
          id: event.eventId,
          type: event.eventType,
          aggregate_type: event.aggregateType,
          aggregate_id: credentialId,
          topic,
          // `payload` is a JSON column, so it needs Prisma's Json input type rather than a
          // plain Record; the cast is the documented boundary for that conversion.
          payload: {
            eventId: event.eventId,
            type: topic,
            schemaVersion: 1,
            occurredAt: event.occurredAt.toISOString(),
            aggregateId: credentialId,
            aggregateType: event.aggregateType,
            // The partition key is the *user*, not the credential: two credentials of one
            // account have to land on the same partition or a consumer cannot order them.
            partitionKey: userId,
            payload: { ...payload, userId },
          } as unknown as Prisma.InputJsonValue,
          dedup_key: dedupKey,
          status: 'pending',
          attempts: 0,
          next_attempt_at: new Date(),
          trace_id: event.correlationId ?? crypto.randomUUID(),
        },
      ],
      skipDuplicates: true,
    });
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

    await this.prisma.runInTransaction(async (client) => {
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

      for (const event of events) {
        await this.enqueue(client, event, set.id, set.id);
      }
    });
  }

  async deleteRecoveryCodes(userId: string): Promise<void> {
    await this.prisma.tx.recovery_codes.deleteMany({ where: { user_id: userId } });
  }

  /**
   * Revokes every live credential and drops the recovery codes, in one transaction.
   *
   * @remarks The rows are written first and the events in the same `runInTransaction`, so a
   * consumer either hears about every revocation or none — never half of them. The recovery
   * codes are deleted in that same transaction: revoking the passwords and then failing on
   * the delete would leave an account with no password and a working bypass, which is the one
   * outcome worse than having done nothing.
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

    await this.prisma.runInTransaction(async (client) => {
      if (revoked.length > 0) {
        await this.writeAll(client, revoked);
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

function readPayload(event: IDomainEvent): Record<string, unknown> {
  const candidate = event as unknown as { payload?: unknown };
  return typeof candidate.payload === 'object' && candidate.payload !== null
    ? (candidate.payload as Record<string, unknown>)
    : {};
}

export { CREDENTIAL_REPOSITORY };