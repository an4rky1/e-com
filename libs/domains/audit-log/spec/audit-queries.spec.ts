/**
 * @fileoverview The read side: what an operator asks for, and what they are told when it is
 * wrong.
 *
 * @remarks The empty-result answer is the dangerous one. `?result=sucess` silently returning
 * nothing reads as "this account did nothing suspicious", which is the exact conclusion an
 * operator reaches when they mistyped a filter — and it is indistinguishable from a working
 * filter that legitimately matched nothing. So the vocabulary is validated, and the paging
 * bounds are the configuration's, not the caller's.
 */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Topics } from '@auth/contracts';
import { AuditLogService } from '../src/application/facade/audit-log.service';
import {
  SearchAuditEventsHandler,
  SearchAuditEventsQuery,
  VerifyAuditChainHandler,
  VerifyAuditChainQuery,
} from '../src/application/queries/audit.queries';
import { toAuditFilter, toPageNumbers } from '../src/presentation/dto/audit-query.dto';
import { AuditController } from '../src/presentation/audit.controller';
import { AuditLogHealthIndicator } from '../src/audit-log.health';
import { ActorType, AuditResult, ResourceType } from '../src/domain/value-objects/audit-result.vo';
import { RecordAuditEventHandler } from '../src/application/commands/record-audit-event.handler';
import { AuditEventProcessor } from '../src/application/consumers/audit-event.processor';
import {
  HandlerBackedRecorder,
  InMemoryAuditRepository,
  InMemoryIdempotencyStore,
  OTHER_USER_ID,
  USER_ID,
  eventMessage,
} from './testing/fakes';
import type { AuditLogConfig } from '../src/audit-log.config';

const CONFIG: AuditLogConfig = {
  maxPageSize: 100,
  defaultPageSize: 50,
  claimTtlSec: 900,
  deadLetterEnabled: true,
  maxVerifyRecords: 10_000,
  partitionStrategy: 'actor',
};

function stack() {
  const repository = new InMemoryAuditRepository();
  const claims = new InMemoryIdempotencyStore();
  const handler = new RecordAuditEventHandler(repository, claims, CONFIG);
  const processor = new AuditEventProcessor(new HandlerBackedRecorder(handler), claims);
  const search = new SearchAuditEventsHandler(repository, CONFIG);
  const verify = new VerifyAuditChainHandler(repository, CONFIG);
  return { repository, claims, processor, search, verify };
}

/** A week of history for two actors, so a filter has something to exclude. */
async function seed({ processor }: { processor: AuditEventProcessor }): Promise<void> {
  const at = (offsetMinutes: number) =>
    new Date(Date.parse('2026-10-19T09:00:00.000Z') + offsetMinutes * 60_000).toISOString();

  const events: ReadonlyArray<readonly [string, Record<string, unknown>, number]> = [
    [Topics.PERMISSION_DENIED, { userId: USER_ID, permission: 'reports.export', reason: 'r' }, 0],
    [Topics.PERMISSION_DENIED, { userId: USER_ID, permission: 'billing.refund', reason: 'r' }, 10],
    [Topics.USER_LOCKED, { userId: USER_ID, previousStatus: 'active', status: 'locked' }, 20],
    [Topics.USER_UNLOCKED, { userId: USER_ID, previousStatus: 'locked', status: 'active' }, 30],
    [Topics.SESSION_REVOKED, { sessionId: 's-1', userId: OTHER_USER_ID, reason: 'reuse' }, 40],
    [
      Topics.SECURITY_ANOMALY_DETECTED,
      { userId: OTHER_USER_ID, type: 'anomaly_detected', riskScore: 88, riskLevel: 'high' },
      50,
    ],
    [
      Topics.CREDENTIAL_FAILED,
      { identifier: 'nobody@example.com', attempt: 1 },
      60,
    ],
    [
      Topics.AUTH_FLOW_FAILED,
      { flowId: 'flow-1', userId: USER_ID, flow: 'sign_in', state: 'password', reason: 'bad' },
      70,
    ],
  ];

  for (const [topic, payload, offset] of events) {
    await processor.process(eventMessage(topic, payload, { occurredAt: at(offset) }));
  }
}

describe('filtering and paging the log', () => {
  it('returns everything when nothing is filtered', async () => {
    const s = stack();
    await seed(s);

    const page = await s.search.execute(new SearchAuditEventsQuery({}));

    expect(page.total).toBe(8);
    expect(page.data).toHaveLength(8);
    expect(page.limit).toBe(CONFIG.defaultPageSize);
  });

  it('filters by actor', async () => {
    const s = stack();
    await seed(s);

    const page = await s.search.execute(new SearchAuditEventsQuery({ actorId: USER_ID }));

    expect(page.total).toBe(5);
    expect(new Set(page.data.map((record) => record.actorId))).toEqual(new Set([USER_ID]));
  });

  it('filters by action, resource and result', async () => {
    const s = stack();
    await seed(s);

    expect((await s.search.execute(new SearchAuditEventsQuery({ action: 'permission.denied' }))).total).toBe(2);
    expect((await s.search.execute(new SearchAuditEventsQuery({ resourceType: ResourceType.USER }))).total).toBe(2);
    expect((await s.search.execute(new SearchAuditEventsQuery({ resourceId: 'billing.refund' }))).total).toBe(1);
    expect((await s.search.execute(new SearchAuditEventsQuery({ result: AuditResult.DENIED }))).total).toBe(2);
    expect((await s.search.execute(new SearchAuditEventsQuery({ result: AuditResult.DETECTED }))).total).toBe(1);
  });

  it('filters by a time range, with an exclusive upper bound', async () => {
    const s = stack();
    await seed(s);

    const from = new Date('2026-10-19T09:10:00.000Z');
    const to = new Date('2026-10-19T09:40:00.000Z');

    const page = await s.search.execute(new SearchAuditEventsQuery({ from, to }));

    // Offsets 10, 20, 30 minutes. The record at exactly `to` is excluded, so two adjacent
    // windows tile the timeline without double-counting the record on their shared edge.
    expect(page.total).toBe(3);
    expect(page.data.map((record) => record.action).sort()).toEqual([
      'permission.denied',
      'user.locked',
      'user.unlocked',
    ]);
  });

  it('refuses an inverted range rather than quietly returning nothing', async () => {
    const s = stack();

    await expect(
      s.search.execute(
        new SearchAuditEventsQuery({
          from: new Date('2026-10-20T00:00:00.000Z'),
          to: new Date('2026-10-19T00:00:00.000Z'),
        }),
      ),
    ).rejects.toThrow('must not be later than');
  });

  it('paginates', async () => {
    const s = stack();
    await seed(s);

    const first = await s.search.execute(new SearchAuditEventsQuery({}, 1, 3));
    const second = await s.search.execute(new SearchAuditEventsQuery({}, 2, 3));

    expect(first.data).toHaveLength(3);
    expect(second.data).toHaveLength(3);
    expect(first.total).toBe(8);
    // Newest first, and the two pages do not overlap.
    const ids = new Set([...first.data, ...second.data].map((record) => record.id));
    expect(ids.size).toBe(6);
  });

  it('clamps a caller page size to the configured ceiling', async () => {
    const s = stack();
    await seed(s);

    // An unbounded `limit` on a table that grows without limit is a denial of service that
    // only shows up once the table is big — which is exactly when somebody is relying on it.
    expect((await s.search.execute(new SearchAuditEventsQuery({}, 1, 100_000))).limit).toBe(
      CONFIG.maxPageSize,
    );
    expect((await s.search.execute(new SearchAuditEventsQuery({}, 0, 0))).page).toBe(1);
    expect((await s.search.execute(new SearchAuditEventsQuery({}, 0, 0))).limit).toBe(1);
  });

  it('projects to a read model rather than exposing the aggregate', async () => {
    const s = stack();
    await seed(s);

    const [record] = (await s.search.execute(new SearchAuditEventsQuery({}))).data;

    expect(Object.keys(record).sort()).toEqual([
      'action',
      'actorId',
      'actorType',
      'id',
      'ipAddress',
      'occurredAt',
      'partitionKey',
      'payload',
      'receivedAt',
      'resourceId',
      'resourceType',
      'result',
      'sequence',
      'traceId',
      'userAgent',
    ]);
    // The hash columns are deliberately absent: a caller cannot replay the chain through the
    // read API, and cannot be handed a value to compare against a forged one.
    expect(record).not.toHaveProperty('hash');
    expect(record).not.toHaveProperty('previousHash');
  });
});

describe('the query parameters an operator sends', () => {
  it('builds a filter from a well-formed query', () => {
    const filter = toAuditFilter({
      actorId: USER_ID,
      action: 'permission.denied',
      result: 'denied',
      from: '2026-10-19T09:00:00.000Z',
      to: '2026-10-19T10:00:00.000Z',
    });

    expect(filter).toEqual({
      actorId: USER_ID,
      action: 'permission.denied',
      result: 'denied',
      from: new Date('2026-10-19T09:00:00.000Z'),
      to: new Date('2026-10-19T10:00:00.000Z'),
    });
  });

  it('rejects a misspelled result rather than returning nothing', () => {
    // The dangerous answer. `result=sucess` matching zero rows is indistinguishable from a
    // legitimate filter that matched nothing.
    expect(() => toAuditFilter({ result: 'sucess' })).toThrow('"result" must be one of');
  });

  it('rejects an unknown resource type', () => {
    expect(() => toAuditFilter({ resourceType: 'bill' })).toThrow('"resourceType" must be one of');
  });

  it('rejects a date that is not a date', () => {
    expect(() => toAuditFilter({ from: 'yesterday' })).toThrow('must be an ISO-8601');
    expect(() => toAuditFilter({ to: '19/10/2026' })).toThrow('must be an ISO-8601');
  });

  it('rejects a page number that is not one', () => {
    expect(toPageNumbers({ page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 });
    expect(() => toPageNumbers({ page: '0' })).toThrow('positive integer');
    expect(() => toPageNumbers({ limit: '-1' })).toThrow('positive integer');
    expect(() => toPageNumbers({ page: 'two' })).toThrow('positive integer');
  });

  it('accepts a bare date', () => {
    expect(toAuditFilter({ from: '2026-10-19' }).from).toEqual(
      new Date('2026-10-19T00:00:00.000Z'),
    );
  });
});

describe('verifying a chain over the read API', () => {
  it('passes for an untouched partition', async () => {
    const s = stack();
    await seed(s);

    const report = await s.verify.execute(new VerifyAuditChainQuery(`user.${USER_ID}`));

    expect(report.ok).toBe(true);
    expect(report.checked).toBe(5);
    expect(report.partitions).toBe(1);
  });

  it('sweeps every partition when none is named', async () => {
    const s = stack();
    await seed(s);

    const report = await s.verify.execute(new VerifyAuditChainQuery());

    expect(report.ok).toBe(true);
    expect(report.partitions).toBeGreaterThan(1);
    expect(report.checked).toBe(8);
  });

  it('passes for a partition that does not exist', async () => {
    const s = stack();

    // Nothing to have tampered with. Reporting this as broken would page somebody about a
    // chain that was never opened.
    const report = await s.verify.execute(new VerifyAuditChainQuery('user.never-seen'));

    expect(report.ok).toBe(true);
    expect(report.checked).toBe(0);
  });

  it('reports the first broken partition in a sweep', async () => {
    const s = stack();
    await seed(s);

    // Tamper directly with the stored chain, exactly as a database write would.
    const chain = s.repository.chainsFor(`user.${USER_ID}`);
    chain[1] = { ...chain[1], payload: { permission: 'billing.write', reason: 'forged' } };

    const report = await s.verify.execute(new VerifyAuditChainQuery());

    expect(report.ok).toBe(false);
    expect(report.partitionKey).toBe(`user.${USER_ID}`);
    expect(report.reason).toBe('hash_mismatch');
    expect(report.brokenAt).toBe(2);
  });
});

describe('the HTTP surface', () => {
  /** A controller over the real handler and query handlers, with a hand-built facade. */
  function controller(s: ReturnType<typeof stack>): AuditController {
    const facade = {
      search: (filter: never, page?: number, limit?: number) =>
        s.search.execute(new SearchAuditEventsQuery(filter, page, limit)),
      verify: (partitionKey?: string) => s.verify.execute(new VerifyAuditChainQuery(partitionKey)),
    } as unknown as ConstructorParameters<typeof AuditController>[0];

    return new AuditController(facade);
  }

  it('answers GET /audit', async () => {
    const s = stack();
    await seed(s);

    const body = await controller(s).search({ action: 'permission.denied' });

    expect(body.total).toBe(2);
  });

  it('answers GET /audit/verify', async () => {
    const s = stack();
    await seed(s);

    const body = await controller(s).verify(`user.${USER_ID}`);

    expect(body.ok).toBe(true);
  });

  it('turns a bad query parameter into a 400 rather than a 500', async () => {
    const s = stack();

    // An unparsed `from` that reached Prisma would be an unhandled 500, which tells an
    // operator nothing about what they typed wrong.
    await expect(controller(s).search({ result: 'sucess' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('offers no way to write', () => {
    // An audit log that accepts an edit over HTTP is not append-only, and the hash chain is
    // the only thing between an operator with a database client and a rewritten history.
    // Two routes, both `GET`.
    //
    // Nest stores route metadata on the *handler function*, not on the property key, so the
    // lookup goes through the method value.
    const verbs = Object.getOwnPropertyNames(AuditController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = AuditController.prototype[name as 'search'];
        return Reflect.getMetadata(METHOD_METADATA, handler);
      });

    expect(verbs).toEqual([RequestMethod.GET, RequestMethod.GET]);
    expect(Reflect.getMetadata(PATH_METADATA, AuditController)).toBe('audit');
  });
});

describe('the health indicator', () => {
  it('reports the record count and the chain state', async () => {
    const s = stack();
    await seed(s);

    const health = await new AuditLogHealthIndicator(s.repository).check();

    expect(health['audit-log']).toMatchObject({
      status: 'up',
      events: 8,
      chainIntact: true,
    });
  });

  it('reports `unknown` rather than broken for a log that has never been written to', async () => {
    const s = stack();

    const health = await new AuditLogHealthIndicator(s.repository).check();

    // A fresh deployment is not an incident. Reporting `false` would page somebody at 3am
    // about a service nobody has used yet.
    expect(health['audit-log']).toMatchObject({ status: 'up', events: 0, chainIntact: 'unknown' });
  });

  it('reports down when the log cannot be read', async () => {
    const s = stack();
    jest
      .spyOn(s.repository, 'count')
      .mockRejectedValueOnce(new Error('the database is unreachable'));

    const health = await new AuditLogHealthIndicator(s.repository).check();

    expect(health['audit-log']).toMatchObject({ status: 'down' });
  });
});

describe('the facade', () => {
  it('routes a write and both reads through the command and query buses', async () => {
    const buses = { execute: jest.fn() };
    const service = new AuditLogService(
      buses as unknown as ConstructorParameters<typeof AuditLogService>[0],
      buses as unknown as ConstructorParameters<typeof AuditLogService>[1],
    );

    await service.record({
      idempotencyKey: 'platform.session.revoked.v1:e1',
      actorId: USER_ID,
      actorType: ActorType.USER,
      action: 'session.revoked',
      resourceType: ResourceType.SESSION,
      resourceId: 's-1',
      result: AuditResult.SUCCESS,
      occurredAt: new Date('2026-10-19T09:00:00.000Z'),
      payload: {},
      traceId: 'trace-1',
    });
    await service.search({ actorId: USER_ID });
    await service.verify(`user.${USER_ID}`);

    expect(buses.execute).toHaveBeenCalledTimes(3);
  });
});