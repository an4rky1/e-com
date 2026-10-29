/**
 * A malformed message is dead-lettered. It is never thrown at the consumer loop.
 *
 * @remarks This is the requirement with the worst failure mode when it is ignored. The shared
 * consumer rethrows whatever a handler raises, specifically so an offset does not commit
 * while its effect is missing. That is correct for a *transient* failure and catastrophic for
 * a *poison message*: the offset stays uncommitted, the broker redelivers, and every event
 * behind that message on the same partition stops being processed. One unparseable payload
 * becomes an outage for everyone downstream of the partition.
 *
 * @remarks So the split is by cause, not by severity. Anything that cannot succeed on a retry
 * is dead-lettered and committed. Only failures a retry could fix propagate — and those
 * release their claim first.
 */
import { Topics } from '@auth/contracts';
import { NotificationKafkaConsumer } from '../src/infrastructure/messaging/notification.kafka.consumer';
import {
  ConsumerOutcomeKind,
  NotificationEventProcessor,
  parseEnvelope,
} from '../src/application/consumers/notification-event.processor';
import { compileTemplate } from '../src/domain/templates/notification-templates';
import { NotificationTemplate } from '../src/domain/value-objects/notification-template.vo';
import {
  EMAIL,
  InMemoryClaimStore,
  RecordingDispatchQueue,
  USER_ID,
  eventMessage,
  rawMessage,
  testNotificationConfig,
} from './testing/fakes';
import { rejection } from './testing/helpers';
import type { ConsumedMessage } from '@auth/infra/kafka';

/**
 * A processor with nothing behind it, so a dead letter cannot be a side effect of sending.
 *
 * @remarks The queue it gets would record an instruction if one were ever ordered — which is
 * exactly what the dead-letter assertions below are proving never happens.
 */
function bareProcessor() {
  const claims = new InMemoryClaimStore();
  const queue = new RecordingDispatchQueue();
  const processor = new NotificationEventProcessor(claims, queue);
  return { claims, queue, processor };
}

describe('envelope parsing', () => {
  it.each([
    ['a string', 'not an event'],
    ['null', null],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['an object with no eventId', { type: Topics.USER_REGISTERED, payload: {} }],
    ['an object with a blank eventId', { eventId: '   ', type: 't', payload: {} }],
    ['an object with no type', { eventId: 'e', payload: {} }],
    ['an object with no payload', { eventId: 'e', type: 't' }],
    ['an object whose payload is an array', { eventId: 'e', type: 't', payload: [] }],
    ['an object whose payload is null', { eventId: 'e', type: 't', payload: null }],
  ])('refuses %s', (_what, payload) => {
    expect(parseEnvelope(payload)).toBeNull();
  });

  it('accepts a well-formed envelope and trims its strings', () => {
    const parsed = parseEnvelope({
      eventId: '  33333333-4444-4555-8666-777777777777  ',
      type: ' platform.user.registered.v1 ',
      payload: { userId: USER_ID },
    });

    expect(parsed).toEqual({
      eventId: '33333333-4444-4555-8666-777777777777',
      type: 'platform.user.registered.v1',
      payload: { userId: USER_ID },
    });
  });
});

describe('a malformed payload', () => {
  it('is dead-lettered rather than thrown', async () => {
    const { processor } = bareProcessor();

    const outcome = await processor.process(
      rawMessage(Topics.USER_REGISTERED, { this: 'is not an event' }),
    );

    expect(outcome.kind).toBe(ConsumerOutcomeKind.DEAD_LETTERED);
    expect(outcome.kind === 'dead_lettered' && outcome.reason).toBe('malformed-envelope');
  });

  it('does not throw out of the handler', async () => {
    // The assertion is the absence of a rejection. A `rejects` expectation here would be the
    // bug.
    const { processor } = bareProcessor();

    await expect(
      processor.process(rawMessage(Topics.USER_REGISTERED, undefined)),
    ).resolves.toBeDefined();
    await expect(
      processor.process(rawMessage(Topics.USER_REGISTERED, 'a bare string')),
    ).resolves.toBeDefined();
  });

  it('takes no claim for a message it could not even identify', async () => {
    // A claim needs an event id. Claiming on the offset would be claiming on a topic partition
    // rather than on an event, and the second genuine copy of that event would be discarded.
    const { claims, processor } = bareProcessor();

    await processor.process(rawMessage(Topics.USER_REGISTERED, { junk: true }));

    expect(claims.claimLog).toHaveLength(0);
  });
});

describe('a payload the producer got wrong', () => {
  it('is dead-lettered when it names no user', async () => {
    const { processor } = bareProcessor();

    const outcome = await processor.process(
      eventMessage(Topics.USER_REGISTERED, { email: EMAIL, source: 'web' }),
    );

    expect(outcome.kind).toBe('dead_lettered');
    expect(outcome.kind === 'dead_lettered' && outcome.reason).toBe('no-recipient-identity');
  });

  it('is dead-lettered when a template rejects its variables, and keeps its claim', async () => {
    // Keeping the claim is the point: the same payload fails identically on every
    // redelivery, so releasing it would buy a retry loop that never converges.
    const claims = new InMemoryClaimStore();
    const queue = new RecordingDispatchQueue();
    const processor = new NotificationEventProcessor(claims, queue);

    // `riskLevel` is not one of the declared values.
    const outcome = await processor.process(
      eventMessage(Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED, {
        userId: USER_ID,
        riskLevel: 'apocalyptic',
        riskScore: 10,
        ipAddress: '198.51.100.1',
      }),
    );

    expect(outcome.kind).toBe('dead_lettered');
    expect(outcome.kind === 'dead_lettered' && outcome.reason).toBe('template-rejected');
    expect(claims.releaseLog).toHaveLength(0);
    expect(claims.heldCount).toBe(1);
    // Rejected before anything was ordered: a dispatch job for variables the schema refused
    // would fail in the worker, where nobody can name the producer that sent them.
    expect(queue.enqueued).toHaveLength(0);
  });

  it('is dead-lettered, naming the topic, when no route exists for it', async () => {
    // Only reachable by calling `process` with a topic the consumer does not subscribe to —
    // which is exactly what happens if somebody widens the subscription without adding a
    // route. Naming it turns a silent no-op into a visible wiring bug.
    const { claims, processor } = bareProcessor();

    const outcome = await processor.process(
      eventMessage(Topics.SESSION_ISSUED, { sessionId: 's-1', userId: USER_ID }),
    );

    expect(outcome.kind).toBe('dead_lettered');
    expect(outcome.kind === 'dead_lettered' && outcome.reason).toBe('no-route');
    expect(outcome.kind === 'dead_lettered' && outcome.detail).toContain(
      Topics.SESSION_ISSUED,
    );
    // Claimed before the routing decision, and kept: a message with no route is processed.
    expect(claims.heldCount).toBe(1);
  });
});

describe('the Kafka adapter turns outcomes into offset decisions', () => {
  /** A producer that records what it was asked to publish. */
  const recordingProducer = () => {
    const sent: { topic: string; payload: string }[] = [];
    return {
      sent,
      send: async (topic: string, payload: string) => {
        sent.push({ topic, payload });
      },
    };
  };

  /** A consumer double that records what it was asked to subscribe to. */
  const recordingConsumer = () => {
    const handlers = new Map<string, (m: ConsumedMessage<unknown>) => Promise<void>>();
    return {
      handlers,
      register: (topic: string, handler: (m: ConsumedMessage<unknown>) => Promise<void>) => {
        handlers.set(topic, handler);
      },
    };
  };

  const build = (processor: NotificationEventProcessor, producer = recordingProducer()) => {
    const consumer = recordingConsumer();
    const adapter = new NotificationKafkaConsumer(
      consumer as never,
      producer as never,
      processor,
      testNotificationConfig(),
    );
    return { adapter, consumer, producer };
  };

  it('publishes a dead-lettered message to the topic dlq sibling', async () => {
    const { processor } = bareProcessor();
    const { adapter, producer } = build(processor);

    await adapter.handle(
      Topics.USER_REGISTERED,
      rawMessage(Topics.USER_REGISTERED, { junk: true }),
    );

    expect(producer.sent).toHaveLength(1);
    expect(producer.sent[0].topic).toBe('platform.user.registered.v1.dlq');
    expect(JSON.parse(producer.sent[0].payload)).toMatchObject({
      topic: Topics.USER_REGISTERED,
      reason: 'malformed-envelope',
    });
  });

  it('publishes nothing for a duplicate, and commits', async () => {
    const processor = new NotificationEventProcessor(
      new InMemoryClaimStore(),
      new RecordingDispatchQueue(),
    );
    const { adapter, producer } = build(processor);

    const message = eventMessage(Topics.USER_REGISTERED, { userId: USER_ID });

    await adapter.handle(Topics.USER_REGISTERED, message);
    const second = await adapter.handle(Topics.USER_REGISTERED, message);

    expect(second.kind).toBe(ConsumerOutcomeKind.DUPLICATE);
    // A duplicate is a normal outcome, not a problem, so it reaches neither the dlq nor a
    // throw. Both would turn every replayed event into noise.
    expect(producer.sent).toHaveLength(0);
  });

  it('rethrows a released outcome, so the broker redelivers', async () => {
    const claims = new InMemoryClaimStore();
    const queue = new RecordingDispatchQueue();
    queue.failNextEnqueue = new Error('redis is unavailable');
    const processor = new NotificationEventProcessor(claims, queue);
    const { adapter, producer } = build(processor);

    const error = await rejection(
      adapter.handle(
        Topics.USER_REGISTERED,
        eventMessage(Topics.USER_REGISTERED, { userId: USER_ID }),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('released for retry');
    // The claim is already gone, which is what makes the redelivery worth doing.
    expect(claims.heldCount).toBe(0);
    expect(producer.sent).toHaveLength(0);
  });

  it('does not crash the loop when the dlq publish itself fails', async () => {
    const { processor } = bareProcessor();
    const consumer = recordingConsumer();
    const adapter = new NotificationKafkaConsumer(
      consumer as never,
      { send: () => Promise.reject(new Error('the broker is down')) } as never,
      processor,
      testNotificationConfig(),
    );

    await expect(
      adapter.handle(
        Topics.USER_REGISTERED,
        rawMessage(Topics.USER_REGISTERED, { junk: true }),
      ),
    ).resolves.toBeDefined();
  });

  it('drops the dead letter, loudly, when dead-lettering is disabled', async () => {
    const { processor } = bareProcessor();
    const consumer = recordingConsumer();
    const adapter = new NotificationKafkaConsumer(
      consumer as never,
      { send: () => Promise.reject(new Error('should not be called')) } as never,
      processor,
      testNotificationConfig({ deadLetterEnabled: false }),
    );

    await expect(
      adapter.handle(
        Topics.USER_REGISTERED,
        rawMessage(Topics.USER_REGISTERED, { junk: true }),
      ),
    ).resolves.toBeDefined();
  });

  it('subscribes only to the routed topics', () => {
    const { processor } = bareProcessor();
    const { adapter, consumer } = build(processor);

    adapter.onModuleInit();

    expect(consumer.handlers.has(Topics.USER_REGISTERED)).toBe(true);
    expect(consumer.handlers.has(Topics.SECURITY_ANOMALY_DETECTED)).toBe(true);
    expect(consumer.handlers.has(Topics.SESSION_ISSUED)).toBe(false);
    expect(consumer.handlers.size).toBe(17);
  });

  it('leaves a poisoned record for retry when the downstream failure is not permanent', async () => {
    // A DomainError from the template schema is permanent and is dead-lettered; anything else
    // — here, Redis being unreachable at the enqueue — may succeed on a redelivery, so the
    // claim is released rather than kept. The adapter half of the contract, the rethrow that
    // keeps the offset uncommitted, is "rethrows a released outcome" above.
    const claims = new InMemoryClaimStore();
    const queue = new RecordingDispatchQueue();
    queue.failNextEnqueue = new Error('redis is unavailable');
    const processor = new NotificationEventProcessor(claims, queue);

    // A well-formed payload: a producer mistake would be a different test, dead-lettered.
    const outcome = await processor.process(
      eventMessage(Topics.USER_REGISTERED, { userId: USER_ID, displayName: 'Ada' }),
    );

    expect(outcome.kind).toBe('released');
    expect(outcome.kind === 'released' && outcome.reason).toBe('enqueue-failed');
    expect(outcome.kind === 'released' && outcome.detail).toBe('redis is unavailable');
    expect(claims.releaseLog).toHaveLength(1);
    expect(claims.heldCount).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });
});

describe('the template schema is what makes a bad payload visible', () => {
  it('strips a key the template does not declare rather than rejecting the payload', () => {
    // Not a validation failure on purpose. A producer that adds an address to a payload must
    // not be able to make the notification break; it must simply not reach the variables.
    const compiled = compileTemplate(NotificationTemplate.ACCOUNT_DELETED, {
      email: EMAIL,
      resetToken: 'kZ9x_Q2mB7pL4nR8vT1wY6zX3aC5dF0gH2jK4lM',
    });

    expect(compiled.variables).toEqual({});
    expect(compiled.redacted).toEqual(['email', 'resetToken']);
    expect(compiled.body).not.toContain(EMAIL);
  });

  it('reports the variables the content guard removed', () => {
    const compiled = compileTemplate(NotificationTemplate.WELCOME, {
      displayName: 'Ada',
      email: EMAIL,
    });

    // `source` is filled in by the template's declared default — the suite in
    // notification-templates.spec owns that contract; what this test owns is that the
    // address was named in `redacted` and kept out of the variables.
    expect(compiled.variables).toEqual({ displayName: 'Ada', source: 'web' });
    expect(compiled.redacted).toEqual(['email']);
  });
});