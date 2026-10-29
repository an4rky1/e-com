import type { Redis } from 'ioredis';
import { CacheService } from '../src/cache.service';
import { type CacheConfig } from '../src/cache.config';

/** The three commands the service uses. A double, not a server: the Lua-free surface is the point. */
const fakeClient = () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
});

const config: CacheConfig = { enabled: true, ttlSec: 300, prefix: 'cache' };

const serviceWith = (client: Redis | null, overrides: Partial<CacheConfig> = {}) =>
  new CacheService({ ...config, ...overrides }, client);

describe('CacheService', () => {
  it('reads a miss as null', async () => {
    const client = fakeClient();

    await expect(serviceWith(client as unknown as Redis).get('user:1')).resolves.toBeNull();
    expect(client.get).toHaveBeenCalledWith('cache:user:1');
  });

  it('round-trips JSON under the configured prefix', async () => {
    const client = fakeClient();
    client.set.mockResolvedValue('OK');
    const service = serviceWith(client as unknown as Redis);

    await service.set('user:1', { id: 1, name: 'Ada' });
    client.get.mockResolvedValue('{"id":1,"name":"Ada"}');

    await expect(service.get('user:1')).resolves.toEqual({ id: 1, name: 'Ada' });
    expect(client.set).toHaveBeenCalledWith('cache:user:1', '{"id":1,"name":"Ada"}', 'EX', 300);
  });

  it('honours a per-call ttl over the default', async () => {
    const client = fakeClient();

    await serviceWith(client as unknown as Redis).set('otp:9', '123456', 60);

    expect(client.set).toHaveBeenCalledWith('cache:otp:9', '"123456"', 'EX', 60);
  });

  it('deletes a value that will not parse, and reports it as a miss', async () => {
    const client = fakeClient();
    client.get.mockResolvedValue('{not json');
    const service = serviceWith(client as unknown as Redis);

    await expect(service.get('broken')).resolves.toBeNull();
    expect(client.del).toHaveBeenCalledWith('cache:broken');
  });

  it('deletes every key it was given, each under the prefix', async () => {
    const client = fakeClient();

    await serviceWith(client as unknown as Redis).del('a', 'b');

    expect(client.del).toHaveBeenCalledWith('cache:a', 'cache:b');
  });

  it('swallows a failed set — a cache write is not why the request exists', async () => {
    const client = fakeClient();
    client.set.mockRejectedValue(new Error('READONLY'));

    await expect(serviceWith(client as unknown as Redis).set('a', 1)).resolves.toBeUndefined();
  });

  it('answers every question with a miss when disabled, without touching the client', async () => {
    const client = fakeClient();
    const service = serviceWith(client as unknown as Redis, { enabled: false });

    await expect(service.get('a')).resolves.toBeNull();
    await service.set('a', 1);
    await service.del('a');

    expect(client.get).not.toHaveBeenCalled();
    expect(client.set).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('degrades the same way when the platform gave it no client', async () => {
    const service = serviceWith(null);

    await expect(service.get('a')).resolves.toBeNull();
    await expect(service.set('a', 1)).resolves.toBeUndefined();
    await expect(service.del('a')).resolves.toBeUndefined();
  });

  describe('getOrSet', () => {
    it('computes and stores on a miss', async () => {
      const client = fakeClient();
      const produce = jest.fn().mockResolvedValue({ total: 7 });
      const service = serviceWith(client as unknown as Redis);

      await expect(service.getOrSet('stats', undefined, produce)).resolves.toEqual({ total: 7 });
      expect(produce).toHaveBeenCalledTimes(1);
      expect(client.set).toHaveBeenCalledWith('cache:stats', '{"total":7}', 'EX', 300);
    });

    it('does not compute on a hit', async () => {
      const client = fakeClient();
      client.get.mockResolvedValue('{"total":7}');
      const produce = jest.fn();

      const result = await serviceWith(client as unknown as Redis).getOrSet('stats', undefined, produce);

      expect(result).toEqual({ total: 7 });
      expect(produce).not.toHaveBeenCalled();
    });

    it('propagates a compute failure — a thrown produce is not a cached miss', async () => {
      const client = fakeClient();
      const produce = jest.fn().mockRejectedValue(new Error('upstream down'));

      await expect(serviceWith(client as unknown as Redis).getOrSet('stats', undefined, produce)).rejects.toThrow(
        'upstream down',
      );
    });

    it('returns a computed null without storing it — null reads as a miss forever', async () => {
      const client = fakeClient();
      const produce = jest.fn().mockResolvedValue(null);

      await expect(serviceWith(client as unknown as Redis).getOrSet('absent', undefined, produce)).resolves.toBeNull();
      expect(client.set).not.toHaveBeenCalled();
    });
  });
});
