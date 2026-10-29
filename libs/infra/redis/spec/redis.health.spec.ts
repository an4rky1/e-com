import { RedisHealthIndicator } from '../src/redis.health';
import { RedisService } from '../src/redis.service';

describe('RedisHealthIndicator', () => {
  it('reports up when the ping round-trips', async () => {
    const service = { ping: jest.fn().mockResolvedValue(undefined) } as unknown as RedisService;
    const indicator = new RedisHealthIndicator(service);

    await expect(indicator.check()).resolves.toMatchObject({ redis: { status: 'up' } });
  });

  it('reports down with the reason when the server cannot be reached', async () => {
    const service = {
      ping: jest.fn().mockRejectedValue(new Error('Connection is closed.')),
    } as unknown as RedisService;
    const indicator = new RedisHealthIndicator(service);

    await expect(indicator.check()).resolves.toMatchObject({
      redis: { status: 'down', message: 'Connection is closed.' },
    });
  });

  it('reports down — not a crash — when the process has no Redis at all', async () => {
    const indicator = new RedisHealthIndicator(new RedisService(null));

    await expect(indicator.check()).resolves.toMatchObject({ redis: { status: 'down' } });
  });
});
