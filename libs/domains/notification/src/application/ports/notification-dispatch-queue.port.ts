/**
 * @fileoverview How the consumer hands a resolved notification to BullMQ.
 *
 * @remarks A port rather than a direct `BullQueueService` for the same reason as the
 * dispatcher port: the processor is tested without a Nest container, and the interesting
 * assertion is "this instruction was enqueued exactly once", not "a Redis command was
 * issued". The adapter is the only place that knows the job name, the queue name and the
 * dedup contract.
 *
 * @remarks The job's `jobId` is the consumer claim key. That is deliberate: Kafka redelivers
 * at least once, and a second enqueue of the same event with the same `jobId` is a BullMQ
 * no-op — the claim store guards the consume side, the queue name guards the dispatch side,
 * and neither has to trust the other.
 */
import type { NotificationTemplate } from '../../domain/value-objects/notification-template.vo';
import type { NotificationChannel } from '../../domain/value-objects/notification-channel.vo';
import type { NotificationRecipient } from '../../domain/notification.aggregate';

export const NOTIFICATION_DISPATCH_QUEUE = Symbol('NOTIFICATION_DISPATCH_QUEUE');

/**
 * One dispatch job, as the consumer orders it.
 *
 * @remarks Carries the recipient and the resolved variables rather than the raw event: by
 * the time this is enqueued the route has already been resolved and the template's schema
 * has already accepted the payload. The worker's job is delivery, not interpretation.
 */
export interface NotificationDispatchJob {
  /** The consumer claim key; doubles as the BullMQ `jobId` for dedup. */
  readonly claimKey: string;
  readonly template: NotificationTemplate;
  readonly userId: string;
  readonly recipient: NotificationRecipient;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly channels?: readonly NotificationChannel[];
  readonly correlationId?: string;
}

export interface NotificationDispatchQueuePort {
  /**
   * Enqueues one dispatch job.
   *
   * @returns The BullMQ job id, or `null` when the queue is absent — Redis was unprovisioned
   * when the module started. The caller decides whether that is fatal; for the consumer it
   * is a released claim, so the broker redelivers.
   */
  enqueue(job: NotificationDispatchJob): Promise<string | null>;
}
