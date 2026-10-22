/**
 * @fileoverview Redaction: the failure that outlives everything else.
 *
 * @remarks An audit log is the longest-lived store in the platform. It outlives the retention
 * window of every log aggregator, every backup rotation and every incident ticket — which is
 * exactly what makes it worth writing, and exactly what makes it the worst possible place for a
 * plaintext credential. A password in a log line is gone in thirty days; a password in the
 * audit trail is still there when the compliance question is asked two years later.
 *
 * @remarks These assertions run against `SENSITIVE_FIELDS`, the platform's own deny-list,
 * rather than a second copy. A second list drifts — it is one more place to add a field — and
 * a field in one list and not the other is a secret that is redacted in logs and stored in
 * plaintext in the one store nobody prunes.
 */
import { SENSITIVE_FIELDS } from '@auth/platform/error-handling';
import { Topics } from '@auth/contracts';
import { redactPayload } from '../src/application/consumers/audit-event.processor';
import { RecordAuditEventHandler } from '../src/application/commands/record-audit-event.handler';
import { AuditEventProcessor } from '../src/application/consumers/audit-event.processor';
import { partitionKeyFor } from '../src/domain/value-objects/audit-partition.vo';
import { ActorType } from '../src/domain/value-objects/audit-result.vo';
import {
  HandlerBackedRecorder,
  InMemoryAuditRepository,
  InMemoryIdempotencyStore,
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
  return { repository, claims, processor };
}

describe('redacting a payload before it is stored', () => {
  it('strips the credentials an auth event can plausibly carry', () => {
    const cleaned = redactPayload({
      userId: USER_ID,
      password: 'correct horse battery staple',
      newPassword: 'hunter2',
      currentPassword: 'hunter1',
      accessToken: 'eyJhbGciOi...',
      refreshToken: 'rt_9f2...',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      backupCode: '1234-5678',
      cookie: 'session=abc',
      authorization: 'Bearer abc',
      apiKey: 'ak_live_...',
      cvv: '411',
    });

    expect(cleaned['userId']).toBe(USER_ID);
    for (const field of [
      'password',
      'newPassword',
      'currentPassword',
      'accessToken',
      'refreshToken',
      'totpSecret',
      'backupCode',
      'cookie',
      'authorization',
      'apiKey',
      'cvv',
    ]) {
      expect({ field, value: cleaned[field] }).toEqual({ field, value: '[REDACTED]' });
    }
  });

  it('strips them at any depth', () => {
    const cleaned = redactPayload({
      context: {
        request: {
          headers: { authorization: 'Bearer abc', accept: 'application/json' },
        },
        retries: [{ password: 'again' }],
      },
    });

    const context = cleaned['context'] as Record<string, Record<string, Record<string, string>>>;
    expect(context['request']['headers']['authorization']).toBe('[REDACTED]');
    // Everything that is not a secret survives: redaction that destroyed the record would be
    // its own kind of data loss, and an audit entry that cannot say what happened is useless.
    expect(context['request']['headers']['accept']).toBe('application/json');
  });

  it('covers every field the platform deny-list names', () => {
    // If the platform adds a field, this fails rather than quietly storing it in the clear.
    for (const field of SENSITIVE_FIELDS) {
      expect({ field, value: redactPayload({ [field]: 'secret' })[field] }).toEqual({
        field,
        value: '[REDACTED]',
      });
    }
  });

  it('leaves an ordinary payload alone', () => {
    const cleaned = redactPayload({
      userId: USER_ID,
      permission: 'reports.export',
      reason: 'insufficient role',
      attempt: 3,
      factors: ['impossible_travel'],
    });

    expect(cleaned).toEqual({
      userId: USER_ID,
      permission: 'reports.export',
      reason: 'insufficient role',
      attempt: 3,
      factors: ['impossible_travel'],
    });
  });

  it('collapses a cycle rather than recursing forever', () => {
    const cyclic: Record<string, unknown> = { userId: USER_ID };
    cyclic['self'] = cyclic;

    expect(redactPayload(cyclic)['self']).toBe('[Circular]');
  });

  it('has already redacted what reaches storage', async () => {
    // The end-to-end version: not "the function redacts" but "the record on disk is redacted".
    const { processor, repository } = stack();

    await processor.process(
      eventMessage(Topics.CREDENTIAL_FAILED, {
        userId: USER_ID,
        identifier: 'ada@example.com',
        attempt: 2,
        password: 'correct horse battery staple',
        refreshToken: 'rt_9f2...',
      }),
    );

    const [record] = await repository.readPartition(`user.${USER_ID}`);
    const stored = JSON.stringify(record);

    expect(record.payload['password']).toBe('[REDACTED]');
    expect(record.payload['identifier']).toBe('ada@example.com');
    expect(stored).not.toContain('correct horse battery staple');
    expect(stored).not.toContain('rt_9f2');
  });

  it('keeps a credential failure attributable even though the credential is stripped', async () => {
    // `identifier` is not on the deny-list and must not be: "which account is being targeted"
    // is the first question a credential-stuffing investigation asks, and redacting it would
    // make the record useless while removing nothing sensitive.
    const { processor, repository } = stack();

    await processor.process(
      eventMessage(Topics.CREDENTIAL_FAILED, {
        identifier: 'ada@example.com',
        attempt: 7,
      }),
    );

    const [record] = await repository.readPartition('anonymous.anonymous');
    expect(record.payload['identifier']).toBe('ada@example.com');
    expect(record.payload['attempt']).toBe(7);
  });
});

describe('partitioning the chain', () => {
  it('gives an identified actor one chain, forever', () => {
    const at = new Date('2026-10-19T09:00:00.000Z');

    expect(partitionKeyFor('actor', ActorType.USER, USER_ID, at)).toBe(`user.${USER_ID}`);
    // A month later, the same key: "has anything about this user ever been altered" is one
    // walk, not one per day.
    expect(partitionKeyFor('actor', ActorType.USER, USER_ID, new Date('2026-11-19T09:00:00.000Z'))).toBe(
      `user.${USER_ID}`,
    );
  });

  it('rolls anonymous actors by UTC day rather than contending on one row', () => {
    // Every unauthenticated failure in the platform landing on one chain key would serialise
    // every write behind a single row lock — precisely what partitioning exists to prevent.
    const monday = new Date('2026-10-19T09:00:00.000Z');
    const tuesday = new Date('2026-10-20T09:00:00.000Z');

    expect(partitionKeyFor('actor', ActorType.ANONYMOUS, 'anonymous', monday)).toBe(
      'anonymous.anonymous',
    );
    expect(partitionKeyFor('actor_day', ActorType.ANONYMOUS, 'anonymous', monday)).toBe(
      'anonymous.anonymous.2026-10-19',
    );
    expect(partitionKeyFor('actor_day', ActorType.ANONYMOUS, 'anonymous', tuesday)).toBe(
      'anonymous.anonymous.2026-10-20',
    );
  });

  it('buckets by UTC, not by the host clock', () => {
    // Two replicas in two time zones must agree on which chain a record belongs to, or the
    // record lands in a partition the other replica does not know about.
    const lateEvening = new Date('2026-10-19T23:59:59.000Z');
    const justAfter = new Date('2026-10-20T00:00:00.000Z');

    expect(partitionKeyFor('actor_day', ActorType.USER, USER_ID, lateEvening)).toBe(
      `user.${USER_ID}.2026-10-19`,
    );
    expect(partitionKeyFor('actor_day', ActorType.USER, USER_ID, justAfter)).toBe(
      `user.${USER_ID}.2026-10-20`,
    );
  });

  it('separates an actor from a system action with the same identifier', () => {
    const at = new Date('2026-10-19T09:00:00.000Z');

    expect(partitionKeyFor('actor', ActorType.USER, 'svc', at)).not.toBe(
      partitionKeyFor('actor', ActorType.SYSTEM, 'svc', at),
    );
  });

  it('routes every record for one actor to one chain, whatever the topic', async () => {
    const { processor, repository } = stack();

    await processor.process(eventMessage(Topics.PERMISSION_DENIED, { userId: USER_ID, permission: 'a', reason: 'r' }));
    await processor.process(eventMessage(Topics.USER_LOCKED, { userId: USER_ID, status: 'locked' }));
    await processor.process(eventMessage(Topics.SESSION_REVOKED, { sessionId: 's-1', userId: USER_ID, reason: 'x' }));

    const chain = await repository.readPartition(`user.${USER_ID}`);
    expect(chain.map((record) => record.sequence)).toEqual([1, 2, 3]);
    // And the chain still verifies: three topics, one hash chain.
    expect((await repository.verify(`user.${USER_ID}`)).ok).toBe(true);
  });
});