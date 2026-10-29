/**
 * Nothing that identifies a person leaves this service.
 *
 * @remarks The rule this suite enforces is the one that is easiest to violate by accident:
 * every upstream payload carries an `email`, and every template renders a body from variables
 * that came off a Kafka topic. Put those two together naively and this service becomes the
 * place every user's contact details and reset links are stored twice — once in a provider's
 * outbox and once in an `outbox_events` row that every other service can read.
 *
 * @remarks The guards are layered, and the tests name the layer:
 *
 * - the template schema *strips* unknown keys, so an address in a payload never becomes a
 *   variable;
 * - the content guard *drops* address-shaped and token-shaped values that survived, and
 *   reports which by name;
 * - the announcement *picks* the fields, so `recipient` and `body` have no path out;
 * - `assertPublishable` *refuses the write* if anything address-shaped survived all three.
 *
 * @remarks A deleted account's `email` is the interesting case: it is the one address the
 * system is certain of, and therefore the one a naive implementation is most likely to treat
 * as safe.
 *
 * @remarks This suite owns the content guard directly, including the exact shape of
 * {@link redactVariables} / {@link CompiledTemplate.redacted}. The handler and Kafka suites
 * assert that shape as behaviour of the system as a whole, and should not be the first place a
 * schema change breaks.
 */
import { Topics } from '@auth/contracts';
import { SendNotificationHandler } from '../src/application/commands/notification.handlers';
import { SendNotificationCommand } from '../src/application/commands/notification.commands';
import {
  FORBIDDEN_PAYLOAD_KEY,
  announcementFor,
  assertPublishable,
  redactVariables,
  sanitiseDeliveryError,
  toVariableMap,
} from '../src/domain/notification-announcement';
import { compileTemplate } from '../src/domain/templates/notification-templates';
import { Notification } from '../src/domain/notification.aggregate';
import { NotificationChannel } from '../src/domain/value-objects/notification-channel.vo';
import { NotificationTemplate } from '../src/domain/value-objects/notification-template.vo';
import { InMemoryNotificationStore } from '../src/infrastructure/persistence/in-memory-notification.store';
import { FailingChannel, RecordingChannel, TestChannelRegistry, USER_ID, fullRecipient } from './testing/fakes';
import { rejection } from './testing/helpers';

const EMAIL = 'ada.lovelace@example.com';
const RESET_TOKEN = 'kZ9x_Q2mB7pL4nR8vT1wY6zX3aC5dF0gH2jK4lM';

/** Every string in a nested structure, so an assertion can search the whole payload. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];

  return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
}

function handlerWith(adapters: TestChannelRegistry) {
  const store = new InMemoryNotificationStore((type) => `local.${type}`);
  return { store, handler: new SendNotificationHandler(store, adapters) };
}

describe('the outbox payload never carries an address', () => {
  it('sends a welcome email without publishing the address it went to', async () => {
    const email = new RecordingChannel(NotificationChannel.EMAIL);
    const inapp = new RecordingChannel(NotificationChannel.INAPP);
    const { store, handler } = handlerWith(new TestChannelRegistry([inapp, email]));

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        fullRecipient({ email: EMAIL }),
        { displayName: 'Ada', source: 'web' },
      ),
    );

    // Delivered...
    expect(email.delivered[0].address).toBe(EMAIL);
    expect(email.delivered[0].body).toContain('Ada');

    // ...and published without it.
    expect(store.outbox).toHaveLength(1);
    const serialised = JSON.stringify(store.outbox[0].payload);
    expect(serialised).not.toContain(EMAIL);
    expect(serialised).not.toContain('@example.com');
    expect(store.records.get(result.notificationId)).toBeDefined();
  });

  it('does not publish the address of a deleted account', async () => {
    const email = new RecordingChannel(NotificationChannel.EMAIL);
    const { store, handler } = handlerWith(new TestChannelRegistry([email]));

    await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.ACCOUNT_DELETED,
        USER_ID,
        fullRecipient({ email: EMAIL }),
        {},
      ),
    );

    expect(email.delivered[0].address).toBe(EMAIL);
    expect(JSON.stringify(store.outbox[0].payload)).not.toContain(EMAIL);
  });

  it('never publishes the rendered body', () => {
    const notification = Notification.request({
      userId: USER_ID,
      template: NotificationTemplate.WELCOME,
      subject: 'Welcome to the platform',
      body: `Welcome, Ada. We will write to ${EMAIL} if you need anything.`,
      severity: 'info',
      variables: { displayName: 'Ada' },
      recipient: fullRecipient({ email: EMAIL }),
      channels: [NotificationChannel.EMAIL],
    });
    notification.recordDelivery({
      channel: NotificationChannel.EMAIL,
      status: 'sent',
      providerMessageId: 'provider-handle-9911',
      deliveredAt: new Date(),
    });

    const announcement = announcementFor(notification);

    const serialised = JSON.stringify(announcement);

    expect(serialised).not.toContain(EMAIL);
    // The body is not published; its *variables* are, and a display name is not a secret —
    // it is what makes the announcement useful to a consumer rendering its own surface.
    expect(serialised).not.toContain('We will write to');
    expect(announcement.variables['displayName']).toBe('Ada');
    // A provider's message id is long, opaque and URL-safe: the exact shape a token has.
    expect(serialised).not.toContain('provider-handle-9911');
    expect(announcement.userId).toBe(USER_ID);
  });
});

describe('the outbox payload never carries a token', () => {
  it('drops a reset token a producer tried to pass as a template variable', async () => {
    const { store, handler } = handlerWith(
      new TestChannelRegistry([new RecordingChannel(NotificationChannel.EMAIL)]),
    );

    // `verify-email` declares no variables, so Zod strips this — but the guard below is what
    // makes it true even if a future template *does* declare one.
    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.VERIFY_EMAIL,
        USER_ID,
        fullRecipient({ email: EMAIL }),
        { resetToken: RESET_TOKEN, confirmUrl: `https://auth.example.com/confirm?t=${RESET_TOKEN}` },
      ),
    );

    const stored = store.records.get(result.notificationId);
    expect(JSON.stringify(store.outbox)).not.toContain(RESET_TOKEN);
    expect(stored?.variables['resetToken']).toBeUndefined();
  });

  it('reports a redacted variable by name so the producer bug is visible', () => {
    const { variables, redacted } = redactVariables({
      displayName: 'Ada',
      resetToken: RESET_TOKEN,
      email: EMAIL,
    });

    expect(variables).toEqual({ displayName: 'Ada' });
    expect(redacted).toEqual(['email', 'resetToken']);
  });

  it('redacts by value as well as by name', () => {
    // A producer that invents `primaryContact` has defeated a key-based filter. It has not
    // defeated a value-based one.
    const { variables, redacted } = redactVariables({
      primaryContact: EMAIL,
      opaqueBlob: RESET_TOKEN,
      displayName: 'Ada',
    });

    expect(variables).toEqual({ displayName: 'Ada' });
    expect(redacted).toEqual(['opaqueBlob', 'primaryContact']);
  });

  it('scrubs a provider error that quoted a key', () => {
    const scrubbed = sanitiseDeliveryError(
      `invalid api key sk_live_${RESET_TOKEN} for account ${EMAIL}`,
    );

    expect(scrubbed).not.toContain(RESET_TOKEN);
    expect(scrubbed).not.toContain(EMAIL);
    expect(scrubbed).toContain('[redacted-');
  });

  it('truncates a provider error to a length a row can hold', () => {
    expect(sanitiseDeliveryError('e'.repeat(4_000)).length).toBeLessThanOrEqual(500);
  });

  it('keeps an ordinary provider error readable', () => {
    // Redaction that destroys every error is not redaction, it is blindness: the scrub has to
    // leave the diagnostic intact.
    const scrubbed = sanitiseDeliveryError('SES: mailbox is not verified (503)');

    expect(scrubbed).toBe('SES: mailbox is not verified (503)');
  });

  it('records a failed delivery whose error is scrubbed, without failing the write', async () => {
    const { store, handler } = handlerWith(
      new TestChannelRegistry([new FailingChannel(NotificationChannel.EMAIL, `key ${RESET_TOKEN} rejected`)]),
    );

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        fullRecipient({ email: EMAIL }),
        {},
        [NotificationChannel.EMAIL],
      ),
    );

    const email = result.deliveries.find(
      (delivery) => delivery.channel === NotificationChannel.EMAIL,
    );
    expect(email?.error).not.toContain(RESET_TOKEN);
    expect(JSON.stringify(store.outbox)).not.toContain(RESET_TOKEN);
  });
});

describe('the last line of defence', () => {
  it('refuses an announcement that carries an address, naming the field', async () => {
    const error = await rejection(
      Promise.resolve().then(() =>
        assertPublishable({
          notificationId: '00000000-0000-4000-8000-000000000001',
          userId: USER_ID,
          template: NotificationTemplate.WELCOME,
          severity: 'info',
          subject: 'Welcome',
          channels: [NotificationChannel.EMAIL],
          deliveries: [],
          // A future edit that puts the recipient in the payload. Refusing is the point: the
          // edit was a decision, and it should fail rather than quietly ship.
          variables: { contact: EMAIL },
          redactedVariables: [],
          createdAt: new Date().toISOString(),
        }),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('$.variables.contact');
  });

  it('refuses a token in a delivery error', async () => {
    const error = await rejection(
      Promise.resolve().then(() =>
        assertPublishable({
          notificationId: '00000000-0000-4000-8000-000000000001',
          userId: USER_ID,
          template: NotificationTemplate.WELCOME,
          severity: 'info',
          subject: 'Welcome',
          channels: [NotificationChannel.EMAIL],
          deliveries: [{ channel: NotificationChannel.EMAIL, status: 'failed', error: RESET_TOKEN }],
          variables: {},
          redactedVariables: [],
          createdAt: new Date().toISOString(),
        }),
      ),
    );

    expect((error as Error).message).toContain('$.deliveries[0].error');
  });

  it('does not mistake a uuid for a token', async () => {
    // Ids are the identifiers consumers join on. Treating them as secrets would strip exactly
    // the fields the event exists to carry.
    expect(() =>
      assertPublishable({
        notificationId: '00000000-0000-4000-8000-000000000001',
        userId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        template: NotificationTemplate.WELCOME,
        severity: 'info',
        subject: 'Welcome',
        channels: [NotificationChannel.EMAIL],
        deliveries: [],
        variables: {},
        redactedVariables: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('names the keys it refuses outright', () => {
    expect(FORBIDDEN_PAYLOAD_KEY.test('email')).toBe(true);
    expect(FORBIDDEN_PAYLOAD_KEY.test('resetToken')).toBe(true);
    expect(FORBIDDEN_PAYLOAD_KEY.test('apiKey')).toBe(true);
    expect(FORBIDDEN_PAYLOAD_KEY.test('to')).toBe(true);
    expect(FORBIDDEN_PAYLOAD_KEY.test('displayName')).toBe(false);
    expect(FORBIDDEN_PAYLOAD_KEY.test('riskLevel')).toBe(false);
  });
});

describe('the variable map', () => {
  it('stringifies what the schema produced and drops what it did not', () => {
    expect(toVariableMap({ riskScore: 91, displayName: 'Ada', missing: null })).toEqual({
      riskScore: '91',
      displayName: 'Ada',
    });
  });

  it('treats a non-object as no variables', () => {
    expect(toVariableMap('nope')).toEqual({});
    expect(toVariableMap(null)).toEqual({});
  });
});

describe('the content guard and its report surface', () => {
  it('redacts by name when the key is forbidden', () => {
    const { variables, redacted } = redactVariables({
      displayName: 'Ada',
      email: EMAIL,
      riskLevel: 'high',
    });

    expect(variables).toEqual({ displayName: 'Ada', riskLevel: 'high' });
    expect(redacted).toEqual(['email']);
  });

  it('redacts by value when the value looks like an email, even on a clean key', () => {
    const { variables, redacted } = redactVariables({
      displayName: 'Ada',
      fromAddress: 'ada@example.com',
    });

    expect(variables).toEqual({ displayName: 'Ada' });
    expect(redacted).toEqual(['fromAddress']);
  });

  it('redacts a token-shaped value by value', () => {
    const { variables, redacted } = redactVariables({
      displayName: 'Ada',
      resetToken: RESET_TOKEN,
    });

    expect(variables).toEqual({ displayName: 'Ada' });
    expect(redacted).toEqual(['resetToken']);
  });

  it('does not redact a UUID', () => {
    const { variables, redacted } = redactVariables({
      displayName: 'Ada',
      accountRef: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });

    expect(variables).toEqual({
      displayName: 'Ada',
      accountRef: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    });
    expect(redacted).toEqual([]);
  });

  it('drops a forbidden key even when its value is short', () => {
    const { variables, redacted } = redactVariables({
      displayName: 'Ada',
      token: 'abc',
    });

    expect(variables).toEqual({ displayName: 'Ada' });
    expect(redacted).toEqual(['token']);
  });

  it('does not strip a token embedded inside a longer string', () => {
    const { variables, redacted } = redactVariables({
      summary: 'Reset token kZ9x_Q2mB7pL4nR8vT1wY6zX3aC5dF0gH2jK4lM was used',
    });

    expect(variables).toEqual({
      summary: 'Reset token kZ9x_Q2mB7pL4nR8vT1wY6zX3aC5dF0gH2jK4lM was used',
    });
    expect(redacted).toEqual([]);
  });

  it('keeps redaction names sorted', () => {
    // Sorting is the property under test, so every key is redacted by *value*: three
    // address-shaped values, one per name, and the report must come back in key order.
    const { redacted } = redactVariables({
      apple: 'one@example.com',
      zebra: 'three@example.com',
      banana: 'two@example.com',
    });

    expect(redacted).toEqual(['apple', 'banana', 'zebra']);
  });
});

describe('the template compilation surface', () => {
  it('returns the variables and the names it dropped together', () => {
    const compiled = compileTemplate(NotificationTemplate.ACCOUNT_DELETED, {
      email: EMAIL,
      resetToken: RESET_TOKEN,
      displayName: 'Ada',
    });

    expect(compiled.variables).toEqual({ displayName: 'Ada' });
    expect(compiled.redacted).toEqual(['email', 'resetToken']);
  });

  it('renders the body from the kept variables only', () => {
    const compiled = compileTemplate(NotificationTemplate.WELCOME, {
      displayName: 'Ada',
      email: EMAIL,
    });

    expect(compiled.body).toContain('Ada');
    expect(compiled.body).not.toContain(EMAIL);
  });

  it('redacts a template variable even when the template declared it', () => {
    // The schema may allow a key; the content guard decides what leaves this service.
    const compiled = compileTemplate(NotificationTemplate.ACCOUNT_DELETED, {
      displayName: 'Ada',
      email: EMAIL,
    });

    expect(compiled.variables).toEqual({ displayName: 'Ada' });
    expect(compiled.redacted).toContain('email');
  });
});

describe('what a published announcement is allowed to contain', () => {
  it('carries identifiers, statuses and names — and nothing else', async () => {
    const { store, handler } = handlerWith(
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.INAPP),
        new FailingChannel(NotificationChannel.EMAIL, 'provider unavailable'),
      ]),
    );

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.ACCOUNT_LOCKED,
        USER_ID,
        fullRecipient({ email: EMAIL, phone: '+15550100', deviceToken: 'device-1' }),
        { reason: 'brute force' },
      ),
    );

    const row = store.outbox[0];
    expect(row.type).toBe('notification.dispatched');
    expect(row.dedupKey).toBe(`notification.dispatched:${result.notificationId}:1`);
    expect(row.topic).toBe('local.notification.dispatched');

    const payload = row.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'channels',
      'createdAt',
      'deliveries',
      'notificationId',
      'redactedVariables',
      'severity',
      'subject',
      'template',
      'userId',
      'variables',
    ]);

    // Every string in it is an id, a status, a template name or a reason — none is an address.
    const values = stringsIn(payload);
    expect(values.some((value) => value.includes('@'))).toBe(false);
    expect(payload['variables']).toEqual({ reason: 'brute force' });
    expect(payload['redactedVariables']).toEqual([]);
  });
});

describe('the transaction that writes the announcement', () => {
  it('commits the record and its announcement together, or neither', async () => {
    const { store, handler } = handlerWith(
      new TestChannelRegistry([new RecordingChannel(NotificationChannel.INAPP)]),
    );

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        fullRecipient(),
        { displayName: 'Ada' },
      ),
    );

    // One transaction per save. A record with no announcement is a notification downstream
    // services never learn about; an announcement with no record is one they cannot resolve.
    expect(store.transactions).toBe(1);
    expect(store.records.size).toBe(1);
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].aggregateId).toBe(result.notificationId);
  });

  it('writes no announcement at all when the notification was never dispatched', async () => {
    const { store, handler } = handlerWith(new TestChannelRegistry([]));

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        fullRecipient(),
        {},
        [],
      ),
    );

    // No channels requested means nothing to send, and an event about nothing is noise every
    // downstream consumer has to filter.
    expect(store.outbox).toHaveLength(1);
    expect(store.records.get(result.notificationId)?.channels).toEqual([]);
  });
});

describe('the topic a notification is announced on', () => {
  it('is the one the consumer subscribed to', async () => {
    // Guards against the store announcing on a topic nothing listens to, which is the failure
    // mode of a hand-maintained event-to-topic map.
    const { store, handler } = handlerWith(
      new TestChannelRegistry([new RecordingChannel(NotificationChannel.INAPP)]),
    );

    await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        fullRecipient(),
        {},
      ),
    );

    // `local.` prefix is the test's own mapping; the durable store uses
    // `platform.notification.dispatched.v1`, asserted in the module's table.
    expect(store.outbox[0].topic).toBe('local.notification.dispatched');
    expect(Topics.USER_REGISTERED).toBe('platform.user.registered.v1');
  });
});