/**
 * @fileoverview The claim mechanics: one Redis key per logical request, three states, and
 * ownership checked inside Lua rather than in JavaScript.
 *
 * @remarks The read-modify-write pattern this replaces is a race by construction: two
 * requests both read "no record", both conclude they are first, and both run. `SET ... NX`
 * makes "first" a single atomic decision, and the completion and release paths re-check the
 * owner id inside the script so a request whose claim expired mid-flight cannot delete or
 * overwrite the record a later request now owns.
 *
 * @remarks Every method answers `unavailable` rather than throwing when Redis is missing or
 * misbehaving. The consumer of that answer proceeds without protection, which is the same
 * trade the rate limiter makes: a duplicate is a bug, an edge that refuses every POST
 * because a cache is unreachable is an outage.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { IdempotencyConfig } from './idempotency.config';

export type IdempotencyState = 'processing' | 'completed' | 'processed';

/** A replayable response — only ever written for routes opted into `replay` mode. */
export interface IdempotencyCachedResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyRecord {
  state: IdempotencyState;
  /** The requester's id, or `ip:<address>` when the request is unauthenticated. */
  ownerId: string;
  response?: IdempotencyCachedResponse;
  /** ISO timestamp of the last write. Debugging aid, not a decision input. */
  recordedAt: string;
}

export type ClaimOutcome =
  | { status: 'acquired' }
  | { status: 'held'; record: IdempotencyRecord }
  /** No Redis, or Redis did not answer: the caller proceeds without protection. */
  | { status: 'unavailable' };

export interface IdempotencyStorage {
  readonly available: boolean;
  claim(
    key: string,
    record: IdempotencyRecord,
    ttlMs: number,
  ): Promise<ClaimOutcome>;
  complete(
    key: string,
    ownerId: string,
    record: IdempotencyRecord,
    ttlMs: number,
  ): Promise<boolean>;
  release(key: string, ownerId: string): Promise<boolean>;
}

/**
 * The one Redis capability the storage needs.
 *
 * @remarks Deliberately not `Pick<Redis, 'eval'>`: typing against ioredis would force every
 * test double to satisfy its overloads, and the double would then be a restatement of the
 * client library rather than of this module's contract.
 */
export interface EvalCapableRedis {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

/**
 * Claim the key, or report who holds it.
 *
 * @remarks The in-script retry covers the window between `SET NX` failing and `GET` — the
 * record can expire in that gap, and without the second `SET` a request that arrives during
 * a legitimate expiry would be answered "held" about a record nobody owns.
 */
const CLAIM_SCRIPT = `
if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', tonumber(ARGV[2])) then
  return { 1 }
end
local value = redis.call('get', KEYS[1])
if not value then
  if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', tonumber(ARGV[2])) then
    return { 1 }
  end
  value = redis.call('get', KEYS[1])
end
if not value then return { -1 } end
local ok, parsed = pcall(cjson.decode, value)
if not ok or type(parsed) ~= 'table' or type(parsed.state) ~= 'string' then
  return { -2 }
end
local response = ''
if parsed.response then response = cjson.encode(parsed.response) end
return { 0, parsed.state, parsed.ownerId or '', response, parsed.recordedAt or '' }
`;

/** Write the outcome only if this requester still owns the claim. */
const COMPLETE_SCRIPT = `
local value = redis.call('get', KEYS[1])
if not value then return 0 end
local ok, parsed = pcall(cjson.decode, value)
if not ok or type(parsed) ~= 'table' or parsed.ownerId ~= ARGV[1] then return 0 end
redis.call('set', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return 1
`;

/** Drop the claim only if this requester still owns it — otherwise delete a live lock. */
const RELEASE_SCRIPT = `
local value = redis.call('get', KEYS[1])
if not value then return 0 end
local ok, parsed = pcall(cjson.decode, value)
if not ok or type(parsed) ~= 'table' or parsed.ownerId ~= ARGV[1] then return 0 end
return redis.call('del', KEYS[1])
`;

const STATES: ReadonlySet<string> = new Set([
  'processing',
  'completed',
  'processed',
]);

@Injectable()
export class RedisIdempotencyStorage implements IdempotencyStorage {
  private readonly logger = new Logger(RedisIdempotencyStorage.name);

  constructor(
    private readonly redis: EvalCapableRedis,
    private readonly config: IdempotencyConfig,
  ) {}

  get available(): boolean {
    return true;
  }

  async claim(
    key: string,
    record: IdempotencyRecord,
    ttlMs: number,
  ): Promise<ClaimOutcome> {
    try {
      const raw = await this.redis.eval(
        CLAIM_SCRIPT,
        1,
        this.redisKey(key),
        JSON.stringify(record),
        ttlMs,
      );
      return this.parseClaim(raw);
    } catch (error) {
      this.logger.warn(`claim for ${key} failed: ${describe(error)}`);
      return { status: 'unavailable' };
    }
  }

  async complete(
    key: string,
    ownerId: string,
    record: IdempotencyRecord,
    ttlMs: number,
  ): Promise<boolean> {
    try {
      const raw = await this.redis.eval(
        COMPLETE_SCRIPT,
        1,
        this.redisKey(key),
        JSON.stringify(record),
        ttlMs,
      );
      return Number(raw) === 1;
    } catch (error) {
      this.logger.warn(`completing ${key} failed: ${describe(error)}`);
      return false;
    }
  }

  async release(key: string, ownerId: string): Promise<boolean> {
    try {
      const raw = await this.redis.eval(
        RELEASE_SCRIPT,
        1,
        this.redisKey(key),
        ownerId,
      );
      return Number(raw) === 1;
    } catch (error) {
      this.logger.warn(`releasing ${key} failed: ${describe(error)}`);
      return false;
    }
  }

  private parseClaim(raw: unknown): ClaimOutcome {
    if (!Array.isArray(raw)) {
      this.logger.warn(`claim returned an unexpected shape: ${typeof raw}`);
      return { status: 'unavailable' };
    }

    const [code, state, ownerId, responseJson, recordedAt] = raw as Array<
      string | number
    >;

    if (Number(code) === 1) return { status: 'acquired' };
    if (Number(code) !== 0) {
      // -1: the record expired between commands. -2: unreadable content. Both fail open.
      return { status: 'unavailable' };
    }
    if (typeof state !== 'string' || !STATES.has(state)) {
      this.logger.warn(`claim returned an unknown state: ${String(state)}`);
      return { status: 'unavailable' };
    }

    let response: IdempotencyCachedResponse | undefined;
    if (typeof responseJson === 'string' && responseJson.length > 0) {
      try {
        response = JSON.parse(responseJson) as IdempotencyCachedResponse;
      } catch {
        this.logger.warn('claim returned an unparseable cached response');
        return { status: 'unavailable' };
      }
    }

    return {
      status: 'held',
      record: {
        state: state as IdempotencyState,
        ownerId: String(ownerId),
        response,
        recordedAt: String(recordedAt ?? ''),
      },
    };
  }

  private redisKey(key: string): string {
    return `${this.config.prefix}:${key}`;
  }
}

/**
 * The storage a deployment without Redis gets.
 *
 * @remarks `available: false` is the whole implementation: every caller checks it before
 * doing work and passes the request through. The methods still exist so a caller that
 * forgets the check fails open instead of throwing into a request.
 */
export class NullIdempotencyStorage implements IdempotencyStorage {
  readonly available = false;

  // The interface's parameters, accepted and ignored. Declared rather than omitted so the
  // null storage can be called exactly like the Redis one — a caller must not have to know
  // which storage it was handed, and a spec that passes arguments should type-check either way.
  async claim(
    _key: string,
    _record: IdempotencyRecord,
    _ttlMs: number,
  ): Promise<ClaimOutcome> {
    return { status: 'unavailable' };
  }

  async complete(
    _key: string,
    _ownerId: string,
    _record: IdempotencyRecord,
    _ttlMs: number,
  ): Promise<boolean> {
    return false;
  }

  async release(_key: string, _ownerId: string): Promise<boolean> {
    return false;
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Where the module provides the storage — a `Symbol` for the usual reason: a string key is a collision waiting on a second library that also chose `'IDEMPOTENCY_STORAGE'`. */
export const IDEMPOTENCY_STORAGE = Symbol('IDEMPOTENCY_STORAGE');
