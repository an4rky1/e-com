import { RedisModule } from '../src/redis.module';
import { RedisService } from '../src/redis.service';
import { REDIS, REDIS_CONFIG } from '../src/redis.config';
import type { Redis } from 'ioredis';

describe('RedisModule', () => {
  it('builds without a REDIS_URL, providing a null client rather than failing', () => {
    const previous = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    try {
      const dynamicModule = RedisModule.forRoot();
      const providers = dynamicModule.providers ?? [];

      const configProvider = providers.find((p) => (p as { provide?: symbol }).provide === REDIS_CONFIG);
      const clientProvider = providers.find((p) => (p as { provide?: symbol }).provide === REDIS);

      expect(configProvider).toBeDefined();
      expect(clientProvider).toBeDefined();

      const client = (clientProvider as { useFactory: () => Redis | null }).useFactory();
      expect(client).toBeNull();
    } finally {
      if (previous !== undefined) process.env.REDIS_URL = previous;
    }
  });

  it('exports the client token, the service and the health indicator together', () => {
    const dynamicModule = RedisModule.forRoot();

    expect(dynamicModule.exports).toEqual(
      expect.arrayContaining([REDIS, REDIS_CONFIG, RedisService]),
    );
  });
});

describe('RedisService', () => {
  it('reports unavailable and refuses to ping when there is no client', async () => {
    const service = new RedisService(null);

    expect(service.available).toBe(false);
    await expect(service.ping()).rejects.toThrow(/REDIS_URL/);
  });

  it('closes nothing when there is nothing to close', async () => {
    const service = new RedisService(null);

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('quits the client on shutdown', async () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const client = { quit } as unknown as Redis;
    const service = new RedisService(client);

    expect(service.available).toBe(true);
    await service.onModuleDestroy();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('survives a quit that throws — shutdown must not fail on a dead socket', async () => {
    const client = { quit: jest.fn().mockRejectedValue(new Error('Connection is closed.')) } as unknown as Redis;
    const service = new RedisService(client);

    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
