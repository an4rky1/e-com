/**
 * @fileoverview Test doubles for the audit-log service.
 *
 * @remarks All three ports, implemented in memory and *faithfully* — in particular the
 * idempotency store's claim is atomic and the repository's append really does chain, so a
 * consumer test exercises the same sequence of decisions production makes rather than a
 * recording of what they were supposed to do.
 */
import type { ConsumedMessage } from '@auth/infra/kafka';
import type { Topic } from '@auth/contracts';
import { AuditEvent, type AuditEventProps } from '../../src/domain/audit-event.aggregate';
import {
  GENESIS_HASH,
  computeChainHash,
  verifyChain,
  type ChainedRecord,
} from '../../src/domain/audit-chain';
import {
  AppendOutcome,
  type AppendOutcome as AppendOutcomeValue,
  type AuditFilter,
  type AuditPage,
  type AuditRepositoryPort,
} from '../../src/domain/ports/audit-repository.port';
import {
  ClaimRefusal,
  type ClaimResult,
  type IdempotencyKey,
  type IdempotencyStorePort,
} from '../../src/domain/ports/idempotency-store.port';
import type { RecordAuditEventInput } from '../../src/application/commands/record-audit-event.command';
import type { AuditRecorderPort, RecordResult } from '../../src/application/ports/audit-recorder.port';

export const USER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
export const OTHER_USER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

let idCounter = 0;

export function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

/** In-memory claims, with the same claim/release bookkeeping the Prisma store performs. */
export class InMemoryIdempotencyStore implements IdempotencyStorePort {
  readonly claimLog: IdempotencyKey[] = [];
  readonly releaseLog: IdempotencyKey[] = [];
  readonly held = new Map<IdempotencyKey, { createdAt: number; response: unknown }>();

  failNextClaim: Error | null = null;
  failNextRelease: Error | null = null;

  async claim(
    key: IdempotencyKey,
    response: Readonly<Record<string, unknown>>,
    options: { traceId?: string } = {},
  ): Promise<ClaimResult> {
    if (this.failNextClaim) {
      const error = this.failNextClaim;
      this.failNextClaim = null;
      throw error;
    }

    this.claimLog.push(key);

    if (this.held.has(key)) {
      return { claimed: false, refusal: ClaimRefusal.ALREADY_CLAIMED };
    }

    this.held.set(key, { createdAt: Date.now(), response: { ...response, traceId: options.traceId } });
    return { claimed: true };
  }

  async release(key: IdempotencyKey): Promise<boolean> {
    if (this.failNextRelease) {
      const error = this.failNextRelease;
      this.failNextRelease = null;
      throw error;
    }

    this.releaseLog.push(key);
    return this.held.delete(key);
  }

  async isClaimed(key: IdempotencyKey): Promise<boolean> {
    return this.held.has(key);
  }

  async releaseAbandoned(olderThan: Date): Promise<number> {
    let released = 0;
    for (const [key, value] of [...this.held]) {
      if (value.createdAt < olderThan.getTime()) {
        this.held.delete(key);
        released += 1;
      }
    }
    return released;
  }

  get heldCount(): number {
    return this.held.size;
  }
}

/**
 * In-memory storage that chains for real.
 *
 * @remarks It mirrors the repository's two invariants — one row per partition at a time, and a
 * head that only ever advances — so a consumer test that stores two records for one actor gets
 * a genuinely chained partition rather than two unrelated rows.
 */
export class InMemoryAuditRepository implements AuditRepositoryPort {
  readonly records: AuditEvent[] = [];
  private readonly chains = new Map<string, ChainedRecord[]>();
  private readonly heads = new Map<string, string>();

  failNextAppend: Error | null = null;
  appendLog: string[] = [];

  async append(event: AuditEvent): Promise<AppendOutcomeValue> {
    if (this.failNextAppend) {
      const error = this.failNextAppend;
      this.failNextAppend = null;
      throw error;
    }

    this.appendLog.push(event.id);

    if (this.records.some((existing) => existing.id === event.id)) {
      return AppendOutcome.DUPLICATE;
    }

    const chain = this.chains.get(event.partitionKey) ?? [];
    const sequence = chain.length + 1;
    const previousHash = chain.length === 0 ? GENESIS_HASH : chain[chain.length - 1].hash;

    const props: AuditEventProps = {
      ...(event.link as unknown as AuditEventProps),
      sequence,
    };

    const linked: ChainedRecord = { ...props, previousHash, hash: computeChainHash(props, previousHash) };

    chain.push(linked);
    this.chains.set(event.partitionKey, chain);
    this.heads.set(event.partitionKey, linked.hash);
    this.records.push(AuditEvent.record(props));

    return AppendOutcome.APPENDED;
  }

  async search(filter: AuditFilter, page: number, limit: number): Promise<AuditPage> {
    const matches = [...this.records]
      .reverse()
      .filter((record) => matchesFilter(record, filter));

    const offset = (page - 1) * limit;
    return {
      records: matches.slice(offset, offset + limit),
      total: matches.length,
      page,
      limit,
    };
  }

  async readPartition(partitionKey: string, limit?: number): Promise<ChainedRecord[]> {
    return (this.chains.get(partitionKey) ?? []).slice(0, limit ?? undefined);
  }

  async partitionKeys(limit?: number): Promise<string[]> {
    return [...this.chains.keys()].slice(0, limit ?? undefined);
  }

  async verify(partitionKey: string): Promise<ChainedVerification> {
    return verifyChain(partitionKey, this.chains.get(partitionKey) ?? [], {
      expectedHead: this.heads.get(partitionKey) ?? null,
    });
  }

  async count(): Promise<number> {
    return this.records.length;
  }

  /**
   * Direct access to a stored chain.
   *
   * @remarks Exposed so a test can tamper with it the way a database write would. Everything
   * else about this fake is honest about the production contract; this is the one hole in it,
   * and a hole is the point.
   */
  chainsFor(partitionKey: string): ChainedRecord[] {
    return this.chains.get(partitionKey) ?? [];
  }
}

type ChainedVerification = Awaited<ReturnType<AuditRepositoryPort['verify']>>;

function matchesFilter(record: AuditEvent, filter: AuditFilter): boolean {
  if (filter.actorId !== undefined && record.actorId !== filter.actorId) return false;
  if (filter.actorType !== undefined && record.actorType !== filter.actorType) return false;
  if (filter.action !== undefined && record.action !== filter.action) return false;
  if (filter.resourceType !== undefined && record.resourceType !== filter.resourceType) return false;
  if (filter.resourceId !== undefined && record.resourceId !== filter.resourceId) return false;
  if (filter.result !== undefined && record.result !== filter.result) return false;
  if (filter.from !== undefined && record.occurredAt.getTime() < filter.from.getTime()) return false;
  if (filter.to !== undefined && record.occurredAt.getTime() >= filter.to.getTime()) return false;
  return true;
}

/** Records what it was asked to record, and can be told to fail. */
export class RecordingRecorder implements AuditRecorderPort {
  readonly recorded: RecordAuditEventInput[] = [];
  failNext: Error | null = null;
  failWith: (() => Error) | null = null;

  async record(input: RecordAuditEventInput): Promise<RecordResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }

    if (this.failWith) throw this.failWith();

    this.recorded.push(input);
    return { id: nextId(), appended: true };
  }
}

/** A recorder that stores through the real handler, for end-to-end chain assertions. */
export class HandlerBackedRecorder implements AuditRecorderPort {
  constructor(
    private readonly handler: { execute(command: { input: RecordAuditEventInput }): Promise<RecordResult> },
  ) {}

  async record(input: RecordAuditEventInput): Promise<RecordResult> {
    return this.handler.execute({ input });
  }
}

let eventCounter = 0;

/** A Kafka message carrying a well-formed envelope, unless `payload` overrides it. */
export function eventMessage(
  topic: Topic | string,
  payload: Readonly<Record<string, unknown>>,
  overrides: {
    eventId?: string;
    occurredAt?: string;
    aggregateId?: string;
    traceId?: string;
    attempt?: number;
    raw?: unknown;
  } = {},
): ConsumedMessage<unknown> {
  eventCounter += 1;
  const eventId = overrides.eventId ?? nextId();

  // `in`, not `??`: `raw: null` is a poison payload a test is deliberately sending, and a
  // nullish fallback would silently replace it with a well-formed envelope.
  const envelope =
    'raw' in overrides
      ? overrides.raw
      : {
          eventId,
          type: topic,
          schemaVersion: 1,
          occurredAt: overrides.occurredAt ?? new Date().toISOString(),
          aggregateId: overrides.aggregateId ?? USER_ID,
          aggregateType: 'unknown',
          partitionKey: overrides.aggregateId ?? USER_ID,
          traceId: overrides.traceId ?? `trace-${eventId}`,
          payload,
        };

  return {
    payload: envelope,
    topic,
    partition: 0,
    offset: String(eventCounter),
    traceId: overrides.traceId,
    attempt: overrides.attempt ?? 1,
  };
}

