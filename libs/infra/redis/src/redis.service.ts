import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from './redis.config';

/**
 * The process's single Redis connection, and its lifecycle.
 *
 * @remarks One client per process, shared by every concern in it. ioredis multiplexes
 * commands over one connection; a second client is a second socket doing the same job, and
 * the "one private client per domain" habit multiplies connections without isolating
 * anything — the keys were already namespaced, and the server was shared either way.
 *
 * @remarks There are no get/set wrappers here on purpose. The clients that need Redis speak
 * ioredis (a Lua script, a counter pipeline); wrapping every command would be a second API to
 * keep in sync for no isolation gained. What this service adds is what the raw client lacks:
 * a defined null when Redis is absent, a shutdown that closes the socket, and a health probe.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private static readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS) readonly client: Redis | null) {}

  /** False when the platform gave this process no Redis, so consumers can branch once. */
  get available(): boolean {
    return this.client !== null;
  }

  /**
   * Round-trips a PING.
   *
   * @remarks Throws rather than answering a boolean: the health indicator turns the throw
   * into a `down` report, and a consumer that wants a boolean already has `available` for
   * the configured/not-configured question — this one answers the *reachable* question.
   */
  async ping(): Promise<void> {
    if (this.client === null) {
      throw new Error('Redis is not configured (REDIS_URL is not set)');
    }
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client === null) return;
    try {
      // quit lets in-flight commands finish; a hard disconnect would fail them for no reason
      // during a shutdown that is supposed to be orderly.
      await this.client.quit();
    } catch (error) {
      RedisService.logger.warn(
        `Redis quit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
