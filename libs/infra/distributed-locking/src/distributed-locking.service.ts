import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { REDIS } from '@auth/infra/redis';
import type { Redis } from 'ioredis';
import { LOCKING_CONFIG, type LockingConfig } from './distributed-locking.config';

/** A released lock proves ownership by echoing the token it was created with. */
const ACQUIRE_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return 1
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export class LockTimeoutError extends Error {
  constructor(key: string, attempts: number) {
    super(`Could not acquire lock "${key}" after ${attempts} attempts`);
    this.name = 'LockTimeoutError';
  }
}

export interface LockHandle {
  /** Extends the lock's TTL. Returns false when the lock was already lost. */
  renew(ttlMs?: number): Promise<boolean>;
  /** Releases the lock. Safe to call twice: the second call is a no-op. */
  release(): Promise<void>;
}

/**
 * The distributed mutex port.
 *
 * @remarks `withLock` is the primary surface: a caller that acquires and forgets to
 * release holds the critical section until the TTL expires, which under load is the same
 * as holding it forever. The handle-returning form exists for the few call sites (a
 * multi-step merge) that cannot express their work as one callback.
 */
export interface DistributedLock {
  withLock<T>(key: string, fn: () => Promise<T>, options?: { ttlMs?: number }): Promise<T>;
  tryLock(key: string, options?: { ttlMs?: number }): Promise<LockHandle | null>;
}

/** Redis absent: the lock degrades to a pass-through rather than failing the service. */
class NullDistributedLock implements DistributedLock {
  private static readonly logger = new Logger(NullDistributedLock.name);
  private warned = false;

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.warned) {
      NullDistributedLock.logger.warn(
        'REDIS_URL is not set; distributed locking is disabled and critical sections run unguarded',
      );
      this.warned = true;
    }
    return fn();
  }

  async tryLock(): Promise<LockHandle | null> {
    return {
      renew: async () => true,
      release: async () => undefined,
    };
  }
}

/** Lua scripts: acquire / release / renew, each guarded by the owner's token. */
class RedisDistributedLock implements DistributedLock {
  /** Scripts load once per process; the promise map makes that a single round-trip. */
  private readonly loaded = new Map<string, Promise<string>>();

  constructor(
    private readonly redis: Redis,
    private readonly config: LockingConfig,
  ) {}

  private async eval(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<unknown> {
    // ioredis types `script` as Result<unknown>; a LOAD returns the script's SHA-1.
    const shaPromise =
      this.loaded.get(script) ??
      (this.redis.script('LOAD', script) as Promise<string>);
    this.loaded.set(script, shaPromise);
    try {
      const sha = await shaPromise;
      return await this.redis.evalsha(sha, keys.length, ...keys, ...args.map(String));
    } catch (error) {
      // A failover can flush the script cache: re-eval once and keep the memo for next time.
      if (String(error).includes('NOSCRIPT')) {
        this.loaded.delete(script);
        return this.redis.eval(script, keys.length, ...keys, ...args.map(String));
      }
      throw error;
    }
  }

  private key(k: string): string {
    return `${this.config.keyPrefix}:${k}`;
  }

  async tryLock(name: string, options: { ttlMs?: number } = {}): Promise<LockHandle | null> {
    const key = this.key(name);
    const token = randomUUID();
    const ttl = options.ttlMs ?? this.config.ttlMs;

    const acquired = await this.eval(ACQUIRE_SCRIPT, [key], [token, ttl]);
    if (acquired !== 1) return null;

    let held = true;
    return {
      renew: async (renewTtlMs?: number) => {
        if (!held) return false;
        const result = await this.eval(RENEW_SCRIPT, [key], [token, renewTtlMs ?? ttl]);
        return result === 1;
      },
      release: async () => {
        if (!held) return;
        held = false;
        await this.eval(RELEASE_SCRIPT, [key], [token]);
      },
    };
  }

  async withLock<T>(
    name: string,
    fn: () => Promise<T>,
    options: { ttlMs?: number } = {},
  ): Promise<T> {
    const deadline = Date.now() + this.config.retryMs * this.config.maxRetries;
    let attempts = 0;

    for (;;) {
      attempts += 1;
      const handle = await this.tryLock(name, options);
      if (handle) {
        try {
          return await fn();
        } finally {
          await handle.release();
        }
      }
      if (Date.now() >= deadline || attempts >= this.config.maxRetries) {
        throw new LockTimeoutError(name, attempts);
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.retryMs));
    }
  }
}

@Injectable()
export class DistributedLockingService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis | null,
    @Inject(LOCKING_CONFIG) private readonly config: LockingConfig,
  ) {}

  private impl(): DistributedLock {
    if (this.redis === null) return new NullDistributedLock();
    return new RedisDistributedLock(this.redis, this.config);
  }

  withLock<T>(key: string, fn: () => Promise<T>, options?: { ttlMs?: number }): Promise<T> {
    return this.impl().withLock(key, fn, options);
  }

  tryLock(key: string, options?: { ttlMs?: number }): Promise<LockHandle | null> {
    return this.impl().tryLock(key, options);
  }
}
