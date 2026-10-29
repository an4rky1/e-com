import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS } from '@auth/infra/redis';
import type { Redis } from 'ioredis';
import { CACHE_CONFIG, type CacheConfig } from './cache.config';

/**
 * Redis-backed key/value cache for the concerns that can recompute what they stored.
 *
 * @remarks JSON in, JSON out. Values are plain data — a read model, a rendered fragment, a
 * computed answer — and anything that is not serialisable was never a cache entry in the
 * first place. `undefined` reads as a miss; so does a key that expired between the get and
 * the parse.
 *
 * @remarks A missing client or `CACHE_ENABLED=false` degrades every operation rather than
 * throwing: a cache is an optimisation, and a service that cannot serve without one has
 * stopped being a service with a cache and started being a cache with a service. The boot
 * log is where that decision becomes visible.
 *
 * @remarks No stampede protection. A hot key that expires under concurrent misses recomputes
 * once per request; that is the cost of not holding a lock, and the alternative — locking
 * every miss — taxes the hit path that is the entire reason the cache exists. If a key's
 * compute is expensive enough to need a lock, the compute belongs behind its own
 * single-flight, not inside the cache.
 */
@Injectable()
export class CacheService {
  private static readonly logger = new Logger(CacheService.name);

  constructor(
    @Inject(CACHE_CONFIG) private readonly config: CacheConfig,
    @Inject(REDIS) private readonly client: Redis | null,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const client = this.activeClient();
    if (client === null) return null;

    const raw = await client.get(this.fullKey(key));
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as T;
    } catch {
      // A value that will not parse is worth deleting, not retrying: something wrote outside
      // this service's schema, and leaving it means every reader pays the parse failure.
      CacheService.logger.warn(`Discarding unparseable cache entry for key "${key}"`);
      await client.del(this.fullKey(key));
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSec?: number): Promise<void> {
    const client = this.activeClient();
    if (client === null) return;

    try {
      await client.set(
        this.fullKey(key),
        JSON.stringify(value),
        'EX',
        ttlSec ?? this.config.ttlSec,
      );
    } catch (error) {
      // Storing the answer is not why the request exists. A failed set costs the next reader
      // a recompute; a thrown set costs this reader its response.
      CacheService.logger.warn(
        `Cache set failed for key "${key}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async del(...keys: string[]): Promise<void> {
    const client = this.activeClient();
    if (client === null || keys.length === 0) return;
    await client.del(...keys.map((key) => this.fullKey(key)));
  }

  /**
   * Cache-aside: answer from the cache, or compute once and store the answer.
   *
   * @remarks The compute is awaited inside the request that missed. Concurrent misses run it
   * concurrently — see the stampede note above — and a compute that throws propagates,
   * because the caller asked for the answer and a cache that swallowed the error would
   * return `null` as though it were a legitimate cached value.
   */
  async getOrSet<T>(key: string, ttlSec: number | undefined, produce: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const computed = await produce();
    // `null` is a legitimate computed value and is simply not stored: null reads as a miss
    // everywhere in this class, so caching it would only ever recompute.
    if (computed !== null && computed !== undefined) {
      await this.set(key, computed, ttlSec);
    }
    return computed;
  }

  /** The client to operate with, or null when the cache is off or unbacked. */
  private activeClient(): Redis | null {
    return this.config.enabled ? this.client : null;
  }

  private fullKey(key: string): string {
    return `${this.config.prefix}:${key}`;
  }
}
