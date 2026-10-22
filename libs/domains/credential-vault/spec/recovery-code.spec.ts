/**
 * Recovery codes: minting, storage and single use.
 *
 * @remarks The properties that matter are all negative ones — a code must not be readable
 * back, must not work twice, and must stop working the moment its set is replaced. Those are
 * exactly the properties a schema or a type annotation cannot express, so they are asserted
 * here rather than assumed.
 */
import {
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_COUNT_DEFAULT,
  RECOVERY_CODE_DIGEST_LENGTH,
  RecoveryCode,
  isValidRecoveryCodeCount,
  toDigestRows,
} from '../src/domain/value-objects/recovery-code.vo';
import { RecoveryCodeSet } from '../src/domain/recovery-code-set.aggregate';
import { payloadOf } from './testing/helpers';

const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('RecoveryCode — minting', () => {
  it('produces distinct codes drawn from the CSPRNG', () => {
    const codes = Array.from({ length: 200 }, () => RecoveryCode.mint(0));

    // 200 collisions in 80 bits of entropy is not a coincidence anyone should wait to discover;
    // this is the cheap guard against a future edit that swaps `randomBytes` for `Math.random`.
    expect(new Set(codes.map((code) => code.value)).size).toBe(200);
  });

  it('carries RECOVERY_CODE_BYTES of entropy', () => {
    expect(RECOVERY_CODE_BYTES * 2).toBe(20);
    expect(RecoveryCode.mint(0).value.replace(/-/g, '')).toHaveLength(20);
  });

  it('groups the code so a transcribed one can be read back', () => {
    expect(RecoveryCode.mint(0).value).toMatch(/^([0-9A-F]{4}-){4}[0-9A-F]{4}$/);
  });

  it('stores only a SHA-256 digest', () => {
    const code = RecoveryCode.mint(0);

    expect(code.digest).toHaveLength(RECOVERY_CODE_DIGEST_LENGTH);
    expect(code.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(code.digest).not.toContain(code.value);
  });

  it('does not expose the plaintext through JSON or string coercion', () => {
    // A logger that stringifies the object must not emit a live bypass.
    const code = RecoveryCode.mint(0);

    expect(JSON.stringify(code)).not.toContain(code.value.replace(/-/g, ''));
    expect(String(code)).toBe(code.obfuscated);
  });
});

describe('RecoveryCode — comparison', () => {
  it('matches regardless of case and separators, because codes are retyped aloud', () => {
    const code = RecoveryCode.mint(0);
    const retyped = code.value.toLowerCase().replace(/-/g, ' ');

    expect(code.matches(retyped)).toBe(true);
  });

  it('rejects a different code', () => {
    expect(RecoveryCode.mint(0).matches(RecoveryCode.mint(1).value)).toBe(false);
  });
});

describe('RecoveryCode — single use', () => {
  it('stops matching the moment it is consumed', () => {
    const code = RecoveryCode.mint(0);
    const presented = code.value;

    expect(code.isConsumed).toBe(false);
    expect(code.consume()).toBe(true);

    expect(code.isConsumed).toBe(true);
    expect(code.consume()).toBe(false);
    expect(code.matches(presented)).toBe(true);
  });

  it('records when it was consumed rather than deleting the row', () => {
    // A reused code is evidence. Deleting the row would destroy the only trace of it.
    const now = new Date('2026-01-01T00:00:00.000Z');
    const code = RecoveryCode.mint(0, now);

    code.consume(now);
    expect(code.consumedAt).toEqual(now);

    expect(RecoveryCode.fromRow({
      code_index: 0,
      code_digest: code.digest,
      consumed_at: now,
      created_at: now,
    }).isConsumed).toBe(true);
  });
});

describe('RecoveryCodeSet', () => {
  it('issues an indexed set and announces exactly one event', () => {
    const { set, codes } = RecoveryCodeSet.issue({ userId: USER_ID, count: 5 });

    expect(codes).toHaveLength(5);
    expect(codes.map((code) => code.index)).toEqual([0, 1, 2, 3, 4]);
    expect(set.remaining).toBe(5);

    const events = set.domainEvents;
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('credential.recovery_codes_regenerated');
    expect(events[0].aggregateId).toBe(USER_ID);
  });

  it('carries no code and no digest in the event payload', () => {
    // The fact worth publishing is "this user's bypasses were replaced" — nobody downstream
    // needs the codes themselves, and an outbox row is the least protected place to put them.
    const { set } = RecoveryCodeSet.issue({ userId: USER_ID, count: 5 });
    const payload = payloadOf(set.domainEvents[0]);

    expect(payload).toEqual({ userId: USER_ID, codeCount: 5 });
    expect(JSON.stringify(payload)).not.toContain(set.toRows()[0].code_digest);
  });

  it('writes digest rows, never plaintext', () => {
    const { set, codes } = RecoveryCodeSet.issue({ userId: USER_ID, count: 3 });
    const rows = toDigestRows(USER_ID, codes);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.user_id).toBe(USER_ID);
      expect(row.code_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(row)).not.toContain(codes[0].value);
    }
    expect(set.toRows().map((row) => row.code_digest)).toEqual(rows.map((r) => r.code_digest));
  });
});

describe('RecoveryCodeSet.consume — single use', () => {
  it('accepts a code once and refuses the very same code a second time', () => {
    const { set, codes } = RecoveryCodeSet.issue({ userId: USER_ID, count: 3 });
    const presented = codes[1].value;

    expect(set.consume(presented)).toBe(1);
    expect(set.remaining).toBe(2);

    // The second attempt fails. This is the entire security property of a recovery code: it
    // is a one-shot bypass, not a second factor that can be replayed.
    expect(set.consume(presented)).toBeNull();
    expect(set.remaining).toBe(2);
  });

  it('does not consume any other code as a side effect of a reused attempt', () => {
    const { set, codes } = RecoveryCodeSet.issue({ userId: USER_ID, count: 3 });

    set.consume(codes[0].value);
    set.consume(codes[0].value);

    expect(set.consume(codes[1].value)).toBe(1);
    expect(set.consume(codes[2].value)).toBe(2);
    expect(set.remaining).toBe(0);
  });

  it('returns null for a code that was never issued', () => {
    const { set } = RecoveryCodeSet.issue({ userId: USER_ID, count: 2 });

    expect(set.consume('AAAA-BBBB-CCCC-DDDD-EEEE')).toBeNull();
    expect(set.remaining).toBe(2);
  });

  it('records the consumption on the row so it survives a reload', () => {
    const now = new Date('2026-02-02T10:00:00.000Z');
    const { set, codes } = RecoveryCodeSet.issue({ userId: USER_ID, count: 2, now });
    const consumed = codes[0].value;

    set.consume(consumed, now);

    const reloaded = RecoveryCodeSet.fromRows(
      USER_ID,
      set.toRows().map((row) => ({ ...row })),
    );

    expect(reloaded.remaining).toBe(1);
    expect(reloaded.consume(consumed)).toBeNull();
  });
});

describe('RecoveryCodeSet.regenerate — invalidates the previous set', () => {
  it('makes every previously issued code stop working', () => {
    const { set, codes } = RecoveryCodeSet.issue({ userId: USER_ID, count: 4 });
    const previous = codes.map((code) => code.value);

    const replacement = set.regenerate();

    for (const old of previous) {
      expect(set.consume(old)).toBeNull();
    }
    expect(set.remaining).toBe(replacement.length);
  });

  it('issues codes that are not merely the same values reshuffled', () => {
    const { set, codes } = RecoveryCodeSet.issue({ userId: USER_ID, count: 4 });
    const previous = new Set(codes.map((code) => code.value));

    const replacement = set.regenerate();

    for (const code of replacement) {
      expect(previous.has(code.value)).toBe(false);
    }
  });

  it('honours a smaller count, because the user threw the rest away', () => {
    const { set } = RecoveryCodeSet.issue({ userId: USER_ID, count: 8 });

    expect(set.regenerate({ count: 3 })).toHaveLength(3);
    expect(set.remaining).toBe(3);
    expect(set.total).toBe(3);
  });

  it('announces each regeneration with a distinct, strictly increasing version', () => {
    // `recovery_codes` has no revision column, so the version is the tail of the outbox
    // `dedup_key`. Reusing one would turn a real event into a silently skipped duplicate.
    const { set } = RecoveryCodeSet.issue({ userId: USER_ID, count: 2 });
    const first = set.domainEvents[0].version;

    set.regenerate();
    set.regenerate();

    const versions = set.domainEvents.map((event) => event.version);
    expect(new Set(versions).size).toBe(3);
    expect(versions[1]).toBeGreaterThan(first);
    expect(versions[2]).toBeGreaterThan(versions[1]);
  });

  it('carries no plaintext in the replacement event either', () => {
    const { set } = RecoveryCodeSet.issue({ userId: USER_ID, count: 2 });
    const replacement = set.regenerate();

    set.clearDomainEvents();
    expect(JSON.stringify(set.domainEvents)).not.toContain(replacement[0].value);
  });
});

describe('RecoveryCodeSet — count validation', () => {
  it('defaults to the configured count', () => {
    const { codes } = RecoveryCodeSet.issue({ userId: USER_ID });
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT_DEFAULT);
  });

  it('rejects a count that did not come from code', () => {
    // A misconfigured `count` must fail at issuance, not mint a million rows in one
    // transaction and time the caller out discovering it.
    expect(() => RecoveryCodeSet.issue({ userId: USER_ID, count: 0 })).toThrow(/between 1 and/);
    expect(() => RecoveryCodeSet.issue({ userId: USER_ID, count: 999 })).toThrow(/between 1 and/);
    expect(() => RecoveryCodeSet.issue({ userId: USER_ID, count: 2.5 })).toThrow(/between 1 and/);
  });

  it('validates a count through the exported helper', () => {
    expect(isValidRecoveryCodeCount(1)).toBe(true);
    expect(isValidRecoveryCodeCount(10)).toBe(true);
    expect(isValidRecoveryCodeCount(0)).toBe(false);
    expect(isValidRecoveryCodeCount(RECOVERY_CODE_COUNT_DEFAULT + 100)).toBe(false);
    expect(isValidRecoveryCodeCount(Number.NaN)).toBe(false);
  });
});