/**
 * @fileoverview One single-use account-recovery code.
 *
 * @remarks Generated with `crypto.randomBytes`, never `Math.random`. A recovery code is a
 * bearer credential that bypasses the password entirely, and a predictable one is not a
 * second factor — it is a first factor that an attacker can guess at the same rate.
 *
 * @remarks Only the SHA-256 digest is stored. The plaintext exists in memory for exactly as
 * long as the response that hands it to the user takes, so a database dump yields digests
 * rather than a working set of bypasses.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 80 bits per code. */
export const RECOVERY_CODE_BYTES = 10;

/** How many codes a regeneration issues unless configuration says otherwise. */
export const RECOVERY_CODE_COUNT_DEFAULT = 10;

/** Upper bound, so a misconfigured count cannot mint a million rows in one transaction. */
export const RECOVERY_CODE_COUNT_MAX = 50;

/** Hex-encoded SHA-256: 32 bytes, two characters each. */
export const RECOVERY_CODE_DIGEST_LENGTH = 64;

/**
 * Presentation grouping. Stripped before comparison, so it costs nothing to omit.
 *
 * @remarks 20 hex characters in groups of four, which is the width of a line of eight codes
 * and short enough to read aloud without ambiguity between `0` and `O` — there are no letters
 * in the alphabet at all.
 */
const GROUP_SIZE = 4;

export interface RecoveryCodeRow {
  code_index: number;
  code_digest: string;
  consumed_at: Date | null;
  created_at: Date;
}

export class RecoveryCode {
  /**
   * The plaintext, held behind a getter rather than an own property.
   *
   * @remarks `JSON.stringify(code)` is the leak this prevents: an own `value` property is
   * enumerable, so any logger or telemetry payload that serialises the code would emit a
   * live bypass.
   */
  private constructor(
    private readonly plaintext: string,
    readonly index: number,
    readonly digest: string,
    readonly createdAt: Date,
    /**
     * Named `consumedAtValue` rather than `consumedAt` because the public getter below owns
     * the outward name; a parameter property would shadow it and the getter would read the
     * constructor's binding instead of the current one.
     */
    private consumedAtValue: Date | null = null,
  ) {}

  /**
   * Mints one code.
   *
   * @remarks The digest is computed once, at mint time, and carried alongside the plaintext so
   * a regeneration is a single pass rather than a re-hash of every code at write time.
   */
  static mint(index: number, now: Date = new Date()): RecoveryCode {
    const plaintext = RecoveryCode.format(randomBytes(RECOVERY_CODE_BYTES).toString('hex'));
    return new RecoveryCode(
      plaintext,
      index,
      RecoveryCode.digestOf(plaintext),
      now,
    );
  }

  /** Rehydration path: the row is trusted, so only the index is re-established. */
  static fromRow(row: RecoveryCodeRow): RecoveryCode {
    return new RecoveryCode('', row.code_index, row.code_digest, row.created_at, row.consumed_at);
  }

  /** Mints a whole set, indexed from zero — the shape `recovery_codes` is keyed by. */
  static mintSet(
    count: number,
    now: Date = new Date(),
  ): readonly RecoveryCode[] {
    return Array.from({ length: count }, (_unused, index) => RecoveryCode.mint(index, now));
  }

  /** The single place a plaintext code becomes something storable. */
  static digestOf(code: string): string {
    return createHash('sha256').update(RecoveryCode.canonical(code), 'utf8').digest('hex');
  }

  /**
   * The form a presented code is reduced to before comparison.
   *
   * @remarks Upper-cased and stripped of separators, so `A1B2-C3D4` and `a1b2c3d4` are one
   * code. Recovery codes are read aloud and retyped; rejecting a correctly-typed code
   * because of a hyphen would push users toward writing them down.
   */
  static canonical(code: string): string {
    return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /** Constant-time digest comparison — see the note on `TokenDigester.matches`. */
  matches(presented: string): boolean {
    const expected = Buffer.from(this.digest, 'utf8');
    const actual = Buffer.from(RecoveryCode.digestOf(presented), 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  /**
   * Burns the code.
   *
   * @remarks Single-use is the entire security property of a recovery code, so a consumed one
   * stops matching immediately and the row records *when* it was used rather than deleting
   * it — a reused code is evidence, and deleting it destroys the only trace.
   *
   * @returns `false` when the code had already been consumed, which makes a second
   * verification of the same code fail.
   */
  consume(now: Date = new Date()): boolean {
    if (this.consumedAtValue !== null) return false;
    this.consumedAtValue = now;
    return true;
  }

  get isConsumed(): boolean {
    return this.consumedAtValue !== null;
  }

  /**
   * The plaintext, for the one response that carries it.
   *
   * @remarks Empty for a rehydrated code — that is the point. Anything that reaches a
   * recovered code has no way to read it back, because it was never stored.
   */
  get value(): string {
    return this.plaintext;
  }

  get consumedAt(): Date | null {
    return this.consumedAtValue;
  }

  /** Safe to log. Rehydrated codes have no plaintext at all, which is the normal case. */
  get obfuscated(): string {
    return this.plaintext ? `${this.plaintext.slice(0, GROUP_SIZE)}-…` : '[REDACTED]';
  }

  toJSON(): string {
    return this.obfuscated;
  }

  toString(): string {
    return this.obfuscated;
  }

  /**
   * `A1B2-C3D4-E5F6-…`, so a transcribed code can be read back in groups.
   *
   * @remarks Upper-cased to match {@link canonical}, so the code printed on the sheet and the
   * form it is compared in are the same string. `randomBytes().toString('hex')` emits
   * lower-case, and a user who copies what they see should never depend on the case of it.
   */
  private static format(hex: string): string {
    const upper = hex.toUpperCase();
    const groups: string[] = [];
    for (let offset = 0; offset < upper.length; offset += GROUP_SIZE) {
      groups.push(upper.slice(offset, offset + GROUP_SIZE));
    }
    return groups.join('-');
  }
}

/** Digests of a freshly minted set, in the shape `recovery_codes` expects. */
export const toDigestRows = (
  userId: string,
  codes: readonly RecoveryCode[],
): { user_id: string; code_index: number; code_digest: string; created_at: Date }[] =>
  codes.map((code) => ({
    user_id: userId,
    code_index: code.index,
    code_digest: code.digest,
    created_at: code.createdAt,
  }));

/** Sanity check for a count that came from configuration rather than from code. */
export function isValidRecoveryCodeCount(count: number): boolean {
  return Number.isInteger(count) && count > 0 && count <= RECOVERY_CODE_COUNT_MAX;
}