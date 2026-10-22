/**
 * @fileoverview Which chain a record belongs to.
 *
 * @remarks A single global chain would serialise every write in the platform behind one row
 * lock: every failed sign-in, every permission check and every role grant would queue behind
 * each other, and the audit log's throughput would become the platform's throughput. Partitions
 * are what make concurrent appends possible while keeping each chain independently verifiable.
 *
 * @remarks The trade-off is stated rather than hidden. Partitioning means an attacker who
 * gains write access to `audit_events` can still edit a record — but cannot edit it *quietly*,
 * because the stored head still holds the hash of the last record in that partition and the
 * recomputation will not match. What partitioning gives up is the cross-partition guarantee
 * that no record anywhere has been removed; it gives up nothing about whether a record that
 * is still there has been altered.
 */
import { ActorType, UNKNOWN_ACTOR_ID } from './audit-result.vo';

/** `anonymous` records have no per-actor key, so they are bucketed per UTC day instead. */
const ANONYMOUS = 'anonymous';

const DAY_MS = 86_400_000;

/**
 * Derives the chain key for one record.
 *
 * @remarks An identified actor gets a chain of their own, forever — the partition *is* the
 * guarantee that one actor's history can be walked end to end. An anonymous actor has no such
 * key, and bucketing them by day rather than by a single literal `anonymous` key matters:
 * every unauthenticated failure in the platform would otherwise contend on one row lock, which
 * is precisely the serialisation this partitioning exists to avoid.
 *
 * @param strategy - `actor` for one chain per actor; `actor_day` to roll the chain daily.
 * @param actorType - decides whether the actor is a key of its own.
 * @param actorId - the subject, or {@link UNKNOWN_ACTOR_ID} when the payload did not name one.
 * @param occurredAt - the event time, which decides the day bucket. UTC, because the bucket
 *   has to be the same bucket on every replica regardless of where they run.
 */
export function partitionKeyFor(
  strategy: 'actor' | 'actor_day',
  actorType: ActorType,
  actorId: string,
  occurredAt: Date,
): string {
  const subject = actorType === ActorType.ANONYMOUS ? ANONYMOUS : normaliseActorId(actorId);

  if (strategy === 'actor') {
    return `${actorType}.${subject}`;
  }

  return `${actorType}.${subject}.${dayBucket(occurredAt)}`;
}

/** `2026-10-19` in UTC. */
export function dayBucket(occurredAt: Date): string {
  return new Date(Math.floor(occurredAt.getTime() / DAY_MS) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function normaliseActorId(actorId: string): string {
  const trimmed = actorId.trim();
  return trimmed.length === 0 ? UNKNOWN_ACTOR_ID : trimmed;
}