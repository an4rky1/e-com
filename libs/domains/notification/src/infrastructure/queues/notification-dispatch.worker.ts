import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  BaseQueueWorker,
  BullQueueService,
  NOTIFICATION_DISPATCH_QUEUE,
} from '@auth/infra/queue';
import { NOTIFICATION_DISPATCHER, type NotificationDispatcherPort } from '../../application/ports/notification-dispatcher.port';
import { toSendNotificationCommand } from '../../application/commands/notification.commands';
import { NOTIFICATION_CONFIG, type NotificationConfig } from '../../notification.config';
import type { NotificationDispatchJob } from '../../application/ports/notification-dispatch-queue.port';

/** Progress a dispatch job reports, so a dashboard can see what landed. */
export interface NotificationDispatchProgress {
  readonly ok: boolean;
  readonly notificationId: string;
  readonly template: string;
  readonly redactedVariables?: readonly string[];
}

/**
 * Delivers what the Kafka consumer enqueued.
 *
 * @remarks The consumer's job ends at the enqueue; this worker's job begins there. The split
 * is what lets the consume side commit an offset in milliseconds while the send — a provider
 * call with its own deadline and its own retry policy — runs on BullMQ's budget instead of
 * the broker's.
 *
 * @remarks No rate limiter, unlike the resend worker. The dispatch queue is the hot path:
 * one job per consumed event, and a limiter here would throttle every welcome email behind
 * the resend budget of ten a minute.
 */
@Injectable()
export class NotificationDispatchWorker extends BaseQueueWorker<NotificationDispatchJob> {
  private readonly logger = new Logger(NotificationDispatchWorker.name);

  constructor(
    queues: BullQueueService,
    @Inject(NOTIFICATION_DISPATCHER) private readonly dispatcher: NotificationDispatcherPort,
    @Inject(NOTIFICATION_CONFIG) config: NotificationConfig,
  ) {
    super(
      queues,
      NOTIFICATION_DISPATCH_QUEUE,
      'notification-dispatch',
      config.dispatchConcurrency,
    );
  }

  override onModuleInit(): void {
    super.onModuleInit();
    this.logger.log('notification dispatch worker initialised');
  }

  protected override lockDurationMs(): number {
    // A dispatch is a provider call with its own timeout; the platform default is already
    // conservative enough for one.
    return 30_000;
  }

  protected async handleJob(job: Job<NotificationDispatchJob>): Promise<void> {
    const payload = job.data;

    try {
      const result = await this.dispatcher.send(
        toSendNotificationCommand({
          template: payload.template,
          userId: payload.userId,
          recipient: payload.recipient,
          variables: payload.variables,
          ...(payload.channels ? { channels: payload.channels } : {}),
          ...(payload.correlationId ? { correlationId: payload.correlationId } : {}),
        }),
      );

      const progress: NotificationDispatchProgress = {
        ok: true,
        notificationId: result.notificationId,
        template: result.template,
        ...(result.redactedVariables.length > 0
          ? { redactedVariables: result.redactedVariables }
          : {}),
      };
      await job.updateProgress(progress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `dispatch job ${payload.claimKey} failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      // Thrown so BullMQ's retry policy owns it: transient failures get the platform's
      // three attempts, and a permanent one lands in the failed set where an operator sees it.
      throw error;
    }
  }
}
