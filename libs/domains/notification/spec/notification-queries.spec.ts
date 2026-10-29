/** @fileoverview Tests for notification queries and read-model accessors.
 *
 * Covers `ListNotificationsQuery`, `GetNotificationQuery`, and the read-model surface
 * returned by the notification store. These tests depend on `SendNotificationHandler`,
 * which is in `notification.handlers.ts`, so they break when that file is incomplete.
 */

import { NotificationId } from '../src/domain/value-objects/notification-id.vo';
import { NotificationTemplate } from '../src/domain/value-objects/notification-template.vo';
import { NotificationChannel } from '../src/domain/value-objects/notification-channel.vo';
import type { NotificationRecipient } from '../src/domain/notification.aggregate';
import { InMemoryNotificationStore } from '../src/infrastructure/persistence/in-memory-notification.store';
import { Topics } from '@auth/contracts';
import {
  GetNotificationStatusHandler,
  GetNotificationStatusQuery,
  ListNotificationsHandler,
  ListNotificationsQuery,
  toNotificationReadModel,
} from '../src/application/queries/notification.queries';
import { SendNotificationHandler, MarkNotificationReadHandler } from '../src/application/commands/notification.handlers';
import { MarkNotificationReadCommand, SendNotificationCommand } from '../src/application/commands/notification.commands';
import {
  asNotificationId,
  RecordingChannel,
  testNotificationConfig,
  fullRecipient,
  TestChannelRegistry,
} from './testing/fakes';
import { rejection } from './testing/helpers';
import { ResourceNotFoundException } from '@auth/platform/error-handling';

// helpers {{{1
const STORE_PREFIX = 'local';
const STORE = () => new InMemoryNotificationStore((type) => `${STORE_PREFIX}.${type}`);

const LISTER = () => new ListNotificationsHandler(STORE(), testNotificationConfig());
const MIMER = () => new MarkNotificationReadHandler(STORE());
const STATUS = () => new GetNotificationStatusHandler(STORE());
// helpers }}}1

// fixtures {{{1
const NOW = new Date('2026-01-01T10:00:00Z');
const EMAIL = 'ada.lovelace@example.com';
const USER_ID = '00000000-0000-4000-8000-0000000000ff';
const OTHER_USER_ID = '00000000-0000-4000-8000-0000000000ee';
// fixtures }}}1

// helpers: }}

function newId(value: string): string {
  return NotificationId.create(value).value;
}

async function send(
  target = STORE(),
  input: {
    userId?: string;
    template?: NotificationTemplate;
    displayName?: string;
    now?: Date;
  } = {},
): Promise<string> {
  const handler = new SendNotificationHandler(
    target,
    new TestChannelRegistry([new RecordingChannel(NotificationChannel.INAPP)]),
  );

  const result = await handler.execute(
    new SendNotificationCommand(
      input.template ?? NotificationTemplate.WELCOME,
      input.userId ?? USER_ID,
      { email: EMAIL, phone: null, deviceToken: null },
      { displayName: input.displayName ?? 'Ada' },
      undefined,
    ),
  );

  return result.notificationId;
}

const store = () => new InMemoryNotificationStore((type) => `local.${type}`);

describe('ListNotifications', () => {
  it('returns a user newest first with an unread count', async () => {
    const target = store();

    await send(target, { displayName: 'Ada', now: NOW });
    await send(target, { displayName: 'Grace', now: new Date('2026-01-01T11:00:00Z') });

    const result = await new ListNotificationsHandler(
      target,
      testNotificationConfig(),
    ).execute(new ListNotificationsQuery(USER_ID));

    expect(result.total).toBe(2);
    expect(result.unread).toBe(2);
    expect(result.data.map((n) => n.subject)).toEqual([
      'Welcome to the platform',
      'Welcome to the platform',
    ]);
    expect(result.data[0].createdAt >= result.data[1].createdAt).toBe(true);
  });

  it('never returns another user notifications', async () => {
    const target = store();
    await send(target, { userId: USER_ID });
    await send(target, { userId: OTHER_USER_ID });

    const result = await new ListNotificationsHandler(
      target,
      testNotificationConfig(),
    ).execute(new ListNotificationsQuery(USER_ID));

    expect(result.total).toBe(1);
    expect(result.data.every((n) => n.userId === USER_ID)).toBe(true);
  });

  it('returns an empty list, not an error, for a user with none', async () => {
    const result = await new ListNotificationsHandler(
      store(),
      testNotificationConfig(),
    ).execute(new ListNotificationsQuery('nobody'));

    expect(result).toEqual({ data: [], unread: 0, total: 0, limit: 100 });
  });

  it('filters to unread on request', async () => {
    const target = store();
    const first = await send(target, { displayName: 'Ada' });
    await send(target, { displayName: 'Grace' });

    await new MarkNotificationReadHandler(target).execute(
      new MarkNotificationReadCommand(asNotificationId(first), USER_ID),
    );

    const unread = await new ListNotificationsHandler(
      target,
      testNotificationConfig(),
    ).execute(new ListNotificationsQuery(USER_ID, undefined, true));

    expect(unread.total).toBe(1);
    expect(unread.unread).toBe(1);
    expect(unread.data[0].id).not.toBe(first);
  });

  it('clamps the limit to the configured maximum', async () => {
    const result = await new ListNotificationsHandler(
      store(),
      testNotificationConfig({ maxPageSize: 10 }),
    ).execute(new ListNotificationsQuery(USER_ID, 5_000));

    expect(result.limit).toBe(10);
  });

  it('never clamps to zero', async () => {
    const result = await new ListNotificationsHandler(
      store(),
      testNotificationConfig(),
    ).execute(new ListNotificationsQuery(USER_ID, 0));

    expect(result.limit).toBe(1);
  });

  it('honours a limit below the maximum', async () => {
    const target = STORE();
    await send(target, { displayName: 'Ada' });
    await send(target, { displayName: 'Grace' });

    const result = await new ListNotificationsHandler(
      target,
      testNotificationConfig(),
    ).execute(new ListNotificationsQuery(USER_ID, 1));

    expect(result.data).toHaveLength(1);
  });
});

describe('the read model', () => {
  it('carries no recipient and no rendered body', async () => {
    const target = STORE();
    const id = await send(target);

    const result = await new GetNotificationStatusHandler(target).execute(
      new GetNotificationStatusQuery(id, USER_ID),
    );

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('recipient');
    expect(result).not.toHaveProperty('body');
    expect(JSON.stringify(result)).not.toContain(EMAIL);
  });

  it('reports per-channel delivery status', async () => {
    const target = STORE();
    const handler = new SendNotificationHandler(
      target,
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.INAPP),
        new RecordingChannel(NotificationChannel.EMAIL),
      ]),
    );

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        { email: EMAIL, phone: null, deviceToken: null },
        { displayName: 'Ada' },
      ),
    );

    const status = await new GetNotificationStatusHandler(target).execute(
      new GetNotificationStatusQuery(result.notificationId, USER_ID),
    );

    expect(status?.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual([
      'inapp:sent',
      'email:sent',
    ]);
    expect(status?.read).toBe(false);
    expect(status?.readAt).toBeNull();
  });
});

describe('GetNotificationStatus', () => {
  it('returns null for an unknown id', async () => {
    expect(
      await new GetNotificationStatusHandler(store()).execute(
        new GetNotificationStatusQuery(newId('00000000-0000-4000-8000-0000000000ff'), USER_ID),
      ),
    ).toBeNull();
  });

  it('returns null for an id that is not a uuid at all', async () => {
    expect(
      await new GetNotificationStatusHandler(store()).execute(
        new GetNotificationStatusQuery('not-a-uuid', USER_ID),
      ),
    ).toBeNull();
  });

  it('gives the same answer for somebody else notification as for a missing one', async () => {
    const target = store();
    const id = await send(target);

    const handler = new GetNotificationStatusHandler(target);

    const other = await handler.execute(
      new GetNotificationStatusQuery(id, OTHER_USER_ID),
    );
    const missing = await handler.execute(
      new GetNotificationStatusQuery(newId('00000000-0000-4000-8000-0000000000ee'), OTHER_USER_ID),
    );

    expect(other).toBeNull();
    expect(missing).toBeNull();
  });
});

describe('MarkNotificationRead', () => {
  it('marks read and announces it', async () => {
    const target = STORE();
    const id = await send(target);

    const result = await new MarkNotificationReadHandler(target).execute(
      new MarkNotificationReadCommand(asNotificationId(id), USER_ID),
    );

    expect(result).toMatchObject({ notificationId: id, read: true, changed: true });

    const stored = target.records.get(id);
    expect(stored?.isRead).toBe(true);
    expect(target.outbox.map((row) => row.type)).toEqual([
      'notification.dispatched',
      'notification.read',
    ]);
    expect(target.outbox[1].dedupKey).toBe(`notification.read:${id}:1`);
  });

  it('is idempotent: a second read announces nothing', async () => {
    const target = store();
    const id = await send(target);
    const handler = new MarkNotificationReadHandler(target);

    const first = await handler.execute(
      new MarkNotificationReadCommand(asNotificationId(id), USER_ID),
    );
    const second = await handler.execute(
      new MarkNotificationReadCommand(asNotificationId(id), USER_ID),
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.readAt).toBe(first.readAt);
    expect(target.outbox.filter((row) => row.type === 'notification.read')).toHaveLength(1);
  });

  it('refuses a notification that belongs to somebody else', async () => {
    const target = store();
    const id = await send(target);

    const error = await rejection(
      new MarkNotificationReadHandler(target).execute(
        new MarkNotificationReadCommand(asNotificationId(id), OTHER_USER_ID),
      ),
    );

    expect((error as ResourceNotFoundException).name).toBe('ResourceNotFoundException');
    expect(target.records.get(id)?.isRead).toBe(false);
  });

  it('refuses an unknown notification', async () => {
    const error = await rejection(
      new MarkNotificationReadHandler(store()).execute(
        new MarkNotificationReadCommand(
          asNotificationId('00000000-0000-4000-8000-0000000000dd'),
          USER_ID,
        ),
      ),
    );

    expect((error as ResourceNotFoundException).name).toBe('ResourceNotFoundException');
  });
});

describe('the projection helper', () => {
  it('is total: a notification with no deliveries still projects', async () => {
    const projectionTarget = STORE();
    const projectionId = await send(projectionTarget);
    const stored = projectionTarget.records.get(projectionId)!;
    const model = toNotificationReadModel(stored as NonNullable<typeof stored>);

    expect(model.id).toBe(projectionId);
    expect(model.channels.length).toBeGreaterThan(0);
    expect(model.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('renders deliveries into the read model', async () => {
    const projectionTarget = STORE();
    const projectionId = await send(projectionTarget);
    const stored = projectionTarget.records.get(projectionId)!;
    const model = toNotificationReadModel(stored as NonNullable<typeof stored>);

    // `send` binds only the in-app adapter, so WELCOME's email delivery is recorded as
    // skipped for want of an adapter — and the read model shows both outcomes, not just
    // the one that succeeded.
    expect(model.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual([
      'inapp:sent',
      'email:skipped',
    ]);
  });
});


describe('the module the consumer subscribes to', () => {
  it('names the topics the routing table does', () => {
    expect(Topics.USER_REGISTERED).toBe('platform.user.registered.v1');
  });
});
