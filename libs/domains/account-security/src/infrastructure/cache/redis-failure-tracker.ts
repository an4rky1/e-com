/**
 * @fileoverview Redis adapter for the rate counters and the known-device registry.
 *
 * @remarks Two ports, one connection. The counters are a rate and the registry is a set of
 * decisions; both are things Redis is better at than a relational table, and both are
 * reconstructible — the counters from the login history, the registry from `login_history` plus
 * a revocation signal — so a cache flush degrades the product rather than losing data.
 *
 * @remarks The adapter performs no arithmetic. It reads and writes the numbers the
 * `LoginAttempt` aggregate produced; deciding what a counter *means* is the domain's job, and
 * an `INCR`-then-lock implementation would put the lockout policy in a file that cannot be
 * tested without a Redis server.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ACCOUNT_SECURITY_REDIS } from '../../account-security.config';
import type { FailureTrackerPort } from '../../domain/ports/failure-tracker.port';
import type { DeviceRegistryPort } from '../../domain/ports/security-repository.port';
import {
  EMPTY_COUNTERS,
  normaliseScope,
  type FailureCounters,
  type FailureScope,
} from '../../domain/value-objects/failure-counters.vo';

/** Construction options. Passed by the module, never read from the environment in here. */
export interface RedisCounterOptions {
  /** Prefix every key this service writes. Namespaced so a shared Redis stays shareable. */
  keyPrefix: string;
  /** TTL on the failure counters: how long a run of failures stays a run. */
  failureWindowSec: number;
  /** TTL on a known-device marker. Long enough to outlive a holiday. */
  deviceTtlSec: number;
}

@Injectable()
export class RedisFailureTracker implements FailureTrackerPort, DeviceRegistryPort {
  private readonly logger = new Logger(RedisFailureTracker.name);

  constructor(
    @Inject(ACCOUNT_SECURITY_REDIS) private readonly redis: Redis,
    private readonly options: RedisCounterOptions,
  ) {}

  // ---- FailureTrackerPort -------------------------------------------------------

  async load(scope: FailureScope): Promise<FailureCounters> {
    const { userKey, ipKey, lockKey } = this.keys(scope);

    const [userRaw, ipRaw, lockRaw] = await Promise.all([
      userKey === null ? Promise.resolve(null) : this.redis.get(userKey),
      ipKey === null ? Promise.resolve(null) : this.redis.get(ipKey),
      lockKey === null ? Promise.resolve(null) : this.redis.get(lockKey),
    ]);

    return {
      userFailures: readCount(userRaw),
      ipFailures: readCount(ipRaw),
      lockedUntil: readInstant(lockRaw),
    };
  }

  /**
   * Writes both counters and the lock.
   *
   * @remarks The lock's TTL is its own length, taken from `lockedUntil` rather than from a
   * configured default. A key that outlives the timestamp it encodes is a lock that lifts itself
   * when nobody is looking; a key that never lifts is how a real person gets stranded, which is
   * the failure mode this service is most careful about.
   */
  async save(scope: FailureScope, counters: FailureCounters): Promise<void> {
    const { userKey, ipKey, lockKey } = this.keys(scope);

    if (userKey !== null) await this.writeCount(userKey, counters.userFailures);
    if (ipKey !== null) await this.writeCount(ipKey, counters.ipFailures);
    if (lockKey === null) return;

    if (counters.lockedUntil === null) {
      await this.redis.del(lockKey);
      return;
    }

    const ttlSec = Math.max(1, Math.ceil((counters.lockedUntil.getTime() - Date.now()) / 1000));
    await this.redis.set(lockKey, counters.lockedUntil.toISOString(), 'EX', String(ttlSec));
  }

  async clear(scope: FailureScope): Promise<void> {
    const { userKey, ipKey, lockKey } = this.keys(scope);
    const keys = [userKey, ipKey, lockKey].filter((key): key is string => key !== null);

    if (keys.length > 0) await this.redis.del(...keys);
  }

  // ---- DeviceRegistryPort -------------------------------------------------------

  /**
   * Whether this account has signed in from this fingerprint.
   *
   * @remarks `true` for an unknown user. Nothing can have signed in *with* an account that does
   * not exist, and answering `false` would raise `new_device_detected` for every request an
   * unauthenticated caller makes — a signal that fires constantly means nothing.
   */
  async isKnown(userId: string, fingerprint: string): Promise<boolean> {
    if (!userId) return true;
    return (await this.redis.exists(this.deviceKey(userId, fingerprint))) === 1;
  }

  async isRevoked(userId: string, fingerprint: string): Promise<boolean> {
    if (!userId) return false;
    return (await this.redis.exists(this.revokedKey(userId, fingerprint))) === 1;
  }

  async remember(userId: string, fingerprint: string): Promise<void> {
    await this.redis.set(
      this.deviceKey(userId, fingerprint),
      new Date().toISOString(),
      'EX',
      String(this.options.deviceTtlSec),
    );
  }

  async revoke(userId: string, fingerprint: string): Promise<void> {
    // No TTL: a revocation that expired would bring a retired device back on its own, with
    // nobody deciding to. One key per retired device is not a thing that grows without bound.
    await this.redis.set(this.revokedKey(userId, fingerprint), new Date().toISOString());
    this.logger.log(`revoked device ${fingerprint.slice(0, 12)} for ${userId}`);
  }

  // ---- keys ---------------------------------------------------------------------

  private keys(scope: FailureScope): {
    userKey: string | null;
    ipKey: string | null;
    lockKey: string | null;
  } {
    const normalised = normaliseScope(scope);
    const userKey =
      normalised.userId === null ? null : `${this.options.keyPrefix}:fail:user:${normalised.userId}`;

    return {
      userKey,
      ipKey:
        normalised.ipAddress === null
          ? null
          : `${this.options.keyPrefix}:fail:ip:${normalised.ipAddress}`,
      lockKey: userKey === null ? null : `${userKey}:lock`,
    };
  }

  private deviceKey(userId: string, fingerprint: string): string {
    return `${this.options.keyPrefix}:device:${userId}:${fingerprint}`;
  }

  private revokedKey(userId: string, fingerprint: string): string {
    return `${this.options.keyPrefix}:revoked:${userId}:${fingerprint}`;
  }

  /** Written rather than deleted, so the window restarts from *this* failure. */
  private async writeCount(key: string, value: number): Promise<void> {
    await this.redis.set(
      key,
      String(Math.max(0, value)),
      'EX',
      String(this.options.failureWindowSec),
    );
  }
}

/** A counter read is zero for a missing key and for anything unparseable. */
function readCount(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The lock's expiry, as a date.
 *
 * @remarks A missing or unparseable key is `null` — no lock — because the value is written with
 * the TTL of its own expiry, so an expired key cannot be a lock that outlives itself. A
 * hand-edited or truncated value fails closed *and* open in different ways; `null` at least
 * leaves the user able to sign in and leaves the lock history intact for whoever looks.
 */
function readInstant(raw: string | null): Date | null {
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The store installed when `ACCOUNT_SECURITY_CACHE_ENABLED=false` or no Redis url is set.
 *
 * @remarks Every method succeeds and every read is zero, which means no lockout, no per-ip
 * limit, and every device answered as known. That is a worse product, and it is why the module
 * warns at boot when this one is wired in. What it is *not* is an outage: a deployment without
 * Redis still signs people in.
 *
 * @remarks Deliberately not an in-memory store. An in-memory one would work perfectly on one
 * pod and reset on every deploy and every scale-up, which is far harder to notice than a
 * degradation that is off in every process at once.
 */
@Injectable()
export class NoopFailureTracker implements FailureTrackerPort, DeviceRegistryPort {
  load(): Promise<FailureCounters> {
    return Promise.resolve({ ...EMPTY_COUNTERS });
  }

  save(): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Always known.
   *
   * @remarks `false` here would raise `new_device_detected` on every request the service
   * receives — a signal that fires constantly carries no information, and the consequence is
   * that a real new device is indistinguishable from the noise around it.
   */
  isKnown(): Promise<boolean> {
    return Promise.resolve(true);
  }

  isRevoked(): Promise<boolean> {
    return Promise.resolve(false);
  }

  remember(): Promise<void> {
    return Promise.resolve();
  }

  revoke(): Promise<void> {
    return Promise.resolve();
  }
}