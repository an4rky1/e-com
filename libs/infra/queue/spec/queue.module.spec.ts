import type { Queue } from 'bullmq';
import { resolveQueueConfig } from '../src/queue.config';
import { defaultJobOptionsFor, QueueModule } from '../src/queue.module';
import { BullQueueService } from '../src/queue.service';
import { QUEUE_REGISTRY } from '../src/queue.config';
import type { RedisConfig } from '@auth/infra/redis';

describe('resolveQueueConfig', () => {
  it('defaults to the platform retry posture', () => {
    const config = resolveQueueConfig({});

    expect(config).toEqual({
      attempts: 3,
      backoffMs: 5_000,
      removeOnComplete: 100,
      removeOnFail: 1_000,
      defaultLockDurationMs: 60_000,
    });
  });

  it('honours the QUEUE_* overrides', () => {
    const config = resolveQueueConfig({
      QUEUE_ATTEMPTS: '5',
      QUEUE_BACKOFF_MS: '2500',
      QUEUE_REMOVE_ON_COMPLETE: '10',
      QUEUE_REMOVE_ON_FAIL: '50',
    });

    expect(config.attempts).toBe(5);
    expect(config.backoffMs).toBe(2_500);
    expect(config.removeOnComplete).toBe(10);
    expect(config.removeOnFail).toBe(50);
  });
});

describe('defaultJobOptionsFor', () => {
  it('turns the config into BullMQ job options with exponential backoff', () => {
    const options = defaultJobOptionsFor({
      attempts: 3,
      backoffMs: 5_000,
      removeOnComplete: 100,
      removeOnFail: 1_000,
      defaultLockDurationMs: 60_000,
    });

    expect(options).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 1_000,
    });
  });
});

describe('BullQueueService', () => {
  const queue = () => ({ close: jest.fn().mockResolvedValue(undefined) }) as unknown as Queue;

  it('returns null for a name it never registered, rather than throwing', () => {
    const service = new BullQueueService(new Map([['email', queue()]]));

    expect(service.get('email')).not.toBeNull();
    expect(service.get('sms')).toBeNull();
  });

  it('lists the registered names', () => {
    const service = new BullQueueService(
      new Map([
        ['email', queue()],
        ['audit', queue()],
      ]),
    );

    expect(service.names().sort()).toEqual(['audit', 'email']);
  });

  it('closes every queue on shutdown, even when one refuses', async () => {
    const stubborn = { close: jest.fn().mockRejectedValue(new Error('stuck')) };
    const gentle = { close: jest.fn().mockResolvedValue(undefined) };
    const service = new BullQueueService(
      new Map([
        ['a', stubborn as unknown as Queue],
        ['b', gentle as unknown as Queue],
      ]),
    );

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(stubborn.close).toHaveBeenCalled();
    expect(gentle.close).toHaveBeenCalled();
  });
});

describe('QueueModule', () => {
  const noRedis: RedisConfig = {
    url: null,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeoutMs: 5_000,
  };

  it('creates an empty registry when Redis is absent — degraded, not dead', () => {
    const dynamicModule = QueueModule.register({ queues: ['email'] });
    const provider = (dynamicModule.providers ?? []).find(
      (p) => (p as { provide?: symbol }).provide === QUEUE_REGISTRY,
    ) as { useFactory: (redis: RedisConfig) => BullQueueService };

    const registry = provider.useFactory(noRedis);

    expect(registry.names()).toEqual([]);
    expect(registry.get('email')).toBeNull();
  });
});
