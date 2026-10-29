/**
 * @fileoverview The orchestration: scope a client key to this caller and this route, then
 * claim it, replay from it, or refuse it.
 *
 * @remarks Scoping is the adaptation the reference implementation lacks. The client's key is
 * a request-supplied string — the same `1` a tutorial uses — so storing under it verbatim
 * means one client's retry can replay *another client's* response, which turns a
 * convenience feature into an information disclosure. The stored key is a hash of
 * method, path, authenticated subject (or address), and the client key; the raw key is
 * never written anywhere.
 *
 * @remarks Two modes, and the difference is what may be stored. `replay` caches the response
 * body and answers retries with it — allowed only on routes whose response carries no tokens.
 * `dedup` records that the request ran and refuses the retry with a conflict, keeping
 * credentials out of Redis entirely while still protecting a refresh rotation from being
 * executed twice.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  IDEMPOTENCY_CONFIG,
  IN_FLIGHT_RETRY_AFTER_SEC,
  type IdempotencyConfig,
} from './idempotency.config';
import {
  IDEMPOTENCY_STORAGE,
  type IdempotencyCachedResponse,
  type IdempotencyRecord,
  type IdempotencyStorage,
} from './idempotency.storage';

/**
 * `replay` — cache and replay the response body.
 * `dedup` — only collapse concurrent duplicates and remember completion; never store a body.
 */
export type IdempotencyMode = 'replay' | 'dedup';

/** Per-route options carried by the `@Idempotent()` decorator. */
export interface IdempotencyOptions {
  /**
   * Defaults to `dedup`: the mode that cannot store a response is the safe default, and a
   * route that wants replay has to say so where its handler can be reviewed.
   */
  readonly mode?: IdempotencyMode;
}

export type IdempotencyBegin =
  /** Nobody holds the key: run the handler, then call `complete` or `release`. */
  | { kind: 'proceed'; ownerId: string }
  /** A completed `replay` record: answer with this body instead of running the handler. */
  | { kind: 'replay'; response: IdempotencyCachedResponse }
  /** A request with this key is running right now. */
  | { kind: 'in_flight'; retryAfterSec: number }
  /** The key belongs to a request that already completed. */
  | { kind: 'already_processed' }
  /** Protection is off (disabled, no Redis, or Redis did not answer): run the handler. */
  | { kind: 'unavailable' };

export interface ScopedKeyInput {
  method: string;
  path: string;
  principalId?: string | undefined;
  ip?: string | undefined;
  clientKey: string;
}

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @Inject(IDEMPOTENCY_CONFIG) private readonly config: IdempotencyConfig,
    @Inject(IDEMPOTENCY_STORAGE)
    private readonly storage: IdempotencyStorage,
  ) {}

  /** False when the whole module is a no-op — the one check a caller needs before doing work. */
  get enabled(): boolean {
    return this.config.enabled && this.storage.available;
  }

  /**
   * Reads the client's key, or reports that this request has none.
   *
   * @remarks No auto-generated keys, deliberately. A key the client did not choose cannot
   * deduplicate the retries it actually sends, so generating one would add Redis writes to
   * every request while protecting none of them.
   */
  clientKeyOf(
    headers: Record<string, string | string[] | undefined>,
  ): string | undefined {
    const name = this.config.keyHeader.toLowerCase();
    const value = headers[name];
    const key =
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value[0]
          : undefined;

    if (key === undefined || key.length === 0) return undefined;
    if (key.length > this.config.maxKeyLength) {
      this.logger.warn(
        `idempotency key of ${key.length} chars exceeds the ${this.config.maxKeyLength} limit; the request runs unprotected`,
      );
      return undefined;
    }
    return key;
  }

  /**
   * Hashes the request's identity plus the client key into the value stored in Redis.
   *
   * @remarks Only the hash is stored, so neither the client key nor the caller's id is
   * readable from a Redis dump — and two callers using the same key get two records, which
   * is the property the verbatim-key design was missing.
   */
  scopedKey(input: ScopedKeyInput): string {
    const method = input.method.toUpperCase();
    const subject = input.principalId
      ? `u:${input.principalId}`
      : `ip:${input.ip ?? 'anon'}`;
    return createHash('sha256')
      .update(`${method} ${input.path} ${subject} ${input.clientKey}`)
      .digest('hex');
  }

  /**
   * Takes the claim, or reports what already stands under this key.
   *
   * @remarks One Redis round trip: the atomic `SET NX` inside `claim` is the race-free
   * "am I first", and the record it finds when it loses is the whole answer — a cached
   * response, a marker, or a holder still at work.
   */
  async begin(key: string): Promise<IdempotencyBegin> {
    if (!this.enabled) return { kind: 'unavailable' };

    const ownerId = randomUUID();
    const claim = await this.storage.claim(
      key,
      this.processingRecord(ownerId),
      this.config.lockTimeoutMs,
    );

    if (claim.status === 'acquired') {
      return { kind: 'proceed', ownerId };
    }
    if (claim.status === 'unavailable') return { kind: 'unavailable' };

    const { record } = claim;
    if (record.state === 'processing') {
      return { kind: 'in_flight', retryAfterSec: IN_FLIGHT_RETRY_AFTER_SEC };
    }
    if (record.state === 'completed' && record.response) {
      return { kind: 'replay', response: record.response };
    }
    // `processed` markers, and `completed` records whose body is gone, mean the same thing
    // to a retry: it already happened, and running it again is the harm.
    return { kind: 'already_processed' };
  }

  /**
   * Records the outcome under this requester's claim.
   *
   * @remarks The TTL differs by mode: a replayed body is worth keeping for minutes, a marker
   * for a day, because the marker is three fields and the question it answers ("did this
   * already run?") is asked by a client that retries long after the response is forgotten.
   */
  async complete(
    key: string,
    ownerId: string,
    mode: IdempotencyMode,
    response?: IdempotencyCachedResponse,
  ): Promise<void> {
    if (!this.enabled) return;

    if (mode === 'replay' && response === undefined) {
      // A replay record with no body would answer future retries with a refusal while
      // pretending the body exists. Release instead: the retry re-runs the handler, which
      // is what an uncached route does anyway.
      this.logger.warn(`replay completion for ${key} arrived without a body; releasing`);
      await this.release(key, ownerId);
      return;
    }

    const ttlMs =
      (mode === 'replay' ? this.config.ttlSec : this.config.markerTtlSec) * 1_000;
    const record: IdempotencyRecord = {
      state: mode === 'replay' ? 'completed' : 'processed',
      ownerId,
      response: mode === 'replay' ? response : undefined,
      recordedAt: new Date().toISOString(),
    };

    const written = await this.storage.complete(key, ownerId, record, ttlMs);
    if (!written) {
      // The claim expired mid-request and somebody else owns the key now. The duplicate
      // they may be running is the cost of the lock timeout being shorter than this
      // handler; it is logged rather than corrected, because a late write would be worse.
      this.logger.warn(`completion for ${key} was not written: the claim is no longer ours`);
    }
  }

  /** Drops the claim so a retry can run the handler again. Owner-checked inside Redis. */
  async release(key: string, ownerId: string): Promise<void> {
    if (!this.enabled) return;
    await this.storage.release(key, ownerId);
  }

  private processingRecord(ownerId: string): IdempotencyRecord {
    return {
      state: 'processing',
      ownerId,
      recordedAt: new Date().toISOString(),
    };
  }
}
