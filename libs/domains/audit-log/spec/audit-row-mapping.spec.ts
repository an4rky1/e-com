/**
 * @fileoverview The boundary where stored rows become domain records.
 *
 * @remarks There is a bug here that only a live database could find, and it is worth naming so
 * nobody "simplifies" the reader back: `new Date(String(value))` renders as
 * `"Mon Oct 19 2026 11:39:22 GMT+0300 (Eastern European Summer Time)"` — which carries no
 * milliseconds. The hash was taken over `toISOString()` of the full-precision value, so a
 * reader that truncates on the way back makes *every* record fail verification, permanently,
 * with no error anywhere.
 *
 * @remarks The unit tests in this service build records from `Date` objects and round-trip them
 * identically, so an in-memory fake reproduces this bug not at all. The regression lives here
 * instead, against the projection itself.
 */
import { toChainedRecord } from '../src/infrastructure/persistence/prisma-audit.repository';
import { GENESIS_HASH, computeChainHash, verifyChain } from '../src/domain/audit-chain';

const OCCURRED_AT = new Date('2026-10-19T09:00:00.123Z');
const RECEIVED_AT = new Date('2026-10-19T09:00:01.456Z');

/** A row exactly as the Prisma driver hands one back: real `Date` objects, not strings. */
function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    partition_key: 'user.aaaaaaaa-0000-4000-8000-000000000001',
    sequence: 1,
    occurred_at: OCCURRED_AT,
    received_at: RECEIVED_AT,
    actor_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    actor_type: 'user',
    action: 'permission.denied',
    resource_type: 'permission',
    resource_id: 'reports.export',
    result: 'denied',
    ip_address: null,
    user_agent: null,
    payload: { permission: 'reports.export', password: '[REDACTED]' },
    trace_id: 'trace-0001',
    previous_hash: GENESIS_HASH,
    hash: '',
    ...overrides,
  };
}

describe('reading a stored row back', () => {
  it('keeps sub-second precision on both timestamps', () => {
    const record = toChainedRecord(storedRow());

    // Not `getTime() % 1000 === 0`: the point is that the milliseconds are still *there*, not
    // that they happen to be non-zero.
    expect(record.occurredAt.getTime()).toBe(OCCURRED_AT.getTime());
    expect(record.receivedAt.getTime()).toBe(RECEIVED_AT.getTime());
    expect(record.occurredAt.toISOString()).toBe('2026-10-19T09:00:00.123Z');
  });

  it('recomputes to the hash that was stored', () => {
    const row = storedRow();
    const record = toChainedRecord(row);
    const hash = computeChainHash(record, GENESIS_HASH);

    const verified = toChainedRecord({ ...row, hash });
    const report = verifyChain(String(row['partition_key']), [verified], { expectedHead: hash });

    expect(report).toEqual({
      partitionKey: 'user.aaaaaaaa-0000-4000-8000-000000000001',
      ok: true,
      checked: 1,
      brokenAt: null,
      reason: null,
      truncatedAt: null,
    });
  });

  it('carries the two hash columns through unchanged', () => {
    const record = toChainedRecord(storedRow({ previous_hash: 'a'.repeat(64), hash: 'b'.repeat(64) }));

    expect(record.previousHash).toBe('a'.repeat(64));
    expect(record.hash).toBe('b'.repeat(64));
  });

  it('reads nulls as null rather than the string "null"', () => {
    const record = toChainedRecord(storedRow());

    expect(record.ipAddress).toBeNull();
    expect(record.userAgent).toBeNull();
    // `"null"` here would hash differently from `null` and read as a literal address in the
    // operator UI, which is worse.
    expect(record.ipAddress).not.toBe('null');
  });

  it('accepts a driver that hands timestamps back as strings', () => {
    const record = toChainedRecord(
      storedRow({
        occurred_at: OCCURRED_AT.toISOString(),
        received_at: RECEIVED_AT.toISOString(),
      }),
    );

    expect(record.occurredAt.getTime()).toBe(OCCURRED_AT.getTime());
  });
});