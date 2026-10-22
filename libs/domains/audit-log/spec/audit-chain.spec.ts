/**
 * @fileoverview Tamper evidence: the only property this service really promises.
 *
 * @remarks Everything else here — the queries, the redaction, the consumer wiring — is
 * replaceable. This is not. If a record can be altered and the chain still verifies, then the
 * log is decoration: an operator reading it is reading something an attacker with a database
 * client chose, and nothing in the interface tells them otherwise.
 *
 * @remarks The five properties below are the whole claim, and each is asserted against the
 * *production* `computeChainHash`/`verifyChain` rather than a re-implementation. A test of a
 * copy proves the copy.
 */
import {
  ChainBreak,
  GENESIS_HASH,
  canonicalJson,
  computeChainHash,
  relinkFrom,
  verifyChain,
  type ChainLink,
  type ChainedRecord,
} from '../src/domain/audit-chain';

const BASE_TIME = Date.parse('2026-10-19T09:00:00.000Z');

/**
 * Builds a record with every field deterministic, so a failing assertion points at the chain
 * rather than at a random id.
 */
function link(overrides: Partial<ChainLink> = {}): ChainLink {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    partitionKey: 'user.aaaaaaaa-0000-4000-8000-000000000001',
    sequence: 1,
    occurredAt: new Date(BASE_TIME),
    receivedAt: new Date(BASE_TIME + 12),
    actorId: 'aaaaaaaa-0000-4000-8000-000000000001',
    actorType: 'user',
    action: 'permission.denied',
    resourceType: 'permission',
    resourceId: 'reports.export',
    result: 'denied',
    ipAddress: '203.0.113.7',
    userAgent: 'curl/8.4.0',
    payload: { permission: 'reports.export', reason: 'insufficient role' },
    traceId: 'trace-0001',
    ...overrides,
  };
}

/**
 * Links a partition end to end the way the repository does: each record commits to the one
 * before it, starting from genesis.
 */
function buildChain(records: readonly ChainLink[]): ChainedRecord[] {
  let carry = GENESIS_HASH;

  return records.map((record) => {
    const previousHash = carry;
    carry = computeChainHash(record, previousHash);
    return { ...record, previousHash, hash: carry };
  });
}

const threeRecords = [
  link({ sequence: 1, id: '11111111-1111-4111-8111-111111111111' }),
  link({
    sequence: 2,
    id: '22222222-2222-4222-8222-222222222222',
    action: 'session.revoked',
    occurredAt: new Date(BASE_TIME + 60_000),
  }),
  link({
    sequence: 3,
    id: '33333333-3333-4333-8333-333333333333',
    action: 'user.locked',
    occurredAt: new Date(BASE_TIME + 120_000),
  }),
];

describe('a record hash', () => {
  it('is deterministic: the same record hashes the same, every time', () => {
    const first = computeChainHash(link(), GENESIS_HASH);
    const second = computeChainHash(link(), GENESIS_HASH);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the key order of the payload', () => {
    // `JSON.stringify` preserves insertion order, so an uncanonicalised hash would make two
    // byte-identical records hash differently depending on how the producer built the object.
    const forwards = link({ payload: { a: 1, b: 2, c: 3 } });
    const backwards = link({ payload: { c: 3, b: 2, a: 1 } });

    expect(computeChainHash(forwards, GENESIS_HASH)).toBe(
      computeChainHash(backwards, GENESIS_HASH),
    );
  });

  it('preserves array order, because a list is a sequence', () => {
    const ascending = link({ payload: { attempts: [1, 2, 3] } });
    const descending = link({ payload: { attempts: [3, 2, 1] } });

    expect(computeChainHash(ascending, GENESIS_HASH)).not.toBe(
      computeChainHash(descending, GENESIS_HASH),
    );
  });

  it('depends on previousHash, which is what chains the partition together', () => {
    const record = link();

    expect(computeChainHash(record, GENESIS_HASH)).not.toBe(
      computeChainHash(record, 'f'.repeat(64)),
    );
  });

  it('changes when any single column changes', () => {
    const original = computeChainHash(link(), GENESIS_HASH);

    const alterations: ReadonlyArray<readonly [string, ChainLink]> = [
      ['actorId', link({ actorId: 'someone-else' })],
      ['action', link({ action: 'role.granted' })],
      ['result', link({ result: 'success' })],
      ['ipAddress', link({ ipAddress: '198.51.100.1' })],
      ['occurredAt', link({ occurredAt: new Date(BASE_TIME + 1) })],
      ['sequence', link({ sequence: 9 })],
      ['payload', link({ payload: { permission: 'reports.import' } })],
    ];

    for (const [column, altered] of alterations) {
      expect({ column, hash: computeChainHash(altered, GENESIS_HASH) }).toEqual({
        column,
        hash: expect.not.stringMatching(new RegExp(`^${original}$`)),
      });
    }
  });
});

describe('inserting into the middle of a partition', () => {
  it('changes every later hash in that partition', () => {
    const original = buildChain(threeRecords);
    const originalHashes = original.map((record) => record.hash);

    const inserted: ChainedRecord = {
      ...link({
        sequence: 2,
        id: '99999999-9999-4999-8999-999999999999',
        action: 'session.token_reuse_detected',
        occurredAt: new Date(BASE_TIME + 30_000),
      }),
      // A record that has not been written has no hash. The placeholders say "unlinked"; the
      // re-link below replaces both columns with what a writer would actually compute.
      previousHash: GENESIS_HASH,
      hash: GENESIS_HASH,
    };

    // Everything from the insertion point onward is re-linked, exactly as a writer would.
    const rewritten = relinkFrom(
      [original[0], inserted, original[1], original[2]].map((record, index) => ({
        ...record,
        sequence: index + 1,
      })),
      2,
      original[0].hash,
    );

    // The record before the insertion is untouched; that is the point of a chain, not a flaw.
    expect(rewritten[0].hash).toBe(originalHashes[0]);

    // Every later hash moved. This is the whole tamper-evidence argument: an insertion cannot
    // be made quietly, because it invalidates the head and every record that follows.
    expect(rewritten[1].hash).not.toBe(originalHashes[1]);
    expect(rewritten[2].hash).not.toBe(originalHashes[2]);
    expect(rewritten[3].hash).not.toBe(originalHashes[2]);

    // And the rewritten chain is internally consistent again, so the break is detectable
    // against the *stored head* rather than against a stale copy.
    expect(verifyChain('user.a', rewritten).ok).toBe(true);
  });

  it('fails verification against a head that predates the insertion', () => {
    const original = buildChain(threeRecords);
    const inserted: ChainedRecord = {
      ...link({ id: '99999999-9999-4999-8999-999999999999' }),
      sequence: 2,
      previousHash: GENESIS_HASH,
      hash: GENESIS_HASH,
    };
    const withInsertion = relinkFrom(
      [original[0], inserted, { ...original[1], sequence: 3 }, { ...original[2], sequence: 4 }],
      2,
      original[0].hash,
    );

    // An attacker who rewrites the partition correctly but cannot also update
    // `audit_chain_heads` leaves exactly this shape.
    expect(
      verifyChain('user.a', withInsertion, { expectedHead: original[2].hash }).reason,
    ).toBe(ChainBreak.HEAD_MISMATCH);
  });
});

describe('verifying an untouched partition', () => {
  it('passes', () => {
    const chain = buildChain(threeRecords);

    expect(verifyChain('user.a', chain)).toEqual({
      partitionKey: 'user.a',
      ok: true,
      checked: 3,
      brokenAt: null,
      reason: null,
      truncatedAt: null,
    });
  });

  it('passes against the stored head', () => {
    const chain = buildChain(threeRecords);

    expect(verifyChain('user.a', chain, { expectedHead: chain[2].hash }).ok).toBe(true);
  });

  it('verifies an empty partition', () => {
    // An empty chain is a valid chain. There is nothing to have tampered with, and reporting
    // it as broken would page somebody about a partition that was never opened.
    expect(verifyChain('user.never-seen', [])).toEqual({
      partitionKey: 'user.never-seen',
      ok: true,
      checked: 0,
      brokenAt: null,
      reason: null,
      truncatedAt: null,
    });
  });
});

describe('verifying a tampered partition', () => {
  it('fails when a payload was altered after the fact', () => {
    const chain = buildChain(threeRecords);

    // The attack this whole service exists for: change what the record says, leave the row id,
    // the timestamps and the hash column untouched.
    const [first, second, third] = chain;
    const tampered: ChainedRecord = {
      ...second,
      payload: { permission: 'reports.export', reason: 'granted by policy' },
    };

    const report = verifyChain('user.a', [first, tampered, third]);

    expect(report.ok).toBe(false);
    expect(report.reason).toBe(ChainBreak.HASH_MISMATCH);
    // The break is reported at the altered record itself, so an operator is pointed at the
    // row to look at rather than at a partition-wide "something is wrong".
    expect(report.brokenAt).toBe(2);
    // The first record still verified — the chain is intact *up to* the tampering.
    expect(report.checked).toBe(1);
  });

  it('fails when an actor is altered', () => {
    const chain = buildChain(threeRecords);
    const tampered = chain.map((record) =>
      record.sequence === 3 ? { ...record, actorId: 'someone-else' } : record,
    );

    expect(verifyChain('user.a', tampered).reason).toBe(ChainBreak.HASH_MISMATCH);
  });

  it('fails when a record is removed from the middle', () => {
    const chain = buildChain(threeRecords);
    const [first, , third] = chain;

    // Sequence 2 is gone and the rest was renumbered, so nothing inside the chain looks
    // wrong — only the head notices.
    const report = verifyChain('user.a', [first, { ...third, sequence: 2 }]);

    expect(report.ok).toBe(false);
    // Caught by the linkage, before any hash is recomputed: record 3 was chained onto the
    // record that is no longer there, so its `previous_hash` names something that is not in
    // the walk. The renumbering is what hides the gap from the sequence check.
    expect(report.reason).toBe(ChainBreak.PREVIOUS_HASH_MISMATCH);
  });

  it('fails when a record is renumbered to hide a gap', () => {
    const chain = buildChain(threeRecords);
    const [first, second] = chain;

    const report = verifyChain('user.a', [first, second]);

    // Sequence 3 is still on disk but is not in the walk, so the store skipped it rather than
    // deleting it. The sequence check is what catches that before any hash is compared.
    expect(report.ok).toBe(true);

    const gapped = verifyChain('user.a', [first, second, { ...chain[2], sequence: 4 }]);
    expect(gapped.ok).toBe(false);
    expect(gapped.reason).toBe(ChainBreak.SEQUENCE_GAP);
  });

  it('fails when a record is deleted from the end', () => {
    const chain = buildChain(threeRecords);
    const truncatedChain = chain.slice(0, 2);

    // Every surviving link is internally consistent: this is the deletion the chain alone
    // cannot see. The stored head is what catches it.
    expect(verifyChain('user.a', truncatedChain).ok).toBe(true);
    expect(
      verifyChain('user.a', truncatedChain, { expectedHead: chain[2].hash }).reason,
    ).toBe(ChainBreak.HEAD_MISMATCH);
  });

  it('fails when two records are swapped', () => {
    const chain = buildChain(threeRecords);
    const [first, second, third] = chain;

    const report = verifyChain('user.a', [first, third, second]);

    expect(report.ok).toBe(false);
    expect([ChainBreak.SEQUENCE_GAP, ChainBreak.HASH_MISMATCH]).toContain(report.reason);
  });

  it('reports a capped walk as unverified rather than clean', () => {
    const chain = buildChain(threeRecords);

    // A truncated verification that returned `ok: true` would be the worst bug this service
    // could have: "checked 2 of 10, all good" reported as "the chain is intact".
    const report = verifyChain('user.a', chain, { limit: 2 });

    expect(report.ok).toBe(false);
    expect(report.truncatedAt).toBe(3);
    expect(report.checked).toBe(2);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('drops undefined rather than emitting it as null', () => {
    // `JSON.stringify` would emit `null` for an explicitly-undefined key and omit it for an
    // implicit one — two different byte sequences for what the caller means as the same record.
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('keeps a null, because null is a value and undefined is not', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });
});