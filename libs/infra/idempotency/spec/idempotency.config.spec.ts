/**
 * @fileoverview `IDEMPOTENCY_*` parsing: safe defaults, bounded knobs, and a refusal at boot
 * rather than a surprise at request time.
 *
 * @remarks The contract an operator sees: an unset namespace still protects the routes
 * (protection that requires configuration to switch on never gets switched on), replay and
 * marker lifetimes are separate because they answer different questions, and a nonsense
 * boolean fails the start instead of `Boolean('maybe')` becoming `false` — and with it,
 * silently switching deduplication off in production.
 */
import {
  Defaults,
  IN_FLIGHT_RETRY_AFTER_SEC,
  resolveIdempotencyConfig,
} from '../src/idempotency.config';

const resolve = (env: Record<string, string | undefined>) =>
  resolveIdempotencyConfig(env as NodeJS.ProcessEnv);

describe('IDEMPOTENCY config', () => {
  it('defaults to protection on, bodies off, markers for a day', () => {
    const config = resolve({});
    expect(config).toEqual({
      enabled: true,
      keyHeader: 'x-idempotency-key',
      prefix: 'idem',
      ttlSec: 300,
      markerTtlSec: 86_400,
      lockTimeoutMs: 30_000,
      maxKeyLength: 256,
      maxResponseSizeKb: 1_024,
    });
    expect(Defaults.MARKER_TTL_SEC).toBeGreaterThan(Defaults.TTL_SEC);
    expect(IN_FLIGHT_RETRY_AFTER_SEC).toBeGreaterThan(0);
  });

  it('reads overrides from its own namespace only', () => {
    const config = resolve({
      IDEMPOTENCY_TTL_SEC: '120',
      IDEMPOTENCY_MARKER_TTL_SEC: '600',
      IDEMPOTENCY_LOCK_TIMEOUT_MS: '5000',
      IDEMPOTENCY_KEY_HEADER: 'x-request-key',
      IDEMPOTENCY_PREFIX: 'idem2',
      IDEMPOTENCY_MAX_KEY_LENGTH: '64',
      IDEMPOTENCY_MAX_RESPONSE_SIZE_KB: '64',
      IDEMPOTENCY_ENABLED: 'false',
      // Another namespace's variable must not leak in through the prefix scan.
      IDEMPOTENCY_THING: 'ignored',
    });
    expect(config).toEqual({
      enabled: false,
      keyHeader: 'x-request-key',
      prefix: 'idem2',
      ttlSec: 120,
      markerTtlSec: 600,
      lockTimeoutMs: 5_000,
      maxKeyLength: 64,
      maxResponseSizeKb: 64,
    });
  });

  it('refuses a lock timeout that could expire under a live request', () => {
    expect(() => resolve({ IDEMPOTENCY_LOCK_TIMEOUT_MS: '10' })).toThrow(
      /IDEMPOTENCY_LOCK_TIMEOUT_MS/,
    );
  });

  it('refuses a replay TTL below what a client retry plausibly takes', () => {
    expect(() => resolve({ IDEMPOTENCY_TTL_SEC: '5' })).toThrow(
      /IDEMPOTENCY_TTL_SEC/,
    );
  });

  it('refuses a boolean that is neither, naming the value', () => {
    expect(() => resolve({ IDEMPOTENCY_ENABLED: 'sometimes' })).toThrow(
      /Expected a boolean/,
    );
  });
});
