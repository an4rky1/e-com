import type { BullQueueService } from '@auth/infra/queue';
import type {
  NotificationDispatchJob,
  NotificationDispatchQueuePort,
} from '../src/application/ports/notification-dispatch-queue.port';
import {
  bullJobIdFor,
  BullNotificationDispatchQueue,
} from '../src/infrastructure/queues/notification-dispatch.queue';

/**
 * The BullMQ adapter's one hazard: the id it hands Redis.
 *
 * @remarks The claim key is `<topic>:<eventId>` and BullMQ rejects a custom job id containing
 * `:`. Passing it through raw throws out of `queue.add`, the processor reads that as a Redis
 * outage, releases the claim and rethrows — so the very first event a consumer handles is
 * redelivered forever and the consumer crashes. These assertions are the whole rule: an id
 * BullMQ accepts, derived from the claim key so a redelivery still collides with the job
 * already on the server.
 */
describe('BullNotificationDispatchQueue', () => {
  const claimKey = 'platform.user.registered.v1:33333333-4444-4555-8666-777777777777';

  const job: NotificationDispatchJob = {
    claimKey,
    template: 'welcome',
    userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    recipient: { email: 'ada@example.com', phone: null, deviceToken: null },
    variables: { firstName: 'Ada' },
  };

  /** A queue that records what it was asked to add instead of talking to Redis. */
  const recordingQueue = (): {
    port: NotificationDispatchQueuePort;
    added: { queue: string; jobId: string | undefined }[];
  } => {
    const added: { queue: string; jobId: string | undefined }[] = [];
    const queues = {
      add: async (queue: string, _data: unknown, opts: { jobId?: string }) => {
        added.push({ queue, jobId: opts.jobId });
        return { id: opts.jobId ?? 'generated' };
      },
    };
    const service = { get: () => queues } as unknown as BullQueueService;
    return { port: new BullNotificationDispatchQueue(service), added };
  };

  it('hands BullMQ an id that carries no colon', async () => {
    const { port, added } = recordingQueue();

    await port.enqueue(job);

    expect(added[0]?.jobId).toBeDefined();
    expect(added[0]?.jobId).not.toContain(':');
  });

  it('keeps the id equal to the claim key it was derived from', () => {
    expect(decodeURIComponent(bullJobIdFor(claimKey))).toBe(claimKey);
  });

  it('is stable for one claim key, so a redelivery finds the job already there', async () => {
    const { port, added } = recordingQueue();

    await port.enqueue(job);
    await port.enqueue(job);

    expect(added[0]?.jobId).toBe(added[1]?.jobId);
  });

  it('separates claim keys that the encoding could have collided', async () => {
    const { port, added } = recordingQueue();

    await port.enqueue({ ...job, claimKey: 'platform.user.registered.v1:abc' });
    await port.enqueue({ ...job, claimKey: 'platform:user.registered.v1:abc' });

    expect(added[0]?.jobId).not.toBe(added[1]?.jobId);
  });
});
