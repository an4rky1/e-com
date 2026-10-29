/**
 * The two adapters of `NotificationStorePort`, against a Prisma double that honours the
 * schema's constraints.
 *
 * @remarks These are the assertions about the *production* mechanisms, and they cannot be made
 * against the in-memory store alone. The idempotency guarantee is not "the handler remembers
 * what it did" — it is "the unique index on `(dedup_key, type)` makes the second of two
 * concurrent inserts a no-op". Testing that needs a double which actually has the index, or it
 * is testing nothing.
 *
 * @remarks The doubles implement exactly three things from the schema: `createMany` honouring
 * `skipDuplicates`, `deleteMany`, and the fact that a row with `status = 'pending'` is one the
 * relay will pick up while `published` is one it never will. That last one is a design
 * constraint rather than a detail: a claim row left `pending` would be published to Kafka as
 * if it were an event, and every other service subscribes to this service's outbox topics.
 *
 * @remarks The record doubles are separate from the outbox one, because that separation *is*
 * the thing being tested: `notifications` and `notification_deliveries` hold records,
 * `outbox_events` holds events, and a double that kept all three in one bag could not tell a
 * reader which one a write actually landed in.
 */
import { PrismaConsumerClaimStore, CLAIM_EVENT_TYPE } from '../src/infrastructure/persistence/prisma-consumer-claim.store';
import {
  NOTIFICATION_TOPICS,
  PrismaNotificationStore,
  RECORD_STATUS,
  TOPIC_BY_EVENT,
} from '../src/infrastructure/persistence/prisma-notification.store';
import { claimKeyFor } from '../src/domain/ports/consumer-claim.port';
import { resolveNotificationConfig } from '../src/notification.config';
import { InMemoryNotificationStore } from '../src/infrastructure/persistence/in-memory-notification.store';
import { SendNotificationHandler } from '../src/application/commands/notification.handlers';
import { SendNotificationCommand } from '../src/application/commands/notification.commands';
import { NotificationTemplate } from '../src/domain/value-objects/notification-template.vo';
import { NotificationChannel } from '../src/domain/value-objects/notification-channel.vo';
import { NotificationId } from '../src/domain/value-objects/notification-id.vo';
import {
  FailingChannel,
  RecordingChannel,
  TestChannelRegistry,
  USER_ID,
  testNotificationConfig,
} from './testing/fakes';
import { rejection } from './testing/helpers';

interface Row {
  id: string;
  type: string;
  aggregate_type: string;
  aggregate_id: string;
  topic: string;
  payload: unknown;
  dedup_key: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  locked_at: Date | null;
  created_at: Date;
  published_at: Date | null;
  trace_id: string;
}

interface CreateManyArgs {
  data: Partial<Row>[];
  skipDuplicates?: boolean;
}

/**
 * The slice of `outbox_events` this service uses, with the unique index it relies on.
 */
class FakeOutboxDelegate {
  readonly rows: Row[] = [];

  /** What the outbox relay would claim: `pending` rows that are due. */
  get publishable(): Row[] {
    return this.rows.filter((row) => row.status === 'pending');
  }

  async createMany(args: CreateManyArgs): Promise<{ count: number }> {
    let count = 0;

    for (const candidate of args.data) {
      // `@@unique([dedup_key, type], map: "outbox_events_dedup_idx")`
      const clash = this.rows.some(
        (row) =>
          row.dedup_key === candidate.dedup_key && row.type === candidate.type,
      );

      if (clash && args.skipDuplicates) continue;

      if (clash) {
        // What Postgres does without `ON CONFLICT DO NOTHING`: the transaction aborts.
        const error = new Error(
          'Unique constraint failed on the fields: (`dedup_key`,`type`)',
        ) as Error & { code: string };
        error.code = 'P2002';
        throw error;
      }

      const now = new Date();
      this.rows.push({
        id: candidate.id ?? crypto.randomUUID(),
        type: candidate.type ?? '',
        aggregate_type: candidate.aggregate_type ?? '',
        aggregate_id: candidate.aggregate_id ?? '',
        topic: candidate.topic ?? '',
        payload: candidate.payload ?? {},
        dedup_key: candidate.dedup_key ?? '',
        status: candidate.status ?? 'pending',
        attempts: candidate.attempts ?? 0,
        next_attempt_at: candidate.next_attempt_at ?? now,
        last_error: candidate.last_error ?? null,
        locked_at: candidate.locked_at ?? null,
        created_at: candidate.created_at ?? now,
        published_at: candidate.published_at ?? null,
        trace_id: candidate.trace_id ?? '',
      });
      count += 1;
    }

    return { count };
  }

  async deleteMany(args: {
    where: { type?: string; dedup_key?: string; created_at?: { lt: Date } };
  }): Promise<{ count: number }> {
    const survivors = this.rows.filter((row) => {
      if (args.where.type !== undefined && row.type !== args.where.type) return true;
      if (args.where.dedup_key !== undefined && row.dedup_key !== args.where.dedup_key) {
        return true;
      }
      if (
        args.where.created_at?.lt !== undefined &&
        row.created_at >= args.where.created_at.lt
      ) {
        return true;
      }
      return false;
    });

    const count = this.rows.length - survivors.length;
    this.rows.splice(0, this.rows.length, ...survivors);
    return { count };
  }

  async findFirst(args: {
    where: { type?: string; dedup_key?: string };
  }): Promise<Row | null> {
    return (
      this.rows.find(
        (row) =>
          (args.where.type === undefined || row.type === args.where.type) &&
          (args.where.dedup_key === undefined || row.dedup_key === args.where.dedup_key),
      ) ?? null
    );
  }

  async findUnique(args: { where: { id: string } }): Promise<Row | null> {
    return this.rows.find((row) => row.id === args.where.id) ?? null;
  }

  async upsert(args: {
    where: { id: string };
    create: Partial<Row> & { id: string };
    update: Partial<Row>;
  }): Promise<Row> {
    const existing = this.rows.find((row) => row.id === args.where.id);

    if (!existing) {
      const created = { ...args.create } as Row;
      this.rows.push(created);
      return created;
    }

    Object.assign(existing, args.update);
    return existing;
  }

  /** Only the fields the store actually filters on, which is the point of the assertions. */
  async findMany(args: {
    where: { type?: string; aggregate_id?: string; status?: string };
    orderBy?: { created_at: 'asc' | 'desc' };
    take?: number;
  }): Promise<Row[]> {
    const matched = this.rows.filter((row) => {
      if (args.where.type !== undefined && row.type !== args.where.type) return false;
      if (
        args.where.aggregate_id !== undefined &&
        row.aggregate_id !== args.where.aggregate_id
      ) {
        return false;
      }
      if (args.where.status !== undefined && row.status !== args.where.status) return false;
      return true;
    });

    const sorted = [...matched].sort((left, right) => {
      const delta = left.created_at.getTime() - right.created_at.getTime();
      return args.orderBy?.created_at === 'desc' ? -delta : delta;
    });

    return args.take === undefined ? sorted : sorted.slice(0, args.take);
  }

  async count(args: { where: { type?: string; aggregate_id?: string; status?: string } }) {
    return (
      await this.findMany({ where: args.where })
    ).length;
  }
}

/** A `PrismaService` double: `tx` for ambient reads, `runInTransaction` for writes. */
function fakePrisma(outbox: FakeOutboxDelegate) {
  const deliveries = new FakeDeliveriesDelegate();
  const notifications = new FakeNotificationsDelegate(deliveries);

  return {
    outbox,
    deliveries,
    notifications,
    tx: { outbox_events: outbox, notifications },
    transactions: 0,
    async runInTransaction<T>(fn: (client: unknown) => Promise<T>) {
      this.transactions += 1;
      return fn({
        outbox_events: outbox,
        notifications,
        notification_deliveries: deliveries,
      });
    },
  };
}

/** One `notifications` row. */
interface NotificationRow {
  id: string;
  user_id: string;
  template: string;
  severity: string;
  status: string;
  channels: unknown;
  variables: unknown;
  payload: unknown;
  deduplicated: boolean;
  created_at: Date;
  updated_at: Date;
  read_at: Date | null;
}

/** One `notification_deliveries` row. */
interface DeliveryRow {
  id: string;
  notification_id: string;
  channel: string;
  status: string;
  error: string | null;
  dispatched_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * `notification_deliveries`, with the `@@unique([notification_id, channel])` index it relies on.
 */
class FakeDeliveriesDelegate {
  readonly rows: DeliveryRow[] = [];

  async upsert(args: {
    where: { notification_id_channel: { notification_id: string; channel: string } };
    create: Partial<DeliveryRow> & { notification_id: string; channel: string; status: string };
    update: Partial<DeliveryRow>;
  }): Promise<DeliveryRow> {
    const { notification_id, channel } = args.where.notification_id_channel;
    const existing = this.rows.find(
      (row) => row.notification_id === notification_id && row.channel === channel,
    );

    if (!existing) {
      const created: DeliveryRow = {
        id: crypto.randomUUID(),
        error: null,
        dispatched_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...args.create,
      };
      this.rows.push(created);
      return created;
    }

    Object.assign(existing, args.update);
    return existing;
  }

  /** `include: { deliveries }`, in the order the store asks for. */
  for(notificationId: string): DeliveryRow[] {
    return [...this.rows]
      .filter((row) => row.notification_id === notificationId)
      .sort((left, right) => {
        const delta = left.created_at.getTime() - right.created_at.getTime();
        // Channel name breaks a tie: two channels attempted inside the same millisecond have
        // no other durable order between them, and an unstable one would make a read model
        // differ run to run.
        return delta === 0 ? left.channel.localeCompare(right.channel) : delta;
      });
  }
}

/** `notifications`, keyed by the notification id so `save` is an upsert. */
class FakeNotificationsDelegate {
  readonly rows: NotificationRow[] = [];

  constructor(private readonly deliveries: FakeDeliveriesDelegate) {}

  async upsert(args: {
    where: { id: string };
    create: Partial<NotificationRow> & { id: string };
    update: Partial<NotificationRow>;
  }): Promise<NotificationRow> {
    const existing = this.rows.find((row) => row.id === args.where.id);

    if (!existing) {
      const created = {
        severity: 'normal',
        status: RECORD_STATUS.UNREAD,
        channels: [],
        variables: {},
        payload: {},
        deduplicated: false,
        created_at: new Date(),
        updated_at: new Date(),
        read_at: null,
        ...args.create,
      } as NotificationRow;
      this.rows.push(created);
      return created;
    }

    Object.assign(existing, args.update);
    return existing;
  }

  async findUnique(args: { where: { id: string } }): Promise<(NotificationRow & {
    deliveries: DeliveryRow[];
  }) | null> {
    const row = this.rows.find((candidate) => candidate.id === args.where.id);
    return row ? { ...row, deliveries: this.deliveries.for(row.id) } : null;
  }

  async findMany(args: {
    where: { user_id?: string; status?: string };
    orderBy?: { created_at: 'asc' | 'desc' };
    take?: number;
  }): Promise<(NotificationRow & { deliveries: DeliveryRow[] })[]> {
    const matched = this.rows
      .filter((row) =>
        args.where.user_id === undefined ? true : row.user_id === args.where.user_id,
      )
      .filter((row) =>
        args.where.status === undefined ? true : row.status === args.where.status,
      )
      .sort((left, right) => {
        const delta = left.created_at.getTime() - right.created_at.getTime();
        return args.orderBy?.created_at === 'desc' ? -delta : delta;
      });

    const limited = args.take === undefined ? matched : matched.slice(0, args.take);
    return limited.map((row) => ({ ...row, deliveries: this.deliveries.for(row.id) }));
  }

  async count(args: { where: { user_id?: string; status?: string } }): Promise<number> {
    return (await this.findMany(args)).length;
  }
}

describe('the durable consumer claim', () => {
  const key = claimKeyFor('platform.user.registered.v1', 'event-1');

  it('takes a claim exactly once, even when two replicas race', async () => {
    const outbox = new FakeOutboxDelegate();
    const store = new PrismaConsumerClaimStore(
      fakePrisma(outbox) as never,
      testNotificationConfig(),
    );

    // Both `await`s resolve before either is awaited by the test, which is as close to a
    // concurrent race as a single-threaded runtime gets. The unique index is what decides.
    const [first, second] = await Promise.all([store.claim(key), store.claim(key)]);

    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
    // The loser says *why*, so a consumer can tell "somebody else has this" from "the table
    // is down" — the two need opposite handling.
    const loser = first.claimed ? second : first;
    expect(loser.refusal).toBe('already_claimed');
    expect(outbox.rows).toHaveLength(1);
  });

  it('writes the claim as a terminal row, so the relay never publishes it', async () => {
    const outbox = new FakeOutboxDelegate();
    const store = new PrismaConsumerClaimStore(
      fakePrisma(outbox) as never,
      testNotificationConfig(),
    );

    await store.claim(key);

    const row = outbox.rows[0];
    expect(row.type).toBe(CLAIM_EVENT_TYPE);
    // `pending` here would put an internal bookkeeping row onto a Kafka topic that every other
    // service subscribes to. `published` makes it invisible to the relay permanently.
    expect(row.status).toBe('published');
    expect(row.published_at).not.toBeNull();
    expect(outbox.publishable).toHaveLength(0);
  });

  it('refuses a claim whose key is namespaced away from every event type', async () => {
    const outbox = new FakeOutboxDelegate();
    const store = new PrismaConsumerClaimStore(
      fakePrisma(outbox) as never,
      testNotificationConfig(),
    );

    await store.claim(key);

    expect(CLAIM_EVENT_TYPE).toBe('notification.consumer.claim');
    expect(Object.values(TOPIC_BY_EVENT)).not.toContain(CLAIM_EVENT_TYPE);
  });

  it('releases a claim so a retry can proceed', async () => {
    const outbox = new FakeOutboxDelegate();
    const store = new PrismaConsumerClaimStore(
      fakePrisma(outbox) as never,
      testNotificationConfig(),
    );

    await store.claim(key);
    expect(await store.release(key)).toBe(true);

    // The redelivery that follows a release must be allowed to claim again, or the
    // notification is lost with no error anywhere.
    expect((await store.claim(key)).claimed).toBe(true);
  });

  it('reports that a release found nothing rather than pretending', async () => {
    const outbox = new FakeOutboxDelegate();
    const store = new PrismaConsumerClaimStore(
      fakePrisma(outbox) as never,
      testNotificationConfig(),
    );

    expect(await store.release(key)).toBe(false);
  });

  it('reclaims a claim older than the configured ttl', async () => {
    const outbox = new FakeOutboxDelegate();
    const store = new PrismaConsumerClaimStore(
      fakePrisma(outbox) as never,
      testNotificationConfig({ claimTtlSec: 1 }),
    );

    await store.claim(key);

    // A consumer killed between claiming and releasing holds the claim forever otherwise, and
    // the event it was holding is silently never delivered.
    outbox.rows[0].created_at = new Date(Date.now() - 10_000);

    expect((await store.claim(key)).claimed).toBe(true);
    expect(outbox.rows).toHaveLength(1);
  });

  it('sweeps abandoned claims in bulk', async () => {
    const outbox = new FakeOutboxDelegate();
    const store = new PrismaConsumerClaimStore(
      fakePrisma(outbox) as never,
      testNotificationConfig({ claimTtlSec: 1 }),
    );

    await store.claim(claimKeyFor('t', 'a'));
    await store.claim(claimKeyFor('t', 'b'));
    for (const row of outbox.rows) {
      row.created_at = new Date(Date.now() - 10_000);
    }

    expect(await store.releaseAbandoned(new Date())).toBe(2);
    expect(outbox.rows).toHaveLength(0);
  });

  it('reports whether a key is held', async () => {
    const outbox = new FakeOutboxDelegate();
    const store = new PrismaConsumerClaimStore(
      fakePrisma(outbox) as never,
      testNotificationConfig(),
    );

    expect(await store.isClaimed(key)).toBe(false);
    await store.claim(key);
    expect(await store.isClaimed(key)).toBe(true);
  });

  it('propagates a claim-table failure instead of reporting a refusal', async () => {
    // A refusal means "somebody else has it"; a failure means nothing was claimed and the
    // redelivery must be free. Reporting one as the other turns a database blip into a lost
    // notification.
    const broken = {
      tx: {
        outbox_events: {
          deleteMany: () => Promise.reject(new Error('connection reset')),
          createMany: () => Promise.reject(new Error('connection reset')),
        },
      },
      runInTransaction: (fn: never) => fn,
    };

    const store = new PrismaConsumerClaimStore(broken as never, testNotificationConfig());

    const error = await rejection(store.claim(key));
    expect((error as Error).message).toBe('connection reset');
  });
});

describe('the durable notification record', () => {
  async function saved(
    channels: readonly NotificationChannel[] = [
      NotificationChannel.INAPP,
      NotificationChannel.EMAIL,
    ],
  ) {
    const outbox = new FakeOutboxDelegate();
    const prisma = fakePrisma(outbox);
    const store = new PrismaNotificationStore(prisma as never);
    const handler = new SendNotificationHandler(
      store,
      new TestChannelRegistry(
        channels.map((channel) => new RecordingChannel(channel)),
      ),
    );

    const result = await handler.execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        { email: 'ada.lovelace@example.com', phone: null, deviceToken: null },
        { displayName: 'Ada', source: 'web' },
      ),
    );

    return {
      outbox,
      prisma,
      notifications: prisma.notifications,
      deliveries: prisma.deliveries,
      store,
      result,
    };
  }

  /** Every row the save wrote, across all three tables. */
  const everything = (prisma: ReturnType<typeof fakePrisma>) =>
    JSON.stringify([
      prisma.outbox.rows,
      prisma.notifications.rows,
      prisma.deliveries.rows,
    ]);

  it('commits the record, its deliveries and the announcement in one transaction', async () => {
    const { outbox, notifications, deliveries, prisma, result } = await saved();

    expect(prisma.transactions).toBe(1);

    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0].id).toBe(result.notificationId);
    // A list is a plain equality on an indexed column, not a scan of a JSON payload.
    expect(notifications.rows[0].user_id).toBe(USER_ID);
    expect(notifications.rows[0].status).toBe(RECORD_STATUS.UNREAD);
    expect(notifications.rows[0].read_at).toBeNull();

    expect(deliveries.rows).toHaveLength(2);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].aggregate_id).toBe(result.notificationId);
  });

  it('writes one delivery row per channel, carrying that channel status', async () => {
    const { deliveries, result } = await saved();

    expect(deliveries.rows.map((row) => `${row.channel}:${row.status}`).sort()).toEqual([
      'email:sent',
      'inapp:sent',
    ]);
    for (const row of deliveries.rows) {
      expect(row.notification_id).toBe(result.notificationId);
      expect(row.error).toBeNull();
      // The attempt time, not `now()`: Postgres' `now()` is the transaction start, so every
      // row written in one transaction would otherwise carry the same value and the read
      // order would be arbitrary.
      expect(row.dispatched_at).toBeInstanceOf(Date);
      expect(row.created_at).toEqual(row.dispatched_at);
    }
  });

  it('records a failed channel as its own row, with the error', async () => {
    const outbox = new FakeOutboxDelegate();
    const prisma = fakePrisma(outbox);
    const store = new PrismaNotificationStore(prisma as never);

    await new SendNotificationHandler(
      store,
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.INAPP),
        new FailingChannel(NotificationChannel.EMAIL),
      ]),
    ).execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        { email: 'ada.lovelace@example.com', phone: null, deviceToken: null },
        { displayName: 'Ada', source: 'web' },
      ),
    );

    // "The email failed but the push arrived" is a state the table can hold rather than an
    // error the model refuses to represent.
    const email = prisma.deliveries.rows.find((row) => row.channel === 'email');
    expect(email?.status).toBe('failed');
    expect(email?.error).toContain('provider unavailable');
    expect(prisma.deliveries.rows.find((row) => row.channel === 'inapp')?.status).toBe('sent');
  });

  it('writes no record row to outbox_events', async () => {
    const { outbox, notifications } = await saved();

    // The whole reason this store was split. `notification.record` used to be an
    // `outbox_events` row kept inert by convention — a namespaced `type` and a `status` that
    // was never `pending`. A record written `pending` would have been published to a topic
    // every other service subscribes to, and the table's meaning ("rows the relay publishes")
    // was gone for every reader after it. Pinned by literal: the constant that named this type
    // is deleted, so only a deliberate reintroduction can fail this again.
    expect(outbox.rows.some((row) => row.type === 'notification.record')).toBe(false);
    expect(outbox.rows.map((row) => row.type)).toEqual(['notification.dispatched']);
    // And the record is genuinely somewhere else, not nowhere.
    expect(notifications.rows).toHaveLength(1);
  });

  it('still announces the dispatch into outbox_events, as a publishable row', async () => {
    const { outbox, result } = await saved();

    const announcement = outbox.rows.find((row) => row.type === 'notification.dispatched');

    expect(announcement?.status).toBe('pending');
    expect(announcement?.topic).toBe(NOTIFICATION_TOPICS.DISPATCHED);
    expect(announcement?.aggregate_id).toBe(result.notificationId);
    // `<type>:<aggregateId>:<version>` — the aggregate version, not a clock or a uuid, so a
    // redelivered event lands on the same key and `skipDuplicates` makes it a no-op.
    expect(announcement?.dedup_key).toBe(
      `notification.dispatched:${result.notificationId}:1`,
    );
    // Exactly one row a relay would publish: the announcement and nothing else.
    expect(outbox.publishable).toHaveLength(1);
  });

  it('re-saving the same id updates the record instead of duplicating it', async () => {
    const { store, notifications, deliveries, outbox, result } = await saved();

    const stored = await store.findById(asId(result.notificationId));
    stored?.markRead();
    await store.save(stored as NonNullable<typeof stored>);

    expect(notifications.rows).toHaveLength(1);
    expect(notifications.rows[0].status).toBe(RECORD_STATUS.READ);
    expect(notifications.rows[0].read_at).toBeInstanceOf(Date);
    // Reaching the update branch is the only way that flag can be set, so it is a record of
    // what happened rather than a guess.
    expect(notifications.rows[0].deduplicated).toBe(true);
    // The `(notification_id, channel)` index does the same for deliveries.
    expect(deliveries.rows).toHaveLength(2);
    // A second save of a read notification announces a read, not a second dispatch.
    expect(outbox.rows.map((row) => row.type)).toEqual([
      'notification.dispatched',
      'notification.read',
    ]);
  });

  it('keys the record row on the notification id, so a save is an upsert', async () => {
    const { notifications, result } = await saved();

    expect(notifications.rows[0].id).toBe(result.notificationId);
  });

  it('stores no address and no rendered body', async () => {
    const { prisma } = await saved();

    const serialised = everything(prisma);
    expect(serialised).not.toContain('ada.lovelace@example.com');
    expect(serialised).not.toContain('@example.com');
    expect(serialised).not.toContain('Welcome, Ada');
  });

  it('fails the whole write if a payload would leak, rather than publishing it', async () => {
    const outbox = new FakeOutboxDelegate();
    const prisma = fakePrisma(outbox);
    const store = new PrismaNotificationStore(prisma as never);

    // A store that swallowed the redaction failure would be a store that shipped the address.
    // The guard is in the domain and runs before the transaction opens, so the test proves the
    // call ordering rather than the throw itself.
    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.INAPP),
        new RecordingChannel(NotificationChannel.EMAIL),
      ]),
    ).execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        { email: 'ada.lovelace@example.com', phone: null, deviceToken: null },
        // Stripped by the template schema, so it cannot even reach the announcement.
        { displayName: 'Ada', contact: 'ada.lovelace@example.com' },
      ),
    );

    expect(everything(prisma)).not.toContain('ada.lovelace@example.com');
    expect(result.outcome).toBe('sent');
    // The guard reports what it removed: `contact` never reached the announcement, and the
    // caller is told a producer is putting an address where the template did not declare it.
    expect(result.redactedVariables).toEqual(['contact']);
  });

  it('re-reads a notification it wrote, deliveries and all', async () => {
    const { store, result } = await saved();

    const found = await store.findById(asId(result.notificationId));

    expect(found).not.toBeNull();
    expect(found?.userId).toBe(USER_ID);
    expect(found?.template).toBe(NotificationTemplate.WELCOME);
    expect(found?.severity).toBe('info');
    expect(found?.subject).toBe('Welcome to the platform');
    expect(found?.deliveries).toHaveLength(2);
    expect(found?.channels).toEqual(expect.arrayContaining(['inapp', 'email']));
    expect(found?.isRead).toBe(false);
    expect(found?.readAt).toBeNull();
  });

  it('answers null for a notification that does not exist', async () => {
    const { store } = await saved();

    expect(
      await store.findById(asId('00000000-0000-4000-8000-0000000000aa')),
    ).toBeNull();
  });

  it('lists a user notifications, newest first', async () => {
    const { store } = await saved();
    await new SendNotificationHandler(
      store,
      new TestChannelRegistry([new RecordingChannel(NotificationChannel.INAPP)]),
    ).execute(
      new SendNotificationCommand(
        NotificationTemplate.VERIFY_EMAIL,
        USER_ID,
        { email: null, phone: null, deviceToken: null },
        {},
      ),
    );

    const rows = await store.findByUser(USER_ID);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.userId === USER_ID)).toBe(true);
    // Every channel a notification asked for came back with its own row — two for the welcome,
    // one for the in-app verify.
    expect(rows.every((row) => row.deliveries.length === row.channels.length)).toBe(true);
    // Newest first, which is what the `(user_id, created_at desc)` index is for.
    const timestamps = rows.map((row) => row.createdAt.getTime());
    expect([...timestamps].sort((left, right) => right - left)).toEqual(timestamps);
  });

  it('never lists another user notifications', async () => {
    const { store } = await saved();

    expect(await store.findByUser('00000000-0000-4000-8000-0000000000bb')).toHaveLength(0);
  });

  it('counts unread from the row status, not by filtering a fetch', async () => {
    const { store, result } = await saved();

    expect(await store.countUnread(USER_ID)).toBe(1);

    const stored = await store.findById(asId(result.notificationId));
    stored?.markRead();
    await store.save(stored as NonNullable<typeof stored>);

    // `countUnread` is a `count()` over `user_id`/`status`. A JSON flag would have meant a
    // badge render pulling every notification a user has ever received.
    expect(await store.countUnread(USER_ID)).toBe(0);
    expect((await store.findById(asId(result.notificationId)))?.isRead).toBe(true);
    expect((await store.findById(asId(result.notificationId)))?.readAt).toBeInstanceOf(Date);
  });

  it('filters a list to unread with an indexed equality, not a scan', async () => {
    const { store, result } = await saved();
    const stored = await store.findById(asId(result.notificationId));
    stored?.markRead();
    await store.save(stored as NonNullable<typeof stored>);

    expect(await store.findByUser(USER_ID, { unreadOnly: true })).toHaveLength(0);
    expect(await store.findByUser(USER_ID)).toHaveLength(1);
  });

  it('honours a limit, defaulting to fifty', async () => {
    const { store } = await saved();
    await new SendNotificationHandler(
      store,
      new TestChannelRegistry([new RecordingChannel(NotificationChannel.INAPP)]),
    ).execute(
      new SendNotificationCommand(
        NotificationTemplate.VERIFY_EMAIL,
        USER_ID,
        { email: null, phone: null, deviceToken: null },
        {},
      ),
    );

    expect(await store.findByUser(USER_ID, { limit: 1 })).toHaveLength(1);
  });

  it('does not resolve an announcement row as a notification', async () => {
    // The two tables share a uuid namespace, and the announcement row used to be a record row
    // in disguise. Resolving a dispatch event as a notification would let a caller read the
    // outbox through a query that promises to answer about their own messages.
    const { outbox, store } = await saved();
    const announcement = outbox.rows.find(
      (row) => row.type === 'notification.dispatched',
    );

    expect(
      await store.findById(asId(announcement?.id as string)),
    ).toBeNull();
  });
});

describe('the in-memory adapter keeps the same split', () => {
  /**
   * @remarks The same facts, asserted against the adapter the rest of the suite runs on. A
   * double that filed records as outbox rows would let the behaviour this change removed pass
   * every other test in the suite, so the split is pinned on both implementations.
   */
  async function saved() {
    const store = new InMemoryNotificationStore((type) => `local.${type}`);

    const result = await new SendNotificationHandler(
      store,
      new TestChannelRegistry([
        new RecordingChannel(NotificationChannel.INAPP),
        new RecordingChannel(NotificationChannel.EMAIL),
      ]),
    ).execute(
      new SendNotificationCommand(
        NotificationTemplate.WELCOME,
        USER_ID,
        { email: 'ada.lovelace@example.com', phone: null, deviceToken: null },
        { displayName: 'Ada', source: 'web' },
      ),
    );

    return { store, result };
  }

  it('records one row per channel, and puts only the announcement in the outbox', async () => {
    const { store, result } = await saved();

    expect([...store.records.keys()]).toEqual([result.notificationId]);
    expect(store.deliveries.map((row) => `${row.channel}:${row.status}`).sort()).toEqual([
      'email:sent',
      'inapp:sent',
    ]);
    expect(store.outbox.map((row) => row.type)).toEqual(['notification.dispatched']);
    expect(store.outbox.some((row) => row.type === 'notification.record')).toBe(false);
  });

  it('updates a delivery row on re-save instead of appending a second', async () => {
    const { store, result } = await saved();

    const stored = await store.findById(asId(result.notificationId));
    stored?.recordDelivery({
      channel: NotificationChannel.EMAIL,
      status: 'failed',
      error: 'provider unavailable',
      deliveredAt: new Date(),
    });
    await store.save(stored as NonNullable<typeof stored>);

    expect(store.records.size).toBe(1);
    expect(store.deliveries).toHaveLength(2);
    // A retry that fails must leave one outcome for that channel, not `sent, failed`.
    expect(store.deliveryFor(result.notificationId, NotificationChannel.EMAIL)).toMatchObject({
      status: 'failed',
      error: 'provider unavailable',
    });
    expect(store.announcementsFor('notification.read')).toHaveLength(0);
  });

  it('answers the same list and status answers it always did', async () => {
    const { store, result } = await saved();

    expect(await store.countUnread(USER_ID)).toBe(1);
    expect((await store.findByUser(USER_ID)).map((row) => row.id.value)).toEqual([
      result.notificationId,
    ]);

    const stored = await store.findById(asId(result.notificationId));
    stored?.markRead();
    await store.save(stored as NonNullable<typeof stored>);

    expect(await store.countUnread(USER_ID)).toBe(0);
    expect(await store.findByUser(USER_ID, { unreadOnly: true })).toHaveLength(0);
    expect((await store.findById(asId(result.notificationId)))?.isRead).toBe(true);
  });
});

describe('configuration', () => {
  it('reads its own namespace and ignores everything else', () => {
    const config = resolveNotificationConfig({
      NOTIFICATION_CLAIM_TTL_SEC: '120',
      NOTIFICATION_LOG_BODIES: 'yes',
      KAFKA_GROUP_ID: 'ignored',
      DATABASE_URL: 'postgres://nope',
    });

    expect(config.claimTtlSec).toBe(120);
    expect(config.logBodies).toBe(true);
    // A module that could reconfigure its own connection would make "one service, one
    // database" unenforceable.
    expect(Object.keys(config)).not.toContain('DATABASE_URL');
  });

  it('defaults to logging no bodies', () => {
    expect(resolveNotificationConfig({}).logBodies).toBe(false);
  });

  it('refuses a store mode it does not have, at boot', () => {
    // A typo would otherwise resolve to `undefined`, match no branch in the module factory, and
    // leave the store unbound: a service that boots and cannot record anything it sends.
    expect(() => resolveNotificationConfig({ NOTIFICATION_STORE_MODE: 'postgres' })).toThrow(
      'NOTIFICATION_STORE_MODE must be one of prisma, memory',
    );
  });

  it('accepts `memory` for a deployment that has no database', () => {
    expect(
      resolveNotificationConfig({ NOTIFICATION_STORE_MODE: 'MEMORY' }).storeMode,
    ).toBe('memory');
  });

  it('rejects a value outside the range rather than clamping it silently', () => {
    expect(() => resolveNotificationConfig({ NOTIFICATION_CLAIM_TTL_SEC: '0' })).toThrow(
      'NOTIFICATION_CLAIM_TTL_SEC',
    );
    expect(() => resolveNotificationConfig({ NOTIFICATION_MAX_PAGE_SIZE: 'nope' })).toThrow(
      'NOTIFICATION_MAX_PAGE_SIZE',
    );
  });

  it('rejects a boolean that is neither on nor off', () => {
    // `Boolean('false')` is `true`, which is how a disabled-by-default feature turns on in
    // production and nobody notices until it emails every user. Note the message: a zod
    // transform that throws propagates its own text rather than the namespace wrapper, so
    // this one names the value and not the variable.
    expect(() => resolveNotificationConfig({ NOTIFICATION_LOG_BODIES: 'maybe' })).toThrow(
      'Expected a boolean, received "maybe"',
    );
    expect(resolveNotificationConfig({ NOTIFICATION_LOG_BODIES: 'off' }).logBodies).toBe(
      false,
    );
  });
});

function asId(value: string): NotificationId {
  return NotificationId.create(value);
}