/**
 * @fileoverview The append path: lock the head, hash, insert, advance the head.
 *
 * @remarks The row lock on `audit_chain_heads` is the entire concurrency argument. Two
 * writers to the same partition both need "the previous hash", and a read-then-write would let
 * them both read `H` and both write sequence `N+1` — two records at one position, and whichever
 * commits second has silently rewritten the first's chain. `SELECT ... FOR UPDATE` makes the
 * second writer wait, and because the lock is *per partition key*, it waits only behind writes
 * to the same chain. That is why the chain is partitioned at all.
 *
 * @remarks A head kept in process memory would be defeated twice over: by a restart, which
 * forgets the position, and by a second replica, which never had it. Neither failure is visible
 * — the service keeps running and the log keeps growing — and both leave a partition whose
 * stored head no longer describes its contents.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@auth/infra/prisma';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import {
  AUDIT_REPOSITORY,
  AppendOutcome,
  type AuditFilter,
  type AuditPage,
  type AuditRepositoryPort,
} from '../../domain/ports/audit-repository.port';
import { AuditEvent, type AuditEventProps } from '../../domain/audit-event.aggregate';
import {
  GENESIS_HASH,
  computeChainHash,
  verifyChain,
  type ChainLink,
  type ChainVerification,
  type ChainedRecord,
} from '../../domain/audit-chain';
import { AUDIT_LOG_PRISMA } from '../../audit-log.config';

/** The subset of the head row this repository reads. */
interface HeadRow {
  partition_key: string;
  head_hash: string;
  event_count: number;
}

@Injectable()
export class PrismaAuditRepository implements AuditRepositoryPort {
  private readonly logger = new Logger(PrismaAuditRepository.name);

  constructor(
    @Inject(AUDIT_LOG_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  async append(event: AuditEvent): Promise<AppendOutcome> {
    const partitionKey = event.partitionKey;

    try {
      return await this.prisma.runInTransaction(async (client) => {
        // `ON CONFLICT DO NOTHING` rather than an insert: two replicas can open a partition's
        // chain at the same moment, and the loser must fall through to the locking read rather
        // than fail. A unique violation here would abort the transaction it ran in, and an
        // aborted transaction cannot take the lock it needs.
        await client.audit_chain_heads.createMany({
          data: [
            {
              partition_key: partitionKey,
              head_hash: GENESIS_HASH,
              event_count: 0,
              created_at: event.receivedAt,
              updated_at: event.receivedAt,
            },
          ],
          skipDuplicates: true,
        });

        const head = await this.lockHead(client, partitionKey);
        const sequence = head.event_count + 1;

        const props = withSequence(event.link, sequence);
        const previousHash = head.head_hash;
        const hash = computeChainHash(props, previousHash);

        await client.audit_events.create({
          data: {
            id: props.id,
            partition_key: props.partitionKey,
            sequence: props.sequence,
            occurred_at: props.occurredAt,
            received_at: props.receivedAt,
            actor_id: props.actorId,
            actor_type: props.actorType,
            action: props.action,
            resource_type: props.resourceType,
            resource_id: props.resourceId,
            result: props.result,
            ip_address: props.ipAddress,
            user_agent: props.userAgent,
            payload: props.payload as unknown as Prisma.InputJsonValue,
            trace_id: props.traceId,
            previous_hash: previousHash,
            hash,
          },
        });

        await client.audit_chain_heads.update({
          where: { partition_key: partitionKey },
          data: { head_hash: hash, event_count: sequence, updated_at: event.receivedAt },
        });

        return AppendOutcome.APPENDED;
      });
    } catch (error) {
      // A duplicate id means the *same* record was already appended — a retried append of the
      // same event rather than a new fact. Reported as such, not thrown: the caller has
      // already decided it wants this fact stored once.
      if (isUniqueViolation(error)) {
        this.logger.debug(`record ${event.id} is already stored`);
        return AppendOutcome.DUPLICATE;
      }
      throw error;
    }
  }

  /**
   * Reads the head under a write lock, and holds it until the transaction ends.
   *
   * @remarks `$queryRaw` rather than the typed delegate: Prisma has no `findUnique` that takes
   * a lock, and `findFirst` followed by a read-modify-write is the exact race this whole class
   * exists to prevent.
   */
  private async lockHead(client: PrismaClient, partitionKey: string): Promise<HeadRow> {
    const rows = await client.$queryRaw<HeadRow[]>`
      SELECT partition_key, head_hash, event_count
        FROM audit_chain_heads
       WHERE partition_key = ${partitionKey}
         FOR UPDATE
    `;

    const head = rows[0];
    if (!head) {
      // Unreachable in practice: the `createMany` above either created it or found it, and
      // this runs inside the same transaction. Thrown rather than defaulted, because a
      // fabricated head would chain the record onto nothing and verification would fail from
      // the first record onwards with no way to tell why.
      throw new Error(`chain head for partition "${partitionKey}" vanished inside its transaction`);
    }

    return head;
  }

  async search(filter: AuditFilter, page: number, limit: number): Promise<AuditPage> {
    const where = toWhere(filter);
    const client = this.prisma.tx;

    // `count` and `findMany` are deliberately two queries rather than a windowed count: the
    // filter is a disjunction of optional predicates and a row-count window would have to be
    // evaluated for every matching row, which is slower than the second round trip on the
    // index and much harder to reason about.
    const [total, rows] = await Promise.all([
      client.audit_events.count({ where }),
      client.audit_events.findMany({
        where,
        // Newest first, with the partition's sequence as the tiebreaker. `occurred_at` alone
        // is not a total order — two records for one actor can share a millisecond — and a
        // paging scheme with a non-deterministic tiebreaker skips and repeats rows.
        orderBy: [{ occurred_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      records: rows.map(toAuditEvent),
      total,
      page,
      limit,
    };
  }

  async readPartition(partitionKey: string, limit?: number): Promise<ChainedRecord[]> {
    const rows = await this.prisma.tx.audit_events.findMany({
      where: { partition_key: partitionKey },
      // The chain's own order. `occurred_at` is producer-controlled and two records can share
      // it, so ordering by it would make the walk disagree with the sequence it is verifying.
      orderBy: { sequence: 'asc' },
      take: limit ?? Number.MAX_SAFE_INTEGER,
    });

    return rows.map(toChainedRecord);
  }

  async partitionKeys(limit?: number): Promise<string[]> {
    // `partition_key` is the leading column of the unique `(partition_key, sequence)` index, so
    // Postgres answers this from an index-only scan rather than a sort over the whole table.
    const rows = await this.prisma.tx.audit_events.findMany({
      distinct: ['partition_key'],
      select: { partition_key: true },
      orderBy: { partition_key: 'asc' },
      take: limit ?? Number.MAX_SAFE_INTEGER,
    });

    return rows.map((row) => row.partition_key);
  }

  async verify(partitionKey: string, limit?: number): Promise<ChainVerification> {
    const head = await this.prisma.tx.audit_chain_heads.findUnique({
      where: { partition_key: partitionKey },
      select: { head_hash: true, event_count: true },
    });

    const records = await this.readPartition(partitionKey, limit);

    return verifyChain(partitionKey, records, {
      ...(limit === undefined ? {} : { limit }),
      // The stored head is what notices a *deletion from the end*: every remaining link is
      // internally consistent, and only the head disagrees with the last surviving record.
      expectedHead: head?.head_hash ?? null,
    });
  }

  async count(): Promise<number> {
    return this.prisma.tx.audit_events.count();
  }
}

/**
 * Stamps a sequence onto a link and narrows the three vocabulary columns back from `string`.
 *
 * @remarks One function, so the record that is *hashed* and the record that is *written* are
 * built from the same call. Building them separately is how a chain stops verifying: the hash
 * is taken over one shape and the row holds another, and nothing complains until an operator
 * asks whether the log can be trusted.
 */
function withSequence(link: ChainLink, sequence: number): AuditEventProps {
  return {
    ...link,
    sequence,
    actorType: link.actorType as AuditEventProps['actorType'],
    resourceType: link.resourceType as AuditEventProps['resourceType'],
    result: link.result as AuditEventProps['result'],
  };
}

/** Maps the domain filter onto Prisma's `where`. Only present filters are applied. */
function toWhere(filter: AuditFilter): Prisma.audit_eventsWhereInput {
  return {
    ...(filter.actorId === undefined ? {} : { actor_id: filter.actorId }),
    ...(filter.actorType === undefined ? {} : { actor_type: filter.actorType }),
    ...(filter.action === undefined ? {} : { action: filter.action }),
    ...(filter.resourceType === undefined ? {} : { resource_type: filter.resourceType }),
    ...(filter.resourceId === undefined ? {} : { resource_id: filter.resourceId }),
    ...(filter.result === undefined ? {} : { result: filter.result }),
    ...(filter.from === undefined && filter.to === undefined
      ? {}
      : {
          occurred_at: {
            ...(filter.from ? { gte: filter.from } : {}),
            // Exclusive upper bound, so two adjacent windows do not double-count the record on
            // their shared boundary.
            ...(filter.to ? { lt: filter.to } : {}),
          },
        }),
  };
}

function toAuditEvent(row: Record<string, unknown>): AuditEvent {
  return AuditEvent.fromRow(toProps(row));
}

function toProps(row: Record<string, unknown>): AuditEventProps {
  return {
    id: String(row['id']),
    partitionKey: String(row['partition_key']),
    sequence: Number(row['sequence']),
    occurredAt: toDate(row['occurred_at']),
    receivedAt: toDate(row['received_at']),
    actorId: String(row['actor_id']),
    actorType: String(row['actor_type']) as AuditEventProps['actorType'],
    action: String(row['action']),
    resourceType: String(row['resource_type']) as AuditEventProps['resourceType'],
    resourceId: String(row['resource_id']),
    result: String(row['result']) as AuditEventProps['result'],
    ipAddress: row['ip_address'] === null ? null : String(row['ip_address']),
    userAgent: row['user_agent'] === null ? null : String(row['user_agent']),
    payload: (row['payload'] ?? {}) as Record<string, unknown>,
    traceId: String(row['trace_id']),
  };
}

/**
 * Reads a `timestamptz` column without losing precision.
 *
 * @remarks **Not** `new Date(String(value))`. `String(date)` produces
 * `"Mon Oct 19 2026 11:39:22 GMT+0300 (Eastern European Summer Time)"`, which has no
 * milliseconds — so the round trip silently truncates, and since the hash was taken over
 * `toISOString()` of the *full-precision* value, every stored record stops verifying.
 *
 * @remarks This is the failure mode this file's canonicalisation note warns about, and the one
 * an in-memory fake can never reproduce: the unit tests build records from `Date` objects and
 * round-trip them identically, so nothing fails until a row has actually been through Postgres.
 * Hence a reader that accepts what the driver actually returns rather than coercing it.
 */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  if (typeof value === 'number') return new Date(value);
  return new Date(Number.NaN);
}

/**
 * Projects a stored row onto the domain's chain record.
 *
 * @remarks Exported rather than left private because it is the one boundary where driver values
 * become domain values, and it is where this file has already had a bug: `new Date(String(v))`
 * silently dropped milliseconds, so every record stopped verifying after a round trip through
 * Postgres. A projection that is only reachable through a live database is a projection nobody
 * can regression-test.
 */
export function toChainedRecord(row: Record<string, unknown>): ChainedRecord {
  return {
    ...toProps(row),
    previousHash: String(row['previous_hash']),
    hash: String(row['hash']),
  };
}

/** Postgres `23505`. Prisma surfaces it as `P2002`. */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'P2002' || code === '23505';
}

export { AUDIT_REPOSITORY };