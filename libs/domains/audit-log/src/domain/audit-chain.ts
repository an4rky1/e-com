/**
 * @fileoverview The hash chain: the reason anybody believes this log.
 *
 * @remarks `hash = sha256(canonicalJson(record without hash/previousHash) + previousHash)`.
 * Two properties fall out of that, and only these two are claimed:
 *
 * 1. Altering any byte of a stored record changes that record's own hash, so verification
 *    fails at the altered record.
 * 2. Every later record in the same partition commits to the previous one, so the break
 *    propagates forward to the chain head — an insertion, a deletion or a reorder all move
 *    hashes that a verifier can see have moved.
 *
 * @remarks What this does *not* give you: a keyed MAC. An attacker with write access to
 * `audit_events` can rewrite a record *and* its successors correctly, and the chain will
 * verify. Defeating that needs an external witness — an append-only replica, a co-signing
 * service — which this workspace has no such thing for. Tamper-*evident*, not tamper-proof,
 * and the difference is worth being precise about before anyone relies on it.
 */
import { createHash } from 'node:crypto';

/**
 * `previous_hash` for the first record in a partition.
 *
 * @remarks A real, checkable value rather than an empty string: a NULL column would have to
 * be special-cased in every comparison, and "the first record has no previous hash" is
 * expressible as "the first record's previous hash is this constant".
 */
export const GENESIS_HASH = '0'.repeat(64);

/** The fields a hash is computed over. `hash` and `previousHash` are deliberately absent. */
export interface ChainLink {
  readonly id: string;
  readonly partitionKey: string;
  readonly sequence: number;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  readonly actorId: string;
  readonly actorType: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly result: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly traceId: string;
}

/**
 * Deterministic JSON.
 *
 * @remarks `JSON.stringify` on its own is not canonical: it preserves insertion order, so two
 * records with the same fields written in a different order would hash differently and
 * verification would report tampering where none exists. Keys are therefore sorted, and the
 * `Date` cases are pinned to a fixed ISO precision so a round-trip through Postgres
 * (`timestamptz(6)`) cannot change the bytes that were hashed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    // Arrays keep their order: a list is a sequence, not a set, and sorting it would make two
    // genuinely different records hash the same.
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

/**
 * The exact byte sequence a hash is taken over.
 *
 * @remarks Exposed rather than inlined so verification recomputes from the *stored* columns
 * and the writer computes from the in-memory record — if the two ever drift, the chain stops
 * verifying immediately and loudly, instead of silently verifying against a shape that is not
 * what is on disk.
 */
export function canonicalLinkJson(link: ChainLink): string {
  return canonicalJson({
    id: link.id,
    partitionKey: link.partitionKey,
    sequence: link.sequence,
    occurredAt: link.occurredAt.toISOString(),
    receivedAt: link.receivedAt.toISOString(),
    actorId: link.actorId,
    actorType: link.actorType,
    action: link.action,
    resourceType: link.resourceType,
    resourceId: link.resourceId,
    result: link.result,
    ipAddress: link.ipAddress,
    userAgent: link.userAgent,
    payload: link.payload,
    traceId: link.traceId,
  });
}

/**
 * `sha256(canonicalJson(link) + previousHash)`.
 *
 * @remarks The previous hash is concatenated *outside* the JSON rather than nested inside it,
 * so a record cannot be re-pointed at a different chain by moving a field. The concatenation
 * is not length-prefixed, which is safe here because `canonicalJson` always ends in `}` or
 * `]` and the previous hash is a fixed 64 hex characters — the boundary is unambiguous.
 */
export function computeChainHash(link: ChainLink, previousHash: string): string {
  return createHash('sha256')
    .update(canonicalLinkJson(link))
    .update(previousHash)
    .digest('hex');
}

/** A stored link, with the two hash columns the verifier needs to check. */
export interface ChainedRecord extends ChainLink {
  readonly previousHash: string;
  readonly hash: string;
}

/** Why a partition failed to verify. */
export const ChainBreak = {
  /** The stored hash does not match the stored fields. Somebody changed a column. */
  HASH_MISMATCH: 'hash_mismatch',
  /** `previous_hash` does not name the record before it. A record was removed or reordered. */
  PREVIOUS_HASH_MISMATCH: 'previous_hash_mismatch',
  /** `sequence` is not dense from 1. A record was removed from the middle. */
  SEQUENCE_GAP: 'sequence_gap',
  /** The final record does not match the head stored in `audit_chain_heads`. */
  HEAD_MISMATCH: 'head_mismatch',
} as const;

export type ChainBreak = (typeof ChainBreak)[keyof typeof ChainBreak];

export interface ChainVerification {
  readonly partitionKey: string;
  readonly ok: boolean;
  readonly checked: number;
  /** `null` when `ok`, otherwise the sequence of the first record that failed. */
  readonly brokenAt: number | null;
  readonly reason: ChainBreak | null;
  /** Present when `ok` is false because the walk was capped rather than completed. */
  readonly truncatedAt: number | null;
}

/**
 * Walks a partition and recomputes every hash.
 *
 * @remarks Records must already be in `sequence` order. Sorting is the caller's job because
 * the order is a property of storage — a repository that returns them out of order should
 * fail verification loudly rather than have this function quietly reorder them and report a
 * clean chain.
 *
 * @remarks `expectedHead` closes the loop against `audit_chain_heads`. Without it, deleting
 * the *last* record of a partition would verify perfectly: every remaining link is internally
 * consistent. The stored head is the only thing that notices.
 */
export function verifyChain(
  partitionKey: string,
  records: readonly ChainedRecord[],
  options: { limit?: number; expectedHead?: string | null } = {},
): ChainVerification {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  if (records.length === 0) {
    // An empty partition is a *valid* partition: there is nothing to have tampered with, and
    // a head of genesis for an unknown partition is not evidence of anything.
    return { partitionKey, ok: true, checked: 0, brokenAt: null, reason: null, truncatedAt: null };
  }

  let previousHash = GENESIS_HASH;
  let checked = 0;

  for (const record of records) {
    if (checked >= limit) {
      return {
        partitionKey,
        ok: false,
        checked,
        brokenAt: null,
        reason: null,
        truncatedAt: record.sequence,
      };
    }

    if (record.sequence !== checked + 1) {
      return break_(partitionKey, checked, record.sequence, ChainBreak.SEQUENCE_GAP);
    }

    if (record.previousHash !== previousHash) {
      return break_(partitionKey, checked, record.sequence, ChainBreak.PREVIOUS_HASH_MISMATCH);
    }

    const expected = computeChainHash(record, record.previousHash);
    if (expected !== record.hash) {
      return break_(partitionKey, checked, record.sequence, ChainBreak.HASH_MISMATCH);
    }

    previousHash = record.hash;
    checked += 1;
  }

  if (options.expectedHead !== undefined && options.expectedHead !== null) {
    if (options.expectedHead !== previousHash) {
      return {
        partitionKey,
        ok: false,
        checked,
        brokenAt: null,
        reason: ChainBreak.HEAD_MISMATCH,
        truncatedAt: null,
      };
    }
  }

  return { partitionKey, ok: true, checked, brokenAt: null, reason: null, truncatedAt: null };
}

/**
 * Recomputes the hash each record in `records` *should* have, from `fromSequence` onward.
 *
 * @remarks The forward half of the tamper argument, and the one a test needs: an insertion
 * into the middle of a partition cannot leave the later hashes alone, because each of them
 * commits to its predecessor. Exported rather than kept private so the test that proves this
 * uses the production function instead of a re-implementation of it.
 */
export function relinkFrom(
  records: readonly ChainedRecord[],
  fromSequence: number,
  previousHash: string,
): ChainedRecord[] {
  let carry = previousHash;

  return records.map((record) => {
    if (record.sequence < fromSequence) return record;

    const previousHash = carry;
    carry = computeChainHash(record, previousHash);
    return { ...record, previousHash, hash: carry };
  });
}

function break_(
  partitionKey: string,
  checked: number,
  sequence: number,
  reason: ChainBreak,
): ChainVerification {
  return { partitionKey, ok: false, checked, brokenAt: sequence, reason, truncatedAt: null };
}