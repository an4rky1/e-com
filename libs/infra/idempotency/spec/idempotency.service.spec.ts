/**
 * @fileoverview The service's contract against an in-memory store: claim, replay, refuse,
 * release — and never a stored body for a route that did not ask for one.
 *
 * @remarks The fake store implements ownership exactly as the Redis scripts do (complete and
 * release refuse when the owner id does not match), so these tests are about the decisions
 * the service makes on top of atomicity, not about Redis itself — which the E2E suite
 * exercises against the real thing.
 */
import { resolveIdempotencyConfig } from '../src/idempotency.config';
import { IdempotencyService } from '../src/idempotency.service';
import {
  NullIdempotencyStorage,
  type ClaimOutcome,
  type IdempotencyRecord,
  type IdempotencyStorage,
} from '../src/idempotency.storage';

class FakeStorage implements IdempotencyStorage {
  readonly available = true;
  readonly records = new Map<string, IdempotencyRecord>();

  async claim(
    key: string,
    record: IdempotencyRecord,
  ): Promise<ClaimOutcome> {
    const existing = this.records.get(key);
    if (existing) return { status: 'held', record: existing };
    this.records.set(key, record);
    return { status: 'acquired' };
  }

  async complete(
    key: string,
    ownerId: string,
    record: IdempotencyRecord,
  ): Promise<boolean> {
    const existing = this.records.get(key);
    if (!existing || existing.ownerId !== ownerId) return false;
    this.records.set(key, record);
    return true;
  }

  async release(key: string, ownerId: string): Promise<boolean> {
    const existing = this.records.get(key);
    if (!existing || existing.ownerId !== ownerId) return false;
    this.records.delete(key);
    return true;
  }
}

const build = (env: Record<string, string | undefined> = {}) => {
  const storage = new FakeStorage();
  const service = new IdempotencyService(
    resolveIdempotencyConfig(env as NodeJS.ProcessEnv),
    storage,
  );
  return { service, storage };
};

describe('IdempotencyService', () => {
  it('proclaims the module off when config says so', async () => {
    const { service } = build({ IDEMPOTENCY_ENABLED: 'false' });
    expect(service.enabled).toBe(false);
    expect(await service.begin('k')).toEqual({ kind: 'unavailable' });
  });

  it('passes everything through when storage is the null one', async () => {
    const service = new IdempotencyService(
      resolveIdempotencyConfig({}),
      new NullIdempotencyStorage(),
    );
    expect(service.enabled).toBe(false);
    expect(await service.begin('k')).toEqual({ kind: 'unavailable' });
  });

  it('answers first claim with proceed, second with in-flight', async () => {
    const { service } = build();

    const first = await service.begin('key');
    expect(first.kind).toBe('proceed');

    const second = await service.begin('key');
    expect(second).toMatchObject({
      kind: 'in_flight',
      retryAfterSec: expect.any(Number),
    });
    expect((second as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
  });

  it('replays a completed response body, byte for byte', async () => {
    const { service } = build();
    const body = { id: 'u1', email: 'a@b.c' };

    const first = await service.begin('key');
    expect(first.kind).toBe('proceed');
    await service.complete(
      'key',
      (first as { ownerId: string }).ownerId,
      'replay',
      { status: 201, body },
    );

    const retry = await service.begin('key');
    expect(retry).toEqual({
      kind: 'replay',
      response: { status: 201, body },
    });
  });

  it('refuses a retry of a deduped request without ever storing a body', async () => {
    const { service, storage } = build();

    const first = await service.begin('key');
    await service.complete(
      'key',
      (first as { ownerId: string }).ownerId,
      'dedup',
    );

    expect(await service.begin('key')).toEqual({ kind: 'already_processed' });
    expect(storage.records.get('key')?.response).toBeUndefined();
    expect(storage.records.get('key')?.state).toBe('processed');
  });

  it('releases on an error path so the retry runs the handler again', async () => {
    const { service, storage } = build();

    const first = await service.begin('key');
    expect(first.kind).toBe('proceed');
    await service.release(
      'key',
      (first as { ownerId: string }).ownerId,
    );

    expect(storage.records.has('key')).toBe(false);
    expect((await service.begin('key')).kind).toBe('proceed');
  });

  it('refuses to complete a claim it no longer owns', async () => {
    const { service, storage } = build();

    await service.begin('key');
    // Somebody else's claim now stands under the key — a lock that expired mid-request.
    storage.records.set('key', {
      state: 'processing',
      ownerId: 'someone-else',
      recordedAt: new Date().toISOString(),
    });

    await service.complete('key', 'old-owner', 'dedup');
    expect(storage.records.get('key')?.ownerId).toBe('someone-else');
  });

  it('releases instead of completing a replay that lost its body', async () => {
    const { service, storage } = build();

    const first = await service.begin('key');
    await service.complete(
      'key',
      (first as { ownerId: string }).ownerId,
      'replay',
    );

    expect(storage.records.has('key')).toBe(false);
    expect((await service.begin('key')).kind).toBe('proceed');
  });

  describe('clientKeyOf', () => {
    it('reads the configured header from Node\'s lowercased wire casing', () => {
      const { service } = build();
      expect(service.clientKeyOf({ 'x-idempotency-key': 'abc' })).toBe('abc');
      expect(
        service.clientKeyOf({ 'x-idempotency-key': ['first', 'second'] }),
      ).toBe('first');
      expect(service.clientKeyOf({})).toBeUndefined();
      expect(service.clientKeyOf({ 'x-idempotency-key': '' })).toBeUndefined();
    });

    it('matches a mixed-case configured name against the wire casing', () => {
      const { service } = build({
        IDEMPOTENCY_KEY_HEADER: 'X-Request-Key',
      });
      expect(service.clientKeyOf({ 'x-request-key': 'xyz' })).toBe('xyz');
      expect(service.clientKeyOf({ 'x-idempotency-key': 'abc' })).toBeUndefined();
    });

    it('declines a key too long to hash and log safely', () => {
      const { service } = build({ IDEMPOTENCY_MAX_KEY_LENGTH: '16' });
      expect(service.clientKeyOf({ 'x-idempotency-key': 'x'.repeat(16) })).toBe('x'.repeat(16));
      expect(
        service.clientKeyOf({ 'x-idempotency-key': 'x'.repeat(17) }),
      ).toBeUndefined();
    });
  });

  describe('scopedKey', () => {
    const base = {
      method: 'POST',
      path: '/v1/auth/login',
      principalId: undefined,
      ip: '10.0.0.1',
      clientKey: '1',
    };

    it('is stable for the same request, so a retry lands on the same record', () => {
      const { service } = build();
      expect(service.scopedKey(base)).toBe(service.scopedKey({ ...base }));
      expect(service.scopedKey(base)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('separates two callers who picked the same key', () => {
      const { service } = build();
      const asUser = service.scopedKey({ ...base, principalId: 'user-a' });
      const asOther = service.scopedKey({ ...base, principalId: 'user-b' });
      const asAnon = service.scopedKey({ ...base, ip: '10.0.0.2' });

      expect(new Set([asUser, asOther, asAnon]).size).toBe(3);
    });

    it('separates routes, methods and keys even for one caller', () => {
      const { service } = build();
      const keys = [
        service.scopedKey(base),
        service.scopedKey({ ...base, path: '/v1/auth/refresh' }),
        service.scopedKey({ ...base, method: 'PUT' }),
        service.scopedKey({ ...base, clientKey: '2' }),
      ];
      expect(new Set(keys).size).toBe(4);
    });

    it('never stores the client key or the subject in the clear', () => {
      const { service } = build();
      const scoped = service.scopedKey({
        ...base,
        clientKey: 'client-key-raw',
        principalId: 'user-secret-id',
      });
      expect(scoped).toMatch(/^[0-9a-f]{64}$/);
      expect(scoped).not.toContain('user-secret-id');
      expect(scoped).not.toContain('client-key-raw');
    });
  });
});
