/**
 * @fileoverview The Redis storage's contract as its caller sees it: what each script reply
 * becomes, and how every failure becomes `unavailable` — the answer that lets the edge
 * continue rather than the one that takes it down.
 *
 * @remarks The Lua itself is exercised against a real Redis by the E2E suite; here the fake
 * replies with the shapes Redis produces, which is enough to pin the parsing, the key
 * prefixing, and the fail-open rules that a flaky cache must not be able to bypass.
 */
import { resolveIdempotencyConfig } from '../src/idempotency.config';
import {
  NullIdempotencyStorage,
  RedisIdempotencyStorage,
  type EvalCapableRedis,
  type IdempotencyRecord,
} from '../src/idempotency.storage';

class FakeRedis implements EvalCapableRedis {
  lastScript = '';
  lastArgs: Array<string | number> = [];
  reply: unknown = null;
  throws: Error | null = null;

  async eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    this.lastScript = script;
    this.lastArgs = [numKeys, ...args];
    if (this.throws) throw this.throws;
    return typeof this.reply === 'function'
      ? (this.reply as (...a: unknown[]) => unknown)(...args)
      : this.reply;
  }
}

const record: IdempotencyRecord = {
  state: 'processing',
  ownerId: 'owner-1',
  recordedAt: '2026-10-26T00:00:00.000Z',
};

const build = () => {
  const redis = new FakeRedis();
  const storage = new RedisIdempotencyStorage(
    redis,
    resolveIdempotencyConfig({}),
  );
  return { redis, storage };
};

describe('RedisIdempotencyStorage', () => {
  it('prefixes the caller key so records land in one namespace', async () => {
    const { redis, storage } = build();
    redis.reply = [1];

    await storage.claim('abc123', record, 30_000);

    // [0] is the number of keys; the script reads the record, the key and the TTL after it.
    expect(redis.lastArgs[1]).toBe('idem:abc123');
    expect(redis.lastArgs[3]).toBe(30_000);
    expect(redis.lastScript).toContain('cjson.decode');
    expect(redis.lastScript).toContain("'NX'");
  });

  it('maps an acquired claim', async () => {
    const storage = new RedisIdempotencyStorage(
      { eval: async () => [1] },
      resolveIdempotencyConfig({}),
    );
    expect(await storage.claim('k', record, 1000)).toEqual({
      status: 'acquired',
    });
  });

  it('maps a held claim, decoding the cached response when present', async () => {
    const withBody = new RedisIdempotencyStorage(
      {
        eval: async () => [
          0,
          'completed',
          'owner-9',
          '{"status":201,"body":{"id":"u1"}}',
          '2026-10-26T01:00:00.000Z',
        ],
      },
      resolveIdempotencyConfig({}),
    );

    expect(await withBody.claim('k', record, 1000)).toEqual({
      status: 'held',
      record: {
        state: 'completed',
        ownerId: 'owner-9',
        response: { status: 201, body: { id: 'u1' } },
        recordedAt: '2026-10-26T01:00:00.000Z',
      },
    });
  });

  it('treats an expired or unreadable record as unavailable, not as a refusal', async () => {
    const cases: unknown[] = [
      [-1],
      [-2],
      'nonsense',
      [0, 'not-a-state', 'owner', '', ''],
      [0, 'completed', 'owner', '{oops', ''],
    ];

    for (const reply of cases) {
      const storage = new RedisIdempotencyStorage(
        { eval: async () => reply },
        resolveIdempotencyConfig({}),
      );
      expect(await storage.claim('k', record, 1000)).toEqual({
        status: 'unavailable',
      });
    }
  });

  it('fails open when Redis itself throws', async () => {
    const redis = new FakeRedis();
    redis.throws = new Error('connection lost');
    const storage = new RedisIdempotencyStorage(
      redis,
      resolveIdempotencyConfig({}),
    );

    expect(await storage.claim('k', record, 1000)).toEqual({
      status: 'unavailable',
    });
    expect(await storage.complete('k', 'owner-1', record, 1000)).toBe(false);
    expect(await storage.release('k', 'owner-1')).toBe(false);
  });

  it('passes the owner id to the release script and reads its verdict', async () => {
    const { redis, storage } = build();
    redis.reply = 1;
    expect(await storage.release('abc', 'owner-1')).toBe(true);
    expect(redis.lastArgs).toEqual([1, 'idem:abc', 'owner-1']);

    redis.reply = 0;
    expect(await storage.release('abc', 'owner-1')).toBe(false);
  });

  it('writes completions with the mode-appropriate TTL', async () => {
    const { redis, storage } = build();
    redis.reply = 1;

    const completed: IdempotencyRecord = {
      state: 'processed',
      ownerId: 'owner-1',
      recordedAt: '2026-10-26T00:00:01.000Z',
    };
    expect(await storage.complete('abc', 'owner-1', completed, 86_400_000)).toBe(true);
    expect(redis.lastArgs).toEqual([1, 'idem:abc', expect.any(String), 86_400_000]);
    expect(String(redis.lastArgs[2])).toContain('processed');
  });
});

describe('NullIdempotencyStorage', () => {
  it('is unavailable by construction, so every caller passes through', async () => {
    const storage = new NullIdempotencyStorage();
    expect(storage.available).toBe(false);
    expect(await storage.claim('k', record, 1000)).toEqual({
      status: 'unavailable',
    });
    expect(await storage.complete('k', 'o', record, 1000)).toBe(false);
    expect(await storage.release('k', 'o')).toBe(false);
  });
});
