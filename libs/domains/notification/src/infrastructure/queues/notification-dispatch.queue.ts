import { Injectable, Logger } from '@nestjs/common';
import { BullQueueService, NOTIFICATION_DISPATCH_QUEUE as NOTIFICATION_DISPATCH_QUEUE_NAME } from '@auth/infra/queue';
import {
  type NotificationDispatchJob,
  type NotificationDispatchQueuePort,
} from '../../application/ports/notification-dispatch-queue.port';

/**
 * BullMQ-backed dispatch queue.
 *
 * @remarks The `jobId` is the consumer claim key, not a fresh UUID. Kafka redelivers at
 * least once; a second enqueue of the same event under the same `jobId` is a BullMQ no-op,
 * so a redelivery that slips past the claim store still cannot double-send.
 *
 * @remarks Returns `null` when the queue is absent — Redis was unprovisioned at boot. Same
 * contract as every other queue consumer on the platform: the caller decides, and for the
 * event processor the decision is to release the claim so the broker redelivers.
 */
@Injectable()
export class BullNotificationDispatchQueue implements NotificationDispatchQueuePort {
  private readonly logger = new Logger(BullNotificationDispatchQueue.name);

  constructor(private readonly queues: BullQueueService) {}

  async enqueue(job: NotificationDispatchJob): Promise<string | null> {
    const queue = this.queues.get(NOTIFICATION_DISPATCH_QUEUE_NAME);
    if (queue === null) {
      this.logger.warn(
        `queue ${NOTIFICATION_DISPATCH_QUEUE_NAME} is absent; dispatch job for ${job.claimKey} not enqueued`,
      );
      return null;
    }

    const added = await queue.add('notification.dispatch', job, {
      // The claim key deduplicates: a Kafka redelivery that reaches here with the same key
      // finds the job already on the server and adds nothing.
      jobId: bullJobIdFor(job.claimKey),
      removeOnComplete: 100,
      removeOnFail: 1_000,
    });

    return added.id ?? null;
  }
}

/**
 * The claim key as a BullMQ job id.
 *
 * @remarks BullMQ reserves `:` — an id containing one is rejected unless it splits into
 * exactly three parts, the shape of a repeatable job — and the claim key is `<topic>:<eventId>`.
 * Passing it through raw throws from `queue.add`, which the processor sees as a failed enqueue
 * and answers by releasing the claim: every redelivery fails identically and the consumer
 * crashes on the first event it handles.
 *
 * @remarks Percent-encoding rather than swapping the separator: it is deterministic, so a
 * redelivery still collides with the job already on the server, and injective, so two distinct
 * claim keys cannot encode to the same id. The claim store keeps the plain key; this shape
 * exists only where Redis requires it.
 */
export function bullJobIdFor(claimKey: string): string {
  return encodeURIComponent(claimKey);
}
