import { NOTIFICATION_WORKER_QUEUE, type BullQueueService } from '@auth/infra/queue';
import type { Job } from 'bullmq';
import { NotificationId } from '../src/domain/value-objects/notification-id.vo';
import { NotificationChannel } from '../src/domain/value-objects/notification-channel.vo';
import type {
  Notification,
  NotificationRecipient,
} from '../src/domain/notification.aggregate';
import { InMemoryNotificationStore } from '../src/infrastructure/persistence/in-memory-notification.store';
import {
  InMemoryClaimStore,
  notificationJob,
  TestChannelRegistry,
  testNotificationConfig,
  USER_ID,
  fullRecipient,
  RecordingChannel,
} from './testing/fakes';
import {
  NotificationWorker,
  type NotificationJobPayload,
} from '../src/infrastructure/queues/notification-worker.queue';
import { SendNotificationCommand } from '../src/application/commands/notification.commands';
import { SendNotificationHandler } from '../src/application/commands/notification.handlers';
import { NotificationTemplate } from '../src/domain/value-objects/notification-template.vo';

/** A worker whose BullMQ side is an in-memory double. */
class TestWorker extends NotificationWorker {
  /** The registry it was built with; `channels` itself is private on the worker. */
  readonly registry: TestChannelRegistry;

  constructor(
    store: InMemoryNotificationStore,
    channels: TestChannelRegistry,
    claims: InMemoryClaimStore,
    config: ReturnType<typeof testNotificationConfig>,
  ) {
    // Only the queue connection needs a stand-in: the store, the registry and the claim store
    // are already the in-memory doubles this suite asserts against, so they pass through
    // uncast — which is what keeps the types here honest.
    super({ get: () => null } as unknown as BullQueueService, store, channels, claims, config);
    this.registry = channels;
  }

  /**
   * `handleJob` is protected on purpose — a job must arrive from BullMQ, not from a caller.
   * The tests drive the same path through here, with the hand-built `TestJob` double.
   */
  run(job: ReturnType<typeof notificationJob>): Promise<void> {
    return this.handleJob(job as unknown as Job<NotificationJobPayload>);
  }
}

describe('NotificationWorker', () => {
  it('registers with the queue name both sides agree on', () => {
    const worker = new TestWorker(
      new InMemoryNotificationStore((t) => `local.${t}`),
      new TestChannelRegistry(),
      new InMemoryClaimStore(),
      testNotificationConfig(),
    );
    expect(worker.queueName).toBe(NOTIFICATION_WORKER_QUEUE);
  });

  it('resends a notification whose channels previously failed', async () => {
    const { id, notification } = await sendOne();
    notification.recordDelivery({
      channel: NotificationChannel.EMAIL,
      status: 'failed',
      error: 'provider timeout',
      deliveredAt: new Date(),
    });
    await store.save(notification);

    await worker.run(notificationJob({ notificationId: id, kind: 'resend', userId: USER_ID }));

    const updated = await store.findById(NotificationId.create(id));
    const emailDelivery = updated!.deliveries.find((d) => d.channel === NotificationChannel.EMAIL)!;
    expect(emailDelivery.status).toBe('sent');
  });

  it('refuses to resend a notification whose id is not a valid uuid v4', async () => {
    await expect(
      worker.run(
        notificationJob({
          notificationId: 'not-a-uuid',
          kind: 'resend',
          userId: USER_ID,
        }),
      ),
    ).rejects.toThrow(/invalid/i);
  });

  it('refuses to resend a notification whose id is not a valid notification id', async () => {
    await expect(
      worker.run(
        notificationJob({
          notificationId: '00000000-0000-0000-0000-000000000000',
          kind: 'resend',
          userId: USER_ID,
        }),
      ),
    ).rejects.toThrow(/invalid/i);
  });

  it('skips a notification that was skipped because the recipient had no address', async () => {
    const { id, notification } = await sendOne({ email: null, phone: null, deviceToken: null });
    // WELCOME asks for inapp and email: inapp needs no address and delivers, email is the
    // one that was skipped for want of an address.
    expect(notification.deliveries).toHaveLength(2);
    const emailBefore = notification.deliveries.find(
      (d) => d.channel === NotificationChannel.EMAIL,
    )!;
    expect(emailBefore.status).toBe('skipped');

    await worker.run(notificationJob({ notificationId: id, kind: 'resend', userId: USER_ID }));

    const updated = await store.findById(NotificationId.create(id))!;
    const emailAfter = updated!.deliveries.find(
      (d) => d.channel === NotificationChannel.EMAIL,
    )!;
    expect(emailAfter.status).toBe('skipped');
  });

  it('skips a notification whose only requested channel has no address on the recipient', async () => {
    const { id, notification } = await sendOne(
      { email: null, phone: null, deviceToken: null },
      [NotificationChannel.EMAIL],
    );
    expect(notification.deliveries).toHaveLength(1);
    expect(notification.deliveries[0].status).toBe('skipped');

    await worker.run(notificationJob({ notificationId: id, kind: 'resend', userId: USER_ID }));

    const updated = await store.findById(NotificationId.create(id))!;
    expect(updated!.deliveries[0].status).toBe('skipped');
  });

  it('refuses a resend when the notification does not exist', async () => {
    await expect(
      worker.run(
        notificationJob({
          notificationId: NotificationId.create().value,
          kind: 'resend',
          userId: USER_ID,
        }),
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses a resend when the notification belongs to a different user', async () => {
    const { id } = await sendOne();
    await expect(
      worker.run(
        notificationJob({ notificationId: id, kind: 'resend', userId: 'other-user' }),
      ),
    ).rejects.toThrow(/other user/i);
  });

  it('does nothing when the queued notification id is not a valid uuid v4', async () => {
    const localStore = new InMemoryNotificationStore((t) => `local.${t}`);
    const localWorker = new TestWorker(
      localStore,
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.EMAIL, true),
        new RecordingChannel(NotificationChannel.INAPP, true),
      ]),
      new InMemoryClaimStore(),
      testNotificationConfig(),
    );

    await expect(
      localWorker.run(
        notificationJob({ notificationId: 'not-a-uuid', kind: 'resend', userId: USER_ID }),
      ),
    ).rejects.toThrow(/invalid/i);
  });

  it('cancels a notification by marking it read', async () => {
    const { id, notification } = await sendOne();
    expect(notification.isRead).toBe(false);

    await worker.run(notificationJob({ notificationId: id, kind: 'cancel', userId: USER_ID }));

    const updated = await store.findById(NotificationId.create(id))!;
    expect(updated!.isRead).toBe(true);
  });

  it('is idempotent when cancelling an already-read notification', async () => {
    const { id, notification } = await sendOne();
    notification.markRead(new Date());
    await store.save(notification);

    await worker.run(notificationJob({ notificationId: id, kind: 'cancel', userId: USER_ID }));

    const updated = await store.findById(NotificationId.create(id))!;
    expect(updated!.isRead).toBe(true);
  });
});

// ---- helpers ---------------------------------------------------------------

let store: InMemoryNotificationStore;
let worker: TestWorker;

beforeEach(() => {
  store = new InMemoryNotificationStore((type) => `local.${type}`);
  const channels = new TestChannelRegistry([
    new RecordingChannel(NotificationChannel.EMAIL, true),
    new RecordingChannel(NotificationChannel.INAPP, true),
  ]);
  worker = new TestWorker(store, channels, new InMemoryClaimStore(), testNotificationConfig());
});

async function sendOne(
  recipientOverrides: Partial<NotificationRecipient> = {},
  channels?: readonly NotificationChannel[],
): Promise<{ notification: Notification; id: string }> {
  const handler = new SendNotificationHandler(store, worker.registry);
  const command = new SendNotificationCommand(
    NotificationTemplate.WELCOME,
    USER_ID,
    fullRecipient(recipientOverrides),
    { displayName: 'Ada', source: 'web' },
    channels,
  );
  const result = await handler.execute(command);
  return {
    notification: store.records.get(result.notificationId)!,
    id: result.notificationId,
  };
}
