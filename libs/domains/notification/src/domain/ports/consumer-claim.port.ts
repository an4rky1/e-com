/**
 * @fileoverview Consumer-side idempotency.
 *
 * @remarks At-least-once delivery means the same event arrives twice: the consumer commits its
 * offset after the handler returns, a pod dies in the window between, and the broker replays.
 * Without a claim keyed by the event's own identity, "user registered" sends two welcome
 * emails — and unlike a duplicated row, a duplicated *email* is something the user notices and
 * the support queue hears about.
 *
 * @remarks The key is `<topic>:<eventId>`, deliberately not the aggregate id and not a hash of
 * the payload. Two different facts about one user are two notifications; the same fact
 * announced on a different topic is the same fact and must not send twice.
 */
import type { Topic } from '@auth/contracts';

export const CONSUMER_CLAIM_STORE = Symbol('CONSUMER_CLAIM_STORE');

/**
 * The identity of one delivery of one event.
 *
 * @remarks A free function rather than a method so the key is built in exactly one place. A
 * claim and a release that disagree about the key are a claim that is never released — which
 * is indistinguishable, from the outside, from an event that was silently dropped.
 */
export function claimKeyFor(topic: string, eventId: string): string {
  return `${topic}:${eventId}`;
}

export type ClaimKey = ReturnType<typeof claimKeyFor>;

/** Why a claim was refused. */
export const ClaimRefusal = {
  /** Somebody already holds it — the normal duplicate-delivery case. */
  ALREADY_CLAIMED: 'already_claimed',
} as const;

export type ClaimRefusal = (typeof ClaimRefusal)[keyof typeof ClaimRefusal];

export interface ClaimResult {
  readonly claimed: boolean;
  readonly refusal?: ClaimRefusal;
}

export interface ConsumerClaimStorePort {
  /**
   * Takes exclusive ownership of one event delivery.
   *
   * @remarks Must be atomic against concurrent claimants. Two replicas handling the same
   * event at once and both winning is precisely the duplicate this exists to prevent, so the
   * implementation leans on a unique index rather than a read-then-write.
   *
   * @returns `claimed: false` when the key is already held. That is *not* an error: it is the
   * whole point, and the caller must treat it as "somebody already did this".
   */
  claim(key: ClaimKey, options?: { traceId?: string }): Promise<ClaimResult>;

  /**
   * Gives the claim back so a retry can proceed.
   *
   * @remarks Only for a failure that a retry could fix — a database timeout, a channel that
   * was briefly down. A payload that fails its schema must keep its claim, because the retry
   * will fail identically and an un-releasing loop is how one poison message stalls a
   * partition.
   *
   * @returns whether a claim was actually released, so a test can tell a released retry from a
   * retry that raced another replica.
   */
  release(key: ClaimKey): Promise<boolean>;

  /** Whether the key is currently held. Diagnostic; the decision is always `claim`. */
  isClaimed(key: ClaimKey): Promise<boolean>;

  /**
   * Claims older than `olderThan` that were never released.
   *
   * @remarks Recovery from a consumer that died between claiming and releasing. Without it a
   * crashed pod silently swallows the event it was holding and the user never gets the
   * notification.
   */
  releaseAbandoned(olderThan: Date): Promise<number>;
}

/** Narrowed alias so a route table can name its topic without widening the key builder. */
export type ClaimableTopic = Topic;