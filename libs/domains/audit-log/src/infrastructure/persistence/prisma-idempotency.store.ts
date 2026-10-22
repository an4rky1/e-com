/**
 * @fileoverview Durable consumer claims, stored in `idempotency_keys`.
 *
 * @remarks The same three-column pattern the identity schema uses: `(key, response,
 * created_at)`. It is copied rather than reinvented because it is already the platform's
 * answer to "the same request, twice" — and an audit log needs the answer for the same reason
 * the rest of the platform does, only with a worse failure mode. A duplicated `user.created`
 * is untidy; a duplicated `permission.denied` is a second verifiable claim that somebody tried
 * something they were not allowed to do, which is the shape of a fabricated log.
 *
 * @remarks `createMany` with `skipDuplicates` rather than `create`. `ON CONFLICT DO NOTHING`
 * reports how many rows it actually inserted, and zero is the answer that means "somebody else
 * has this". Catching a unique violation instead would also work but leaves the losing
 * transaction aborted in Postgres — and an aborted transaction cannot release its own claim, so
 * the redelivery would find a claim nobody can take.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@auth/infra/prisma';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  ClaimRefusal,
  type ClaimResult,
  type IdempotencyKey,
  type IdempotencyStorePort,
} from '../../domain/ports/idempotency-store.port';
import { AUDIT_LOG_CONFIG, AUDIT_LOG_PRISMA, type AuditLogConfig } from '../../audit-log.config';

@Injectable()
export class PrismaIdempotencyStore implements IdempotencyStorePort {
  private readonly logger = new Logger(PrismaIdempotencyStore.name);

  constructor(
    @Inject(AUDIT_LOG_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    @Inject(AUDIT_LOG_CONFIG) private readonly config: AuditLogConfig,
  ) {}

  /**
   * Takes the claim, or reports that somebody already holds it.
   *
   * @remarks The abandoned-claim sweep is a delete *before* the insert rather than a query, so
   * a claim that expired during this call cannot survive to make the insert a no-op. Doing it
   * in the other order leaves a window where an expired claim still blocks the event — which is
   * the same as not sweeping at all, just slower.
   */
  async claim(
    key: IdempotencyKey,
    response: Readonly<Record<string, unknown>>,
    options: { traceId?: string } = {},
  ): Promise<ClaimResult> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.config.claimTtlSec * 1_000);

    await this.prisma.tx.idempotency_keys.deleteMany({
      where: { key, created_at: { lt: cutoff } },
    });

    const { count } = await this.prisma.tx.idempotency_keys.createMany({
      data: [
        {
          key,
          // What the retry would otherwise have to recompute: the partition the event was
          // routed to and the id it was given. Storing it means a replay can answer "where did
          // this end up" without walking the log.
          response: {
            ...response,
            traceId: options.traceId ?? crypto.randomUUID(),
          } as unknown as Prisma.InputJsonValue,
          created_at: now,
        },
      ],
      skipDuplicates: true,
    });

    if (count > 0) return { claimed: true };

    this.logger.debug(`claim ${key} is already held`);
    return { claimed: false, refusal: ClaimRefusal.ALREADY_CLAIMED };
  }

  /** Deletes the claim, so the broker's redelivery is not discarded as a duplicate. */
  async release(key: IdempotencyKey): Promise<boolean> {
    const { count } = await this.prisma.tx.idempotency_keys.deleteMany({
      where: { key },
    });
    return count > 0;
  }

  async isClaimed(key: IdempotencyKey): Promise<boolean> {
    const row = await this.prisma.tx.idempotency_keys.findUnique({
      where: { key },
      select: { key: true },
    });
    return row !== null;
  }

  /**
   * Reclaims claims whose owner never released them.
   *
   * @remarks Bounded by `claimTtlSec` rather than by "every claim with no owner" because there
   * is no ownership column: a consumer mid-flight looks identical to one that died. The TTL is
   * the only signal available, and it is why the default is longer than any plausible append.
   */
  async releaseAbandoned(olderThan: Date): Promise<number> {
    const cutoff = new Date(
      Math.min(olderThan.getTime(), Date.now() - this.config.claimTtlSec * 1_000),
    );

    const { count } = await this.prisma.tx.idempotency_keys.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
    return count;
  }
}

export { IDEMPOTENCY_STORE } from '../../domain/ports/idempotency-store.port';