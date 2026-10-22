import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { ApiKey } from '../../domain/api-key.aggregate';
import {
  API_KEY_REPOSITORY,
  type ApiKeyRepositoryPort,
  type ApiKeySpecification,
} from '../../domain/ports/api-key-repository.port';
import { API_KEY_PRISMA } from '../../api-key.config';
import { enqueueEvents } from './outbox-enqueue';

/**
 * The `api_key.*` -> `platform.api_key.*.v1` mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one function means adding an event cannot accidentally
 * invent a topic name that no consumer subscribes to.
 *
 * @remarks Every payload carries the `prefix` and never the key. A key that reaches a topic
 * has been fanned out to every consumer and retained for as long as the audit trail lives,
 * which is the same as saying it has been compromised.
 */
const API_KEY_TOPICS: Readonly<Record<string, string>> = {
  'api_key.created': Topics.API_KEY_CREATED,
  'api_key.rotated': Topics.API_KEY_ROTATED,
  'api_key.revoked': Topics.API_KEY_REVOKED,
};

@Injectable()
export class PrismaApiKeyRepository implements ApiKeyRepositoryPort {
  private readonly logger = new Logger(PrismaApiKeyRepository.name);

  constructor(
    @Inject(API_KEY_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  /**
   * Writes the key and its events atomically.
   *
   * @remarks This is the transactional-outbox guarantee in its shortest form. The row and the
   * event envelopes go in through `runInTransaction`, so either a consumer eventually hears
   * about the new key or nothing about it exists at all. Emitting after a separate commit
   * would leave a window where a live credential is unannounced.
   */
  async save(key: ApiKey): Promise<void> {
    await this.saveMany([key]);
  }

  /**
   * Writes several keys and their events in one transaction.
   *
   * @remarks Rotation is the reason this exists. `saveMany([revoked, successor])` is one
   * commit, so there is no instant at which both keys are usable and no instant at which
   * neither is — and the two `outbox_events` rows land with them.
   */
  async saveMany(keys: readonly ApiKey[]): Promise<void> {
    if (keys.length === 0) return;

    // Drained before the transaction opens: an event buffer that survived a rollback would be
    // written by the *next* save and attributed to a different key.
    const drained = keys.map((key) => ({ key, events: key.clearDomainEvents() }));

    await this.prisma.runInTransaction(async (client) => {
      for (const { key } of drained) {
        await client.api_keys.upsert({
          where: { id: key.id.value },
          create: toRow(key),
          update: toMutableRow(key),
        });
      }

      for (const { events } of drained) {
        await enqueueEvents(events, {
          client,
          logger: this.logger,
          topics: API_KEY_TOPICS,
        });
      }
    });
  }

  async findById(id: string): Promise<ApiKey | null> {
    const row = await this.prisma.tx.api_keys.findUnique({ where: { id } });
    return row ? ApiKey.fromRow(row) : null;
  }

  async findByPrefix(prefix: string): Promise<ApiKey | null> {
    // Hits `api_keys_prefix_unique`: one indexed read to find the row, after which the digest
    // comparison is the only thing standing between a stolen prefix and a working credential.
    const row = await this.prisma.tx.api_keys.findUnique({ where: { prefix } });
    return row ? ApiKey.fromRow(row) : null;
  }

  async findByUser(userId: string): Promise<ApiKey[]> {
    const rows = await this.prisma.tx.api_keys.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });
    return rows.map(ApiKey.fromRow);
  }

  async existsByName(userId: string, name: string): Promise<boolean> {
    const count = await this.prisma.tx.api_keys.count({
      where: { user_id: userId, name: name.trim() },
    });
    return count > 0;
  }

  async find(spec: ApiKeySpecification): Promise<ApiKey[]> {
    const rows = await this.prisma.tx.api_keys.findMany({
      orderBy: { created_at: 'desc' },
    });
    return rows.map(ApiKey.fromRow).filter((key) => spec.isSatisfiedBy(key));
  }

  async count(spec: ApiKeySpecification): Promise<number> {
    // Evaluated against the aggregate so the domain's predicate stays the single definition
    // of "matches" — a second, SQL-side implementation would drift from it.
    return (await this.find(spec)).length;
  }
}

function toRow(key: ApiKey): Prisma.api_keysCreateInput {
  return {
    id: key.id.value,
    user_id: key.userId,
    name: key.name,
    prefix: key.prefix,
    // Only ever the digest. The plaintext was returned by the command and is now gone.
    secret_hash: key.secretHash,
    scopes: [...key.scopes],
    status: key.status,
    created_at: key.createdAt,
    expires_at: key.expiresAt,
    last_used_at: key.lastUsedAt,
    rotated_from_id: key.rotatedFromId,
    rotation_count: key.rotationCount,
    revoked_at: key.revokedAt,
    revoke_reason: key.revokeReason,
  };
}

/**
 * The same row minus the columns an update may not touch.
 *
 * @remarks `id`, `user_id` and `created_at` are immutable: a key does not change owner, and
 * rewriting its creation time would break the `(user_id, created_at desc)` listing an owner
 * browses.
 */
function toMutableRow(key: ApiKey): Prisma.api_keysUpdateInput {
  return {
    name: key.name,
    prefix: key.prefix,
    secret_hash: key.secretHash,
    scopes: [...key.scopes],
    status: key.status,
    expires_at: key.expiresAt,
    last_used_at: key.lastUsedAt,
    rotated_from_id: key.rotatedFromId,
    rotation_count: key.rotationCount,
    revoked_at: key.revokedAt,
    revoke_reason: key.revokeReason,
  };
}

export { API_KEY_REPOSITORY };