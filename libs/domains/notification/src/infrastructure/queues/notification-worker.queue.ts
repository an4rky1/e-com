import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { BaseQueueWorker } from '@auth/infra/queue';
import { NOTIFICATION_WORKER_QUEUE, BullQueueService } from '@auth/infra/queue';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../../notification.config';
import { NotificationId } from '../../domain/value-objects/notification-id.vo';
import {
  NOTIFICATION_STORE,
  type NotificationStorePort,
} from '../../domain/ports/notification-store.port';
import {
  CONSUMER_CLAIM_STORE,
  type ConsumerClaimStorePort,
  claimKeyFor,
} from '../../domain/ports/consumer-claim.port';
import {
  channelRequiresAddress,
  DeliveryStatus,
  NotificationChannel,
} from '../../domain/value-objects/notification-channel.vo';
import { addressFor } from '../../domain/notification.aggregate';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannelRegistry,
  type NotificationMessage,
} from '../../domain/ports/notification-channel.port';
import { Notification } from '../../domain/notification.aggregate';

/** Payload a notification job understands. */
export interface NotificationJobPayload {
  readonly notificationId: string;
  readonly kind: 'resend' | 'cancel';
  readonly userId: string;
  readonly scheduleAt?: string;
  readonly correlationId?: string;
}

export interface NotificationJobResult {
  readonly ok: boolean;
  readonly notificationId: string;
  readonly kind: NotificationJobPayload['kind'];
  readonly error?: string;
}

/**
 * Notification background work: resend and cancellation via BullMQ.
 *
 * @remarks The worker is the only place a resend or a cancellation becomes real. The API side
 * only orders it — enqueues the job and returns a correlation id — so the caller never waits
 * on a provider deadline and never learns anything about a downstream channel we would not
 * want to leak through an HTTP response.
 *
 * @remarks Resend is rate-limited per user so a buggy client cannot flood a provider by
 * requesting ten resends a minute. Cancellation is idempotent: a second cancel of the same
 * notification is a no-op, and the worker records why.
 */
@Injectable()
export class NotificationWorker extends BaseQueueWorker<NotificationJobPayload> {
  private readonly logger = new Logger(NotificationWorker.name);

  constructor(
    queues: BullQueueService,
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStorePort,
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: NotificationChannelRegistry,
    @Inject(CONSUMER_CLAIM_STORE) private readonly claims: ConsumerClaimStorePort,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {
    super(queues, NOTIFICATION_WORKER_QUEUE, 'notification-worker', 1);
  }

  override onModuleInit(): void {
    super.onModuleInit();
    this.logger.log('notification worker initialised');
  }

  protected override limiter(): { max: number; duration: number } | undefined {
    // One resend/cancel per configured window, per worker, so a single replica cannot saturate
    // a provider by replaying the same resend queue as fast as possible.
    return {
      max: this.config.resendRateLimitPerMinute,
      duration: 60_000,
    };
  }

  protected override lockDurationMs(): number {
    // Resend and cancellation touch one notification and record one outcome; they should never
    // hold a lock long enough to look stalled. The platform default is already conservative.
    return 30_000;
  }

  protected async handleJob(job: Job<NotificationJobPayload>): Promise<void> {
    const payload = job.data;
    const id = NotificationId.create(payload.notificationId);

    try {
      if (payload.kind === 'cancel') {
        await this.cancel(id, payload.userId, payload.correlationId);
        await job.updateProgress({ ok: true, notificationId: id.value, kind: 'cancel' });
        return;
      }

      if (payload.scheduleAt && new Date(payload.scheduleAt) > new Date()) {
        // Not due yet. Re-enqueue with the same payload so a future tick picks it up; the
        // scheduler deduplicates on id so a duplicate is a no-op rather than two jobs.
        await this.requeueLater(job, payload);
        return;
      }

      await this.resend(id, payload.userId, payload.correlationId);
      await job.updateProgress({ ok: true, notificationId: id.value, kind: 'resend' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`notification job failed: ${message}`, error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  /** Re-enqueue the job at the next tick so the scheduler can attempt again later. */
  private async requeueLater(
    job: Job<NotificationJobPayload>,
    payload: NotificationJobPayload,
  ): Promise<void> {
    // Reset attempts so a delayed job does not burn through the retry budget while waiting.
    await job.remove();
    const queue = this.queues.get(this.queueName);
    if (queue === null) {
      throw new Error('notification worker queue is absent');
    }
    await queue.add('notification.task', payload, {
      jobId: job.id,
      removeOnComplete: 100,
      removeOnFail: 1_000,
    });
  }

  private async resend(
    id: NotificationId,
    userId: string,
    correlationId?: string,
  ): Promise<void> {
    const existing = await this.store.findById(id);
    if (!existing || existing.userId !== userId) {
      // A resend of something this service cannot find — or that belongs to somebody else —
      // is refused rather than swallowed: the job is invalid, and a retry will not change
      // that. Same contract as cancel.
      throw new Error(
        `cannot resend notification ${id.value}: not found or other user`,
      );
    }

    // A notification whose channels have all already been attempted once is a candidate for a
    // fresh attempt; one whose channels are all `skipped` because the recipient had no address
    // is not.
    if (existing.channels.length === 0) {
      return;
    }

    const toRetry =
      existing.deliveries.filter((d) => d.status !== DeliveryStatus.SENT);
    for (const delivery of toRetry) {
      await this.retryChannel(existing, delivery.channel, correlationId);
    }
  }

  private async retryChannel(
    notification: Notification,
    channel: NotificationChannel,
    correlationId?: string,
  ): Promise<void> {
    // Re-render from the stored body so a template that changed in the meantime does not silently
    // change the message the user already received once. The stored body is the source of truth
    // for resends.
    const existing = notification;
    const adapter = this.channels.resolve(channel);
    if (!adapter) {
      existing.recordDelivery({
        channel,
        status: DeliveryStatus.SKIPPED,
        error: 'channel unbound at resend time',
        deliveredAt: new Date(),
      });
      await this.store.save(existing);
      return;
    }

    const address = addressFor(existing.recipient, channel);
    if (channelRequiresAddress(channel) && address === null) {
      // Nothing to resend to. Recording the skip keeps the resend path's contract with the
      // dispatch loop: no address is a durable `skipped`, not an attempt that failed.
      existing.recordDelivery({
        channel,
        status: DeliveryStatus.SKIPPED,
        error: `no address for channel ${channel}`,
        deliveredAt: new Date(),
      });
      await this.store.save(existing);
      return;
    }

    const message: NotificationMessage = {
      notificationId: existing.id.value,
      userId: existing.userId,
      template: existing.template,
      subject: existing.subject,
      body: existing.body,
      variables: existing.variables,
      recipient: existing.recipient,
      severity: existing.severity,
      address,
    };

    try {
      const receipt = await adapter.deliver(message);
      existing.recordDelivery({
        channel,
        status: receipt.status,
        ...(receipt.providerMessageId ? { providerMessageId: receipt.providerMessageId } : {}),
        ...(receipt.error ? { error: receipt.error } : {}),
        deliveredAt: new Date(),
      });
    } catch (error) {
      existing.recordDelivery({
        channel,
        status: DeliveryStatus.FAILED,
        error: error instanceof Error ? error.message : String(error),
        deliveredAt: new Date(),
      });
    }

    await this.store.save(existing);
  }

  private async cancel(
    id: NotificationId,
    userId: string,
    correlationId?: string,
  ): Promise<void> {
    const existing = await this.store.findById(id);
    if (!existing || existing.userId !== userId) {
      throw new Error(`cannot cancel notification ${id.value}: not found or other user`);
    }

    // A notification that already settled its deliveries is cancelled by marking it read and
    // recording the cancellation as a terminal note, not by undoing the deliveries.
    if (!existing.isRead) {
      existing.markRead(new Date(), correlationId);
    }

    await this.store.save(existing);

    // Release any lingering consumer claim so a redelivery of the original event does not
    // re-create a notification the user has already asked to cancel.
    const claimKey = claimKeyFor('platform.notification.cancel.v1', id.value);
    await this.claims.release(claimKey).catch(() => undefined);
  }

    /**
   * Enqueues a resend or cancellation job.
   *
   * @remarks The only public envoy of the worker; the API layer calls this. Returns the job id
   * so a caller can correlate a request with the background work if it wants to.
   */
  async enqueue(
    payload: NotificationJobPayload,
  ): Promise<string | null> {
    const queue = this.queues.get(this.queueName);
    if (queue === null) {
      // Degraded: Redis was absent when the module started, or the queue name was never
      // registered. Same contract as the rest of the platform — enqueueing returns null and the
      // caller decides.
      return null;
    }

    const job = await queue.add('notification.task', payload, {
      removeOnComplete: 100,
      removeOnFail: 1_000,
      jobId: crypto.randomUUID(),
    });

    return job.id ?? null;
  }
}
