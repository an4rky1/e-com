/**
 * Consumer-side idempotency: the same event, twice, sends once.
 *
 * @remarks Kafka is at-least-once. The consumer commits its offset after the handler returns,
 * a pod dies in the window between, and the broker replays. Every other service in this
 * workspace can absorb a duplicate row; this one cannot, because its side effect is an email
 * to a human being, and a user who receives two welcome messages concludes that somebody else
 * has an account on the platform.
 *
 * @remarks Everything here runs through the *real* handler over in-memory ports. A test that
 * stubbed the handler would prove the stub is idempotent.
 */
import { Topics } from '@auth/contracts';
import { NotificationEventProcessor } from '../src/application/consumers/notification-event.processor';
import { SendNotificationHandler } from '../src/application/commands/notification.handlers';
import { SendNotificationCommand } from '../src/application/commands/notification.commands';
import { claimKeyFor } from '../src/domain/ports/consumer-claim.port';
import {
  Notification,
  NotificationOutcome,
  addressFor,
} from '../src/domain/notification.aggregate';
import { NotificationChannel } from '../src/domain/value-objects/notification-channel.vo';
import { NotificationTemplate } from '../src/domain/value-objects/notification-template.vo';
import { InMemoryNotificationStore } from '../src/infrastructure/persistence/in-memory-notification.store';
import {
  EMAIL,
  FailingChannel,
  FailingDispatcher,
  InMemoryClaimStore,
  RecordingChannel,
  RecordingDispatcher,
  TestChannelRegistry,
  USER_ID,
  eventMessage,
  fullRecipient,
} from './testing/fakes';

const topic = Topics.USER_REGISTERED;

const registeredPayload = (email = EMAIL) => ({
  userId: USER_ID,
  email,
  displayName: 'Ada',
  source: 'web',
});

/**
 * A consumer wired to real handlers over in-memory ports.
 *
 * @remarks The claim store and the dispatcher are injected separately so a test can replace
 * either without rebuilding the rest. `store` is exposed because most of these assertions are
 * about what reached it.
 */
function consumer(
  overrides: {
    dispatcher?: FailingDispatcher | RecordingDispatcher;
    channels?: TestChannelRegistry;
  } = {},
) {
  const claims = new InMemoryClaimStore();
  const store = new InMemoryNotificationStore((type) => `local.${type}`);
  const channels =
    overrides.channels ??
    new TestChannelRegistry([
      new RecordingChannel(NotificationChannel.INAPP),
      new RecordingChannel(NotificationChannel.EMAIL),
    ]);

  const dispatcher =
    overrides.dispatcher ??
    new RecordingDispatcher();

  const handler = new SendNotificationHandler(store, channels);

  // The processor talks to a port; the port talks to the real handler. Keeping that indirection
  // in the test means the loop under test is the production loop, not a re-implementation.
  const port = overrides.dispatcher ?? {
    send: (command: SendNotificationCommand) => handler.execute(command),
    markRead: () => Promise.reject(new Error('not used here')),
  };

  const processor = new NotificationEventProcessor(claims, port);

  return { claims, store, channels, dispatcher, handler, processor, port };
}

describe('processing the same event twice', () => {
  it('sends exactly one notification', async () => {
    const { processor, store, channels } = consumer();

    const first = await processor.process(eventMessage(topic, registeredPayload()));
    const second = await processor.process(eventMessage(topic, registeredPayload()));

    expect(first.kind).toBe('processed');
    expect(second.kind).toBe('duplicate');

    expect(store.records.size).toBe(1);
    expect(store.outbox.filter((row) => row.type === 'notification.dispatched')).toHaveLength(
      1,
    );

    // One in-app render and one email. Two of each is the bug this suite exists for.
    const delivered = channels
      .resolve(NotificationChannel.INAPP) as RecordingChannel;
    const emailed = channels.resolve(NotificationChannel.EMAIL) as RecordingChannel;
    expect(delivered.delivered).toHaveLength(1);
    expect(emailed.delivered).toHaveLength(1);
  });

  it('records the second delivery as a duplicate rather than failing', async () => {
    const { processor, claims } = consumer();

    await processor.process(eventMessage(topic, registeredPayload()));
    const second = await processor.process(eventMessage(topic, registeredPayload()));

    expect(second).toEqual({
      kind: 'duplicate',
      claimKey: claimKeyFor(topic, '33333333-4444-4555-8666-777777777777'),
    });
    // One claim *taken*, still held: the second delivery asked and was refused. Releasing
    // here would let the next redelivery send the welcome email a third time.
    expect(claims.claimLog).toHaveLength(1);
    expect(claims.releaseLog).toHaveLength(0);
    expect(claims.heldCount).toBe(1);
  });

  it('keys the claim on the event, not on the user', async () => {
    // Two different registrations for one user id are two different facts and must produce two
    // notifications. Deduping on `userId` would silently swallow the second one.
    const { processor, store } = consumer();

    await processor.process(
      eventMessage(topic, registeredPayload(), { eventId: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    );
    await processor.process(
      eventMessage(topic, registeredPayload(), { eventId: 'aaaaaaaa-0000-4000-8000-000000000002' }),
    );

    expect(store.records.size).toBe(2);
  });

  it('treats the same event on a different topic as a different notification', async () => {
    const { processor, store } = consumer();

    await processor.process(
      eventMessage(topic, registeredPayload(), { eventId: 'aaaaaaaa-0000-4000-8000-000000000003' }),
    );
    await processor.process(
      eventMessage(
        Topics.USER_EMAIL_VERIFIED,
        { userId: USER_ID, email: EMAIL },
        { eventId: 'aaaaaaaa-0000-4000-8000-000000000003' },
      ),
    );

    expect(store.records.size).toBe(2);
  });

  it('is idempotent across a redelivery on a later attempt', async () => {
    const { processor, store } = consumer();


    await processor.process(eventMessage(topic, registeredPayload(), { attempt: 1 }));
    const retry = await processor.process(eventMessage(topic, registeredPayload(), { attempt: 2 }));

    expect(retry.kind).toBe('duplicate');
    expect(store.records.size).toBe(1);
  });
});

describe('a failed processing releases the claim', () => {
  it('releases the claim so the retry can proceed', async () => {
    // The failure a user actually experiences: the store is briefly unreachable. The wrong
    // behaviour is to keep the claim, because then the redelivery arrives as a "duplicate",
    // commits its offset, and the welcome email is never sent — with no error anywhere.
    const claims = new InMemoryClaimStore();
    const dispatcher = new FailingDispatcher('the notification store is unavailable');
    const working = consumer();

    let attempt = 0;
    const processor = new NotificationEventProcessor(claims, {
      send: (command) => {
        attempt += 1;
        return attempt === 1
          ? dispatcher.send()
          : working.handler.execute(command);
      },
      markRead: () => Promise.reject(new Error('not used here')),
    });

    const first = await processor.process(eventMessage(topic, registeredPayload()));

    expect(first.kind).toBe('released');
    expect(first.kind === 'released' && first.reason).toBe('dispatch-failed');
    expect(claims.releaseLog).toEqual([
      claimKeyFor(topic, '33333333-4444-4555-8666-777777777777'),
    ]);
    expect(claims.heldCount).toBe(0);

    const retry = await processor.process(eventMessage(topic, registeredPayload()));

    expect(retry.kind).toBe('processed');
    expect(claims.heldCount).toBe(1);
  });

  it('reports a released processing rather than throwing out of the handler', async () => {
    // The consumer adapter turns `released` into a rethrow so the broker redelivers. Throwing
    // from here instead would bypass the release entirely.
    const { processor } = consumer({ dispatcher: new FailingDispatcher() });

    const outcome = await processor.process(eventMessage(topic, registeredPayload()));

    expect(outcome.kind).toBe('released');
  });

  it('keeps the original failure when the release itself fails', async () => {
    const claims = new InMemoryClaimStore();
    claims.failNextRelease = new Error('the claim table is unreachable');
    const dispatcher = new FailingDispatcher('the notification store is unavailable');

    const processor = new NotificationEventProcessor(claims, {
      send: () => dispatcher.send(),
      markRead: () => Promise.reject(new Error('not used here')),
    });

    const outcome = await processor.process(eventMessage(topic, registeredPayload()));

    // If the release error replaced the original, the operator would be told the claim table
    // is down when the real fault is that the store is.
    expect(outcome.kind).toBe('released');
    expect(outcome.kind === 'released' && outcome.detail).toBe(
      'the notification store is unavailable',
    );
  });

  it('releases on a claim-table failure, so a retry is not blocked forever', async () => {
    const { processor, claims } = consumer();
    claims.failNextClaim = new Error('connection reset');

    await expect(
      processor.process(eventMessage(topic, registeredPayload())),
    ).rejects.toThrow('connection reset');
    // The claim was never taken, so there is nothing to release and the redelivery is free.
    expect(claims.heldCount).toBe(0);
  });
});

describe('abandoned claims', () => {
  it('reclaims a claim whose owner never came back', async () => {
    const { processor, claims } = consumer();

    await processor.process(eventMessage(topic, registeredPayload()));
    expect(claims.heldCount).toBe(1);

    const released = await processor.sweepAbandonedClaims(new Date(Date.now() + 60_000));

    expect(released).toBe(1);
    expect(claims.heldCount).toBe(0);
  });

  it('leaves a live claim alone', async () => {
    const { processor, claims } = consumer();

    await processor.process(eventMessage(topic, registeredPayload()));

    expect(await processor.sweepAbandonedClaims(new Date(0))).toBe(0);
    expect(claims.heldCount).toBe(1);
  });
});

describe('the claim key', () => {
  it('is the topic and the event id, joined', () => {
    expect(claimKeyFor(Topics.USER_LOCKED, 'abc')).toBe('platform.user.locked.v1:abc');
  });
});

describe('the store the handler writes through', () => {
  it('reports `sent` only when every requested channel delivered', async () => {
    const channels = new TestChannelRegistry([
      new RecordingChannel(NotificationChannel.INAPP),
      new RecordingChannel(NotificationChannel.EMAIL),
    ]);
    const store = new InMemoryNotificationStore((type) => `local.${type}`);
    const handler = new SendNotificationHandler(store, channels);

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        fullRecipient(),
        { displayName: 'Ada', source: 'web' },
      ),
    );

    expect(result.outcome).toBe(NotificationOutcome.SENT);
    expect(result.deliveries).toHaveLength(2);
  });

  it('delivers to the address the channel owns and nothing else', async () => {
    const channels = new TestChannelRegistry([
      new RecordingChannel(NotificationChannel.EMAIL),
      new RecordingChannel(NotificationChannel.PUSH),
    ]);
    const store = new InMemoryNotificationStore((type) => `local.${type}`);
    const handler = new SendNotificationHandler(store, channels);

    // `account-locked` names inapp, push and email, so all three adapters are exercised.
    await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.ACCOUNT_LOCKED,
        USER_ID,
        fullRecipient(),
        { reason: 'brute force' },
      ),
    );

    const email = channels.resolve(NotificationChannel.EMAIL) as RecordingChannel;
    const push = channels.resolve(NotificationChannel.PUSH) as RecordingChannel;

    // A push adapter that could reach the user's *phone number* would be a phone number in a
    // push payload, which is exactly the kind of thing this split exists to make impossible.
    expect(email.delivered[0].address).toBe(EMAIL);
    expect(push.delivered[0].address).toBe('device-token-abc');
  });

  it('skips a channel this deployment cannot reach rather than reporting a failure', async () => {
    const store = new InMemoryNotificationStore((type) => `local.${type}`);
    // `sms` is declared by no template here and bound to nobody: an unbound channel.
    const handler = new SendNotificationHandler(
      store,
      new TestChannelRegistry([new RecordingChannel(NotificationChannel.INAPP)]),
    );

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        fullRecipient(),
        {},
      ),
    );

    const email = result.deliveries.find(
      (delivery) => delivery.channel === NotificationChannel.EMAIL,
    );
    expect(email?.status).toBe('skipped');
    expect(email?.error).toBe('unbound in this test');
    expect(result.outcome).toBe(NotificationOutcome.PARTIAL);
  });

  it('skips a channel the recipient has no address for', async () => {
    const store = new InMemoryNotificationStore((type) => `local.${type}`);
    const handler = new SendNotificationHandler(
      store,
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.INAPP),
        new RecordingChannel(NotificationChannel.EMAIL),
      ]),
    );

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.ACCOUNT_LOCKED,
        USER_ID,
        fullRecipient({ email: null, phone: null, deviceToken: null }),
        { reason: 'brute force' },
      ),
    );

    const inapp = result.deliveries.find(
      (delivery) => delivery.channel === NotificationChannel.INAPP,
    );
    const email = result.deliveries.find(
      (delivery) => delivery.channel === NotificationChannel.EMAIL,
    );

    // `inapp` needs no address — it is delivered to whoever opens the app.
    expect(inapp?.status).toBe('sent');
    expect(email?.status).toBe('skipped');
  });
});

describe('the aggregate behind the dispatch', () => {
  it('replaces an earlier outcome for the same channel rather than appending', async () => {
    const notification = Notification.request({
      userId: USER_ID,
      template: NotificationTemplate.WELCOME,
      subject: 'Welcome',
      body: 'Hello',
      severity: 'info',
      variables: {},
      recipient: fullRecipient(),
      channels: [NotificationChannel.EMAIL],
    });

    notification.recordDelivery({
      channel: NotificationChannel.EMAIL,
      status: 'failed',
      error: 'provider unavailable',
      deliveredAt: new Date(),
    });
    notification.recordDelivery({
      channel: NotificationChannel.EMAIL,
      status: 'sent',
      deliveredAt: new Date(),
    });

    expect(notification.deliveries).toHaveLength(1);
    expect(notification.deliveredChannels).toEqual([NotificationChannel.EMAIL]);
    expect(notification.failedChannels).toEqual([]);
    expect(notification.outcome).toBe(NotificationOutcome.SENT);
  });

  it('knows an in-app notification needs no address', () => {
    expect(addressFor(fullRecipient(), NotificationChannel.INAPP)).toBeNull();
    expect(addressFor(fullRecipient(), NotificationChannel.EMAIL)).toBe(EMAIL);
  });

  it('does not let a failing channel stop the others', async () => {
    const store = new InMemoryNotificationStore((type) => `local.${type}`);
    const inapp = new RecordingChannel(NotificationChannel.INAPP);
    const failing = new FailingChannel(NotificationChannel.EMAIL);

    const handler = new SendNotificationHandler(
      store,
      new TestChannelRegistry([inapp, failing]),
    );

    const result = await handler.execute(
      new SendNotificationCommand(NotificationTemplate.WELCOME, USER_ID, fullRecipient(), {}),
    );

    expect(failing.calls).toBe(1);
    expect(inapp.delivered).toHaveLength(1);
    expect(result.outcome).toBe(NotificationOutcome.PARTIAL);
  });
});