/**
 * @fileoverview Consumer-side idempotency, keyed on the event's own identity.
 *
 * @remarks At-least-once delivery means the same security event arrives twice: the consumer
 * commits its offset after the handler returns, a pod dies in the window between, and the
 * broker replays. Without a claim, every redelivery appends a second record — and because the
 * record is hash-chained, that duplicate is not merely untidy: it is a second, equally
 * verifiable statement that the same failure happened twice, which is exactly the shape of the
 * log an operator is asked to trust.
 *
 * @remarks The key is `<topic>:<eventId>`, not the aggregate id and not a hash of the payload.
 * Two different facts about one user are two records; the same fact announced on a different
 * topic is the same fact and must not be stored twice.
 */
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

/**
 * The identity of one delivery of one event.
 *
 * @remarks A free function rather than a method so the key is built in exactly one place. A
 * claim and a release that disagree about the key are a claim that is never released — which
 * is indistinguishable, from the outside, from an event that was silently never audited.
 */
export function idempotencyKeyFor(topic: string, eventId: string): string {
  return `${topic}:${eventId}`;
}

export type IdempotencyKey = ReturnType<typeof idempotencyKeyFor>;

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

export interface IdempotencyStorePort {
  /**
   * Takes exclusive ownership of one event delivery.
   *
   * @remarks Must be atomic against concurrent claimants. Two replicas handling the same
   * event at once and both winning is precisely the duplicate this exists to prevent, so the
   * implementation leans on the primary key on `idempotency_keys` rather than a
   * read-then-write.
   *
   * @returns `claimed: false` when the key is already held. That is *not* an error: it is the
   * whole point, and the caller must treat it as "somebody already recorded this".
   */
  claim(key: IdempotencyKey, response: Readonly<Record<string, unknown>>, options?: { traceId?: string }): Promise<ClaimResult>;

  /**
   * Gives the claim back so a retry can proceed.
   *
   * @remarks Only for a failure a retry could fix — a database timeout, a lock wait. A
   * malformed payload must keep its claim, because the retry will fail identically and an
   * un-releasing loop is how one poison message stalls a partition.
   *
   * @returns whether a claim was actually released, so a test can tell a released retry from a
   * retry that raced another replica.
   */
  release(key: IdempotencyKey): Promise<boolean>;

  /** Whether the key is currently held. Diagnostic; the decision is always `claim`. */
  isClaimed(key: IdempotencyKey): Promise<boolean>;

  /**
   * Claims older than `olderThan` that were never released.
   *
   * @remarks Recovery from a consumer that died between claiming and releasing. Without it a
   * crashed pod silently swallows the event it was holding and that security event is never
   * audited at all.
   */
  releaseAbandoned(olderThan: Date): Promise<number>;
}