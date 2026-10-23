/**
 * @fileoverview Consumption: redelivery, poison messages, and the gap that must not happen.
 *
 * @remarks These are the three failure modes that decide whether an audit log is worth
 * anything, and each one fails *quietly* when it is got wrong:
 *
 * - no idempotency claim, and every redelivery appends a second, hash-chained record saying
 *   the same thing happened — a log that manufactures its own evidence;
 * - a swallowed storage failure, and the offset commits over an event nobody recorded — a hole
 *   with no error anywhere;
 * - no dead letter, and one unparseable payload takes its whole partition down for as long as
 *   the broker keeps redelivering it.
 *
 * @remarks Everything runs through the real processor and the real handler over in-memory
 * ports. A test that stubbed the handler would prove the stub is idempotent.
 */
import { Topics } from '@auth/contracts';
import { DomainError } from '@auth/core';
import { AuditEventProcessor } from '../src/application/consumers/audit-event.processor';
import { RecordAuditEventHandler } from '../src/application/commands/record-audit-event.handler';
import { AuditKafkaConsumer } from '../src/infrastructure/messaging/audit.kafka.consumer';
import { SUBSCRIBED_TOPICS } from '../src/domain/audit-routing';
import { idempotencyKeyFor } from '../src/domain/ports/idempotency-store.port';
import { HandlerBackedRecorder, InMemoryAuditRepository, InMemoryIdempotencyStore, OTHER_USER_ID, USER_ID, eventMessage } from './testing/fakes';
import type { AuditLogConfig } from '../src/audit-log.config';

const CONFIG: AuditLogConfig = {
  maxPageSize: 100,
  defaultPageSize: 50,
  claimTtlSec: 900,
  deadLetterEnabled: true,
  maxVerifyRecords: 10_000,
  partitionStrategy: 'actor',
};

const deniedPayload = {
  userId: USER_ID,
  permission: 'reports.export',
  reason: 'insufficient role',
};

/**
 * The whole consume path: Kafka adapter -> processor -> handler -> repository -> claims.
 *
 * @remarks Real handler, real chain, in-memory storage. The only thing stubbed is where the
 * bytes land, which is the one thing these tests are not about.
 */
function stack() {
  const repository = new InMemoryAuditRepository();
  const claims = new InMemoryIdempotencyStore();
  const handler = new RecordAuditEventHandler(repository, claims, CONFIG);
  const recorder = new HandlerBackedRecorder(handler);
  const processor = new AuditEventProcessor(recorder, claims);

  const published: { topic: string; payload: string }[] = [];
  const adapter = new AuditKafkaConsumer(
    { register: (): void => undefined } as unknown as ConstructorParameters<typeof AuditKafkaConsumer>[0],
    {
      send: async (topic: string, payload: string): Promise<void> => {
        published.push({ topic, payload });
      },
    } as unknown as ConstructorParameters<typeof AuditKafkaConsumer>[1],
    processor,
    CONFIG,
  );

  return { repository, claims, handler, processor, adapter, published };
}

describe('the topics this service subscribes to', () => {
  it('is exactly the security-relevant ones', () => {
    // A topic that is subscribed but unrouted is consumed, acknowledged and produces no audit
    // record — the single worst wiring mistake available to this service.
    expect([...SUBSCRIBED_TOPICS].sort()).toEqual(
      [
        'platform.auth_flow.failed.v1',
        'platform.credential.failed.v1',
        'platform.permission.denied.v1',
        'platform.role.granted.v1',
        'platform.role.revoked.v1',
        'platform.security.anomaly_detected.v1',
        'platform.security.new_device_detected.v1',
        'platform.security.suspicious_login_detected.v1',
        'platform.session.revoked.v1',
        'platform.session.token_reuse_detected.v1',
        'platform.user.locked.v1',
        'platform.user.unlocked.v1',
      ].sort(),
    );
  });

  it('leaves the non-security topics alone', () => {
    // Subscribing to everything would keep this consumer in the rebalance set of topics it
    // will never act on, slowing down a consumer that does have work.
    expect(SUBSCRIBED_TOPICS).not.toContain(Topics.USER_REGISTERED);
    expect(SUBSCRIBED_TOPICS).not.toContain(Topics.SESSION_ISSUED);
    expect(SUBSCRIBED_TOPICS).not.toContain(Topics.API_KEY_CREATED);
  });
});

describe('the same event, delivered twice', () => {
  it('appends exactly one record', async () => {
    const { processor, repository } = stack();
    const message = eventMessage(Topics.PERMISSION_DENIED, deniedPayload);

    const first = await processor.process(message);
    const second = await processor.process(message);

    expect(first.kind).toBe('recorded');
    expect(second.kind).toBe('duplicate');
    // One record, one chain position. Two would be two verifiable statements that the same
    // denial happened twice — which is precisely the shape of a fabricated log.
    expect(await repository.count()).toBe(1);
    expect((await repository.readPartition(`user.${USER_ID}`))[0].sequence).toBe(1);
  });

  it('claims on the topic and the event id, not on the actor', async () => {
    // Dedupe on `userId` would silently swallow the second denial, and "how many times did
    // this account try" is the question an audit log exists to answer.
    const { processor, repository, claims } = stack();
    const first = 'dddddddd-0000-4000-8000-000000000001';
    const second = 'dddddddd-0000-4000-8000-000000000002';

    await processor.process(eventMessage(Topics.PERMISSION_DENIED, deniedPayload, { eventId: first }));
    await processor.process(eventMessage(Topics.PERMISSION_DENIED, deniedPayload, { eventId: second }));

    expect(await repository.count()).toBe(2);
    expect(claims.claimLog).toEqual([
      idempotencyKeyFor(Topics.PERMISSION_DENIED, first),
      idempotencyKeyFor(Topics.PERMISSION_DENIED, second),
    ]);
  });

  it('treats the same event id on a different topic as a different fact', async () => {
    const shared = 'eeeeeeee-0000-4000-8000-000000000001';
    const { processor, repository } = stack();

    await processor.process(
      eventMessage(Topics.USER_LOCKED, { userId: USER_ID, status: 'locked' }, { eventId: shared }),
    );
    await processor.process(eventMessage(Topics.PERMISSION_DENIED, deniedPayload, { eventId: shared }));

    expect(await repository.count()).toBe(2);
  });

  it('is idempotent across a redelivery on a later attempt', async () => {
    const { processor, repository } = stack();
    const eventId = 'ffffffff-0000-4000-8000-000000000001';

    await processor.process(
      eventMessage(Topics.PERMISSION_DENIED, deniedPayload, { eventId, attempt: 1 }),
    );
    const retry = await processor.process(
      eventMessage(Topics.PERMISSION_DENIED, deniedPayload, { eventId, attempt: 2 }),
    );

    expect(retry.kind).toBe('duplicate');
    expect(await repository.count()).toBe(1);
  });

  it('keeps two actors in two chains', async () => {
    const { processor, repository } = stack();

    await processor.process(eventMessage(Topics.PERMISSION_DENIED, deniedPayload));
    await processor.process(
      eventMessage(Topics.PERMISSION_DENIED, { ...deniedPayload, userId: OTHER_USER_ID }),
    );

    expect(await repository.count()).toBe(2);
    expect((await repository.partitionKeys()).sort()).toEqual(
      [`user.${OTHER_USER_ID}`, `user.${USER_ID}`].sort(),
    );
  });
});

describe('when storing the record fails', () => {
  it('releases the claim so the redelivery is not discarded as a duplicate', async () => {
    // Keeping the claim is the wrong answer: the redelivery would arrive as a "duplicate",
    // commit its offset, and the denial would never be audited — with no error anywhere.
    const { processor, repository, claims } = stack();
    repository.failNextAppend = new Error('deadlock detected');

    const outcome = await processor.process(eventMessage(Topics.PERMISSION_DENIED, deniedPayload));

    expect(outcome.kind).toBe('released');
    expect(claims.heldCount).toBe(0);
    expect(await repository.count()).toBe(0);
  });

  it('throws out of the consumer adapter so the broker redelivers', async () => {
    // The assertion the whole design turns on. A handler that returns normally makes the
    // shared consumer commit the offset, and the audit record is gone for good.
    const { adapter, repository, claims } = stack();
    repository.failNextAppend = new Error('connection reset by peer');

    await expect(
      adapter.handle(Topics.PERMISSION_DENIED, eventMessage(Topics.PERMISSION_DENIED, deniedPayload)),
    ).rejects.toThrow('released for retry');

    expect(claims.heldCount).toBe(0);
  });

  it('records the event on the next delivery', async () => {
    const { processor, repository } = stack();
    const message = eventMessage(Topics.PERMISSION_DENIED, deniedPayload);

    repository.failNextAppend = new Error('timeout');
    await processor.process(message);

    const retry = await processor.process(message);

    expect(retry.kind).toBe('recorded');
    expect(await repository.count()).toBe(1);
    // And the retried record is the only one in the chain, at position 1 — the failed attempt
    // left nothing behind to corrupt the sequence.
    expect((await repository.readPartition(`user.${USER_ID}`))[0].sequence).toBe(1);
  });

  it('keeps the original failure when the release itself fails', async () => {
    const { processor, repository, claims } = stack();
    repository.failNextAppend = new Error('the audit table is unavailable');
    claims.failNextRelease = new Error('the claim table is unreachable');

    const outcome = await processor.process(eventMessage(Topics.PERMISSION_DENIED, deniedPayload));

    // If the release error replaced the original, the operator would be told the claim table
    // is down when the real fault is the audit table.
    expect(outcome.kind).toBe('released');
    expect(outcome.kind === 'released' && outcome.detail).toBe(
      'the audit table is unavailable',
    );
  });
});

describe('a payload that cannot be understood', () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['a bare string', 'platform.permission.denied.v1'],
    ['an array', [1, 2, 3]],
    ['null', null],
    [
      'no eventId',
      { type: 'x', occurredAt: '2026-10-19T09:00:00.000Z', payload: {} },
    ],
    [
      'no type',
      { eventId: 'e', occurredAt: '2026-10-19T09:00:00.000Z', payload: {} },
    ],
    ['no occurredAt', { eventId: 'e', type: 'x', payload: {} }],
    [
      'an unparseable occurredAt',
      { eventId: 'e', type: 'x', occurredAt: 'yesterday', payload: {} },
    ],
    [
      'no object payload',
      { eventId: 'e', type: 'x', occurredAt: '2026-10-19T09:00:00.000Z' },
    ],
    [
      'an array payload',
      { eventId: 'e', type: 'x', occurredAt: '2026-10-19T09:00:00.000Z', payload: [] },
    ],
  ];

  it.each(malformed)('%s is dead-lettered rather than crashing the loop', async (_name, raw) => {
    const { processor, repository, claims } = stack();

    const outcome = await processor.process(
      eventMessage(Topics.PERMISSION_DENIED, {}, { raw }),
    );

    expect(outcome.kind).toBe('dead_lettered');
    expect(outcome.kind === 'dead_lettered' && outcome.reason).toBe('malformed-envelope');
    expect(await repository.count()).toBe(0);
    // No claim is taken for a message this service never understood: there is nothing to
    // release later, and nothing for a retry to finish.
    expect(claims.claimLog).toHaveLength(0);
  });

  it('publishes the poison message to the topic dead-letter sibling', async () => {
    const { adapter, published } = stack();

    await adapter.handle(
      Topics.PERMISSION_DENIED,
      eventMessage(Topics.PERMISSION_DENIED, {}, { raw: 'nonsense' }),
    );

    expect(published).toHaveLength(1);
    expect(published[0].topic).toBe('platform.permission.denied.v1.dlq');
    expect(JSON.parse(published[0].payload)).toMatchObject({
      topic: Topics.PERMISSION_DENIED,
      reason: 'malformed-envelope',
    });
  });

  it('does not throw for a poison message, so the partition keeps moving', async () => {
    // A handler that raises on a poison message leaves its offset uncommitted, so the broker
    // redelivers it forever and every event behind it stops being processed.
    const { adapter } = stack();

    await expect(
      adapter.handle(Topics.PERMISSION_DENIED, eventMessage(Topics.PERMISSION_DENIED, {}, { raw: 42 })),
    ).resolves.toMatchObject({ kind: 'dead_lettered' });
  });

  it('keeps the claim for a message the domain permanently rejects', async () => {
    const { processor, claims } = stack();
    claims.failNextClaim = new DomainError(
      'CONFLICTING_STATE',
      'the audit partition cannot be chained',
    );

    const outcome = await processor.process(eventMessage(Topics.PERMISSION_DENIED, deniedPayload));

    expect(outcome.kind).toBe('dead_lettered');
    expect(outcome.kind === 'dead_lettered' && outcome.reason).toBe('record-rejected');
    // A retry of a `DomainError` fails identically. Releasing would put a message that can
    // never be recorded into an unbounded retry loop.
    expect(claims.releaseLog).toHaveLength(0);
  });
});

describe('an event with no identifiable actor', () => {
  it('records it as anonymous rather than attributing it to nobody', async () => {
    const { processor, repository } = stack();

    // A `credential.failed` with no `userId`: a sign-in attempt for an address that has no
    // account, or the wrong one. Dropping it loses exactly the traffic a credential-stuffing
    // investigation starts from.
    await processor.process(
      eventMessage(Topics.CREDENTIAL_FAILED, { identifier: 'nobody@example.com', attempt: 3 }),
    );

    const [record] = await repository.readPartition('anonymous.anonymous');
    expect(record.actorType).toBe('anonymous');
    expect(record.actorId).toBe('anonymous');
    expect(record.resourceId).toBe('nobody@example.com');
    expect(record.action).toBe('credential.failed');
  });

  it('refuses a topic that cannot be audited without a subject', async () => {
    // `role.granted` with no user is not "anonymous" — it is a privilege grant attached to no
    // one, which is the exact shape of unexplained privilege escalation.
    const { processor, repository } = stack();

    const outcome = await processor.process(eventMessage(Topics.ROLE_GRANTED, { role: 'admin' }));

    expect(outcome.kind).toBe('dead_lettered');
    expect(outcome.kind === 'dead_lettered' && outcome.reason).toBe('unattributable-actor');
    expect(await repository.count()).toBe(0);
  });
});

describe('the record a security event becomes', () => {
  it('attributes a role grant to the administrator, not the recipient', async () => {
    const { processor, repository } = stack();

    // Recording `grantedBy` as the actor is the difference between "an admin granted this" and
    // "the user granted this to themselves", and only one of those is an audit trail.
    await processor.process(
      eventMessage(Topics.ROLE_GRANTED, {
        userId: USER_ID,
        role: 'admin',
        grantedBy: OTHER_USER_ID,
      }),
    );

    const [record] = await repository.readPartition(`user.${OTHER_USER_ID}`);
    expect(record.actorId).toBe(OTHER_USER_ID);
    expect(record.resourceId).toBe('admin');
    expect(record.action).toBe('role.granted');
  });

  it('reads the outcome of a security event from its risk level', async () => {
    const { processor, repository } = stack();

    await processor.process(
      eventMessage(Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED, {
        userId: USER_ID,
        type: 'suspicious_login_detected',
        riskScore: 91,
        riskLevel: 'high',
        factors: ['impossible_travel'],
      }),
    );

    const [record] = await repository.readPartition(`user.${USER_ID}`);
    expect(record.result).toBe('detected');
    expect(record.resourceType).toBe('session');
  });

  it('keeps the producer clock, not this service clock', async () => {
    const { processor, repository } = stack();
    const occurredAt = '2026-10-01T03:04:05.000Z';

    await processor.process(
      eventMessage(Topics.SESSION_REVOKED, {
        sessionId: 'cccccccc-0000-4000-8000-000000000003',
        userId: USER_ID,
        reason: 'user requested',
      }, { occurredAt }),
    );

    const [record] = await repository.readPartition(`user.${USER_ID}`);
    expect(record.occurredAt.toISOString()).toBe(occurredAt);
    // `received_at` is this service's clock, and the gap between the two is the difference
    // between "the system was down" and "the system was lying about the time".
    expect(record.receivedAt.getTime()).toBeGreaterThanOrEqual(
      Date.parse(occurredAt),
    );
  });
});