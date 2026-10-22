/**
 * @fileoverview Durable consumer claims, stored in `outbox_events`.
 *
 * @remarks This service's schema owns two tables: `outbox_events` and `outbox_dead_letters`.
 * There is no `processed_events` table, and the schema cannot be changed from inside this lib.
 * The unique index on `(dedup_key, type)` is therefore the idempotency mechanism — the one
 * primitive this database offers that makes "exactly one of these two concurrent inserts wins"
 * a property of the storage engine rather than of a hopeful read-then-write.
 *
 * @remarks Claim rows are written `status = 'published'`. That is not a lie about a message:
 * a claim is *terminal* the moment it exists, and the outbox relay only claims rows in
 * `pending`, so a terminal row is invisible to it forever. Writing it as `pending` would put
 * an internal bookkeeping row on a Kafka topic that every other service subscribes to.
 *
 * @remarks `createMany` with `skipDuplicates` rather than `create`. `ON CONFLICT DO NOTHING`
 * reports how many rows it actually inserted, and zero is the answer that means "somebody else
 * has this". Catching a P2002 instead would also work but leaves the losing transaction
 * aborted in Postgres, and an aborted transaction cannot release its own claim.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaService } from '@auth/infra/prisma';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  ClaimRefusal,
  claimKeyFor,
  type ClaimKey,
  type ClaimResult,
  type ConsumerClaimStorePort,
} from '../../domain/ports/consumer-claim.port';
import {
  NOTIFICATION_CONFIG,
  NOTIFICATION_PRISMA,
  type NotificationConfig,
} from '../../notification.config';

/**
 * `type` discriminator for a claim row.
 *
 * @remarks Namespaced away from every real event type so it can never collide with one. The
 * unique index is on `(dedup_key, type)`, and a claim key is `<topic>:<eventId>` — the same
 * shape as nothing an event uses, but the discriminator is what makes the separation
 * provable rather than probable.
 */
export const CLAIM_EVENT_TYPE = 'notification.consumer.claim';

/** A terminal marker topic. Never published; see the note on `status` above. */
export const CLAIM_TOPIC = 'platform.notification.consumer_claim.v1';

@Injectable()
export class PrismaConsumerClaimStore implements ConsumerClaimStorePort {
  private readonly logger = new Logger(PrismaConsumerClaimStore.name);

  constructor(
    @Inject(NOTIFICATION_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  /**
   * Takes the claim, or reports that somebody already holds it.
   *
   * @remarks The abandoned-claim sweep is a delete before the insert rather than a query, so
   * a claim that expired *during* this call cannot survive to make the insert a no-op. Doing
   * it in the other order would leave a window where an expired claim still blocks the event.
   */
  async claim(key: ClaimKey, options: { traceId?: string } = {}): Promise<ClaimResult> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.config.claimTtlSec * 1_000);

    await this.prisma.tx.outbox_events.deleteMany({
      where: {
        type: CLAIM_EVENT_TYPE,
        dedup_key: key,
        created_at: { lt: cutoff },
      },
    });

    const { count } = await this.prisma.tx.outbox_events.createMany({
      data: [
        {
          id: crypto.randomUUID(),
          type: CLAIM_EVENT_TYPE,
          aggregate_type: 'notification',
          aggregate_id: key,
          topic: CLAIM_TOPIC,
          // No `payload` value worth carrying. The key *is* the state, and duplicating it into
          // a JSON column would be a second copy to keep in step with the first.
          payload: { claim: key } as unknown as Prisma.InputJsonValue,
          dedup_key: key,
          // Terminal, so the relay never claims it. See the class note.
          status: 'published',
          published_at: now,
          attempts: 0,
          next_attempt_at: now,
          trace_id: options.traceId ?? crypto.randomUUID(),
        },
      ],
      skipDuplicates: true,
    });

    if (count > 0) return { claimed: true };

    this.logger.debug(`claim ${key} is already held`);
    return { claimed: false, refusal: ClaimRefusal.ALREADY_CLAIMED };
  }

  /** Deletes the claim, so the broker's redelivery is not discarded as a duplicate. */
  async release(key: ClaimKey): Promise<boolean> {
    const { count } = await this.prisma.tx.outbox_events.deleteMany({
      where: { type: CLAIM_EVENT_TYPE, dedup_key: key },
    });
    return count > 0;
  }

  async isClaimed(key: ClaimKey): Promise<boolean> {
    const row = await this.prisma.tx.outbox_events.findFirst({
      where: { type: CLAIM_EVENT_TYPE, dedup_key: key },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Reclaims claims whose owner never released them.
   *
   * @remarks Bounded by `claimTtlSec` rather than by "every claim with no owner" because there
   * is no ownership column: a consumer mid-flight looks identical to one that died. The TTL is
   * the only signal available, and it is why the default is longer than any plausible
   * dispatch.
   */
  async releaseAbandoned(olderThan: Date): Promise<number> {
    const cutoff = new Date(
      Math.min(olderThan.getTime(), Date.now() - this.config.claimTtlSec * 1_000),
    );

    const { count } = await this.prisma.tx.outbox_events.deleteMany({
      where: { type: CLAIM_EVENT_TYPE, created_at: { lt: cutoff } },
    });
    return count;
  }
}

export { claimKeyFor };