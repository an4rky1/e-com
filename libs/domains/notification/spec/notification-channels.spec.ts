/**
 * One channel failing must not stop the others.
 *
 * @remarks This is the single most important property of the dispatch loop, and it is easy to
 * get wrong in a way that looks correct: a `Promise.all` over the channels, or a `for` loop
 * whose body is not individually guarded. Both "work" until a provider is down, and then the
 * user with a working push registration does not get told their account was locked because
 * the SMS provider is having an afternoon.
 *
 * @remarks The distinction the loop keeps is between `failed` and `skipped`. `failed` is ours
 * and might be retried; `skipped` means there was nothing to send to, and retrying will change
 * nothing. Collapsing them would page somebody about a user who has no phone number.
 */
import { Topics } from '@auth/contracts';
import { SendNotificationHandler } from '../src/application/commands/notification.handlers';
import {
  SendNotificationCommand,
  toSendNotificationCommand,
} from '../src/application/commands/notification.commands';
import { NotificationEventProcessor } from '../src/application/consumers/notification-event.processor';
import { NotificationOutcome } from '../src/domain/notification.aggregate';
import { DeliveryStatus } from '../src/domain/value-objects/notification-channel.vo';
import { NotificationTemplate } from '../src/domain/value-objects/notification-template.vo';
import { InMemoryNotificationStore } from '../src/infrastructure/persistence/in-memory-notification.store';
import {
  EMAIL,
  FailingChannel,
  InMemoryClaimStore,
  RecordingChannel,
  TestChannelRegistry,
  UnreachableChannel,
  USER_ID,
  eventMessage,
  fullRecipient,
} from './testing/fakes';
import { NotificationChannel } from '../src/domain/value-objects/notification-channel.vo';

/** `account-locked` names inapp, push and email, so all three adapters are always exercised. */
const LOCK_COMMAND = () =>
  new SendNotificationCommand(
    NotificationTemplate.ACCOUNT_LOCKED,
    USER_ID,
    fullRecipient(),
    { reason: 'brute force' },
  );

describe('per-channel dispatch', () => {
  it('records a throwing channel as failed and keeps going', async () => {
    const inapp = new RecordingChannel(NotificationChannel.INAPP);
    const push = new RecordingChannel(NotificationChannel.PUSH);
    const email = new FailingChannel(NotificationChannel.EMAIL, 'SES is down');
    const store = new InMemoryNotificationStore((type) => `local.${type}`);

    const handler = new SendNotificationHandler(
      store,
      new TestChannelRegistry([inapp, push, email]),
    );

    const result = await handler.execute(LOCK_COMMAND());

    expect(email.calls).toBe(1);
    expect(inapp.delivered).toHaveLength(1);
    expect(push.delivered).toHaveLength(1);

    const byChannel = new Map(
      result.deliveries.map((delivery) => [delivery.channel, delivery]),
    );

    expect(byChannel.get(NotificationChannel.INAPP)?.status).toBe(DeliveryStatus.SENT);
    expect(byChannel.get(NotificationChannel.PUSH)?.status).toBe(DeliveryStatus.SENT);
    expect(byChannel.get(NotificationChannel.EMAIL)?.status).toBe(DeliveryStatus.FAILED);
    expect(byChannel.get(NotificationChannel.EMAIL)?.error).toBe('SES is down');

    expect(result.outcome).toBe(NotificationOutcome.PARTIAL);
  });

  it('does not stop at the first failure, whichever channel fails', async () => {
    // Ordering is canonical (`inapp`, `push`, `sms`, `email`), so a first-position failure is
    // the case a naive loop loses everything on.
    const failing = new FailingChannel(NotificationChannel.INAPP);
    const push = new RecordingChannel(NotificationChannel.PUSH);
    const email = new RecordingChannel(NotificationChannel.EMAIL);
    const store = new InMemoryNotificationStore((type) => `local.${type}`);

    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([failing, push, email]),
    ).execute(LOCK_COMMAND());

    expect(result.outcome).toBe(NotificationOutcome.PARTIAL);
    expect(push.delivered).toHaveLength(1);
    expect(email.delivered).toHaveLength(1);
  });

  it('reports `failed` — not `skipped` — when every channel throws', async () => {
    const store = new InMemoryNotificationStore((type) => `local.${type}`);

    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([
        new FailingChannel(NotificationChannel.INAPP),
        new FailingChannel(NotificationChannel.PUSH),
        new FailingChannel(NotificationChannel.EMAIL),
      ]),
    ).execute(LOCK_COMMAND());

    expect(result.outcome).toBe(NotificationOutcome.FAILED);
    expect(
      result.deliveries.every((delivery) => delivery.status === DeliveryStatus.FAILED),
    ).toBe(true);
  });

  it('resolves rather than throwing when every channel failed', async () => {
    // A throw here would put a provider outage into an unbounded retry loop and would let a
    // single unavailable provider stop the *consumer* as well as the notification.
    const store = new InMemoryNotificationStore((type) => `local.${type}`);

    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([
        new FailingChannel(NotificationChannel.INAPP),
        new FailingChannel(NotificationChannel.EMAIL),
      ]),
    ).execute(LOCK_COMMAND());

    expect(result.outcome).toBe(NotificationOutcome.FAILED);
  });

  it('still records the notification when nothing was delivered', async () => {
    // The failure has to be a durable, queryable fact. A record that only exists when the
    // send succeeded is a record that cannot answer "why did I not get told my account was
    // locked?".
    const store = new InMemoryNotificationStore((type) => `local.${type}`);

    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([new FailingChannel(NotificationChannel.EMAIL)]),
    ).execute(LOCK_COMMAND());

    const stored = store.records.get(result.notificationId);
    expect(stored).toBeDefined();
    expect(stored?.failedChannels).toEqual([NotificationChannel.EMAIL]);
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].type).toBe('notification.dispatched');
  });

  it('distinguishes a channel that is unbound from one that failed', async () => {
    const store = new InMemoryNotificationStore((type) => `local.${type}`);

    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.INAPP),
        new UnreachableChannel(NotificationChannel.PUSH),
        new RecordingChannel(NotificationChannel.EMAIL),
      ]),
    ).execute(LOCK_COMMAND());

    const byChannel = new Map(
      result.deliveries.map((delivery) => [delivery.channel, delivery]),
    );

    expect(byChannel.get(NotificationChannel.PUSH)?.status).toBe(DeliveryStatus.SKIPPED);
    expect(byChannel.get(NotificationChannel.PUSH)?.error).toContain('no address');
    // Nothing failed, so the whole notification succeeded on what it could reach.
    expect(result.outcome).toBe(NotificationOutcome.PARTIAL);
  });

  it('truncates a provider error so one bad stack cannot dominate the stored row', async () => {
    const store = new InMemoryNotificationStore((type) => `local.${type}`);
    const failing = new FailingChannel(NotificationChannel.EMAIL, 'x'.repeat(5_000));

    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([new FailingChannel(NotificationChannel.INAPP), failing]),
    ).execute(LOCK_COMMAND());

    const email = result.deliveries.find(
      (delivery) => delivery.channel === NotificationChannel.EMAIL,
    );
    expect(email?.error?.length).toBeLessThanOrEqual(500);
  });

  it('keeps a provider message id out of the announcement and keeps it in the record', async () => {
    const store = new InMemoryNotificationStore((type) => `local.${type}`);

    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([new RecordingChannel(NotificationChannel.EMAIL)]),
    ).execute(
      new SendNotificationCommand(
        NotificationTemplate.VERIFY_EMAIL,
        USER_ID,
        fullRecipient(),
        {},
        [NotificationChannel.EMAIL],
      ),
    );

    const stored = store.records.get(result.notificationId);
    expect(stored?.deliveryFor(NotificationChannel.EMAIL)?.providerMessageId).toBe(
      'email-1',
    );

    // The announcement is what leaves the process, and a provider's message id is a long
    // opaque string in the exact shape of a leaked token.
    const announcement = store.outbox[0].payload as Record<string, unknown>;
    expect(JSON.stringify(announcement)).not.toContain('email-1');
  });
});

describe('a channel failure inside the consumer', () => {
  it('does not turn a partial delivery into a released claim', async () => {
    // `PARTIAL` is a *success*: the notification happened. Releasing the claim here would let
    // the broker redeliver and the user would get the "your account is locked" email twice.
    const claims = new InMemoryClaimStore();
    const store = new InMemoryNotificationStore((type) => `local.${type}`);
    const handler = new SendNotificationHandler(
      store,
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.INAPP),
        new FailingChannel(NotificationChannel.EMAIL),
      ]),
    );

    const processor = new NotificationEventProcessor(claims, {
      send: (command) => handler.execute(command),
      markRead: () => Promise.reject(new Error('not used here')),
    });

    const outcome = await processor.process(
      eventMessage(Topics.USER_LOCKED, {
        userId: USER_ID,
        previousStatus: 'active',
        status: 'locked',
        reason: 'brute force',
      }),
    );

    expect(outcome.kind).toBe('processed');
    expect(claims.releaseLog).toHaveLength(0);
    expect(claims.heldCount).toBe(1);
    expect(store.records.size).toBe(1);
  });

  it('delivers to an address the payload carried, through the consumer, with no email in the record', async () => {
    const claims = new InMemoryClaimStore();
    const store = new InMemoryNotificationStore((type) => `local.${type}`);
    const email = new RecordingChannel(NotificationChannel.EMAIL);
    const handler = new SendNotificationHandler(
      store,
      new TestChannelRegistry([new RecordingChannel(NotificationChannel.INAPP), email]),
    );

    const processor = new NotificationEventProcessor(claims, {
      send: (command) => handler.execute(command),
      markRead: () => Promise.reject(new Error('not used here')),
    });

    await processor.process(
      eventMessage(Topics.USER_REGISTERED, {
        userId: USER_ID,
        email: EMAIL,
        displayName: 'Ada',
        source: 'web',
      }),
    );

    expect(email.delivered[0].address).toBe(EMAIL);
    expect(JSON.stringify(store.outbox)).not.toContain(EMAIL);
  });

  it('builds its command through the factory rather than an object literal', async () => {
    // `CommandBus` resolves a handler from `command.constructor`. An object literal would
    // dispatch to nothing at all, and a string key throws at import — so this is the shape
    // the whole write side depends on.
    const command = toSendNotificationCommand({
      userId: USER_ID,
      template: NotificationTemplate.WELCOME,
      recipient: fullRecipient(),
      variables: { displayName: 'Ada' },
    });

    expect(command.constructor.name).toBe('SendNotificationCommand');
    expect(typeof command.commandId).toBe('string');
    expect(command.commandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});