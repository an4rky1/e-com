/**
 * In-memory doubles and builders for the notification suite.
 *
 * @remarks Hand-written rather than generated, for the same reason as every other service's
 * fakes: the interesting assertions here are about what *left* the service, so the doubles
 * have to be observable. `RecordingChannel` logs every message it was asked to deliver,
 * `InMemoryClaimStore` records which keys are held and in what order, and `InMemoryNotificationStore`
 * keeps the outbox rows a durable `save` would have inserted so a redaction test has something
 * to read.
 *
 * @remarks No Nest bootstrap and no database. Every test below constructs its handlers
 * directly, which is what keeps the idempotency tests fast enough to actually run.
 */
import type { ConsumedMessage } from '@auth/infra/kafka';
import type {
  NotificationChannelPort,
  NotificationChannelRegistry,
  NotificationDeliveryReceipt,
  NotificationMessage,
  NotificationRecipient,
} from '../../src/domain/ports/notification-channel.port';
import {
  ClaimRefusal,
  type ClaimResult,
  type ConsumerClaimStorePort,
} from '../../src/domain/ports/consumer-claim.port';
import {
  DeliveryStatus,
  type NotificationChannel,
} from '../../src/domain/value-objects/notification-channel.vo';
import { NotificationId as NotificationIdVO } from '../../src/domain/value-objects/notification-id.vo';
import type {
  NotificationDispatcherPort,
} from '../../src/application/ports/notification-dispatcher.port';
import type {
  MarkNotificationReadCommand,
  MarkNotificationReadResult,
  SendNotificationCommand,
  SendNotificationResult,
} from '../../src/application/commands/notification.commands';
import type { NotificationConfig } from '../../src/notification.config';

/** A user id that is a valid v4 UUID, so the kernel's `EntityId` accepts it. */
export const USER_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const OTHER_USER_ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
export const EMAIL = 'ada@example.com';
export const PHONE = '+15550100';
export const DEVICE_TOKEN = 'device-token-abc';

/** A config built literally, so no test ever reads `process.env`. */
export const testNotificationConfig = (
  overrides: Partial<NotificationConfig> = {},
): NotificationConfig => ({
  claimTtlSec: 900,
  maxPageSize: 100,
  logBodies: false,
  deadLetterEnabled: true,
  storeMode: 'prisma',
  ...overrides,
});

/** A recipient with every address this service knows how to reach. */
export const fullRecipient = (
  overrides: Partial<NotificationRecipient> = {},
): NotificationRecipient => ({
  email: EMAIL,
  phone: PHONE,
  deviceToken: DEVICE_TOKEN,
  ...overrides,
});

// ---- channels ------------------------------------------------------------------

/** A channel adapter that records what it was asked to deliver. */
export class RecordingChannel implements NotificationChannelPort {
  /** Every message handed to this adapter, in call order. */
  readonly delivered: NotificationMessage[] = [];

  constructor(
    readonly channel: NotificationChannel,
    private readonly reachable = true,
  ) {}

  supports(): boolean {
    return this.reachable;
  }

  async deliver(message: NotificationMessage): Promise<NotificationDeliveryReceipt> {
    this.delivered.push(message);
    return {
      channel: this.channel,
      status: DeliveryStatus.SENT,
      providerMessageId: `${this.channel}-${this.delivered.length}`,
      deliveredAt: new Date(),
    };
  }
}

/** A channel adapter that always fails. The whole point is that it must not stop the others. */
export class FailingChannel implements NotificationChannelPort {
  calls = 0;

  constructor(
    readonly channel: NotificationChannel,
    private readonly message = 'provider unavailable',
  ) {}

  supports(): boolean {
    return true;
  }

  async deliver(): Promise<NotificationDeliveryReceipt> {
    this.calls += 1;
    throw new Error(this.message);
  }
}

/** A channel adapter bound but unreachable — as opposed to unbound, which is `null`. */
export class UnreachableChannel implements NotificationChannelPort {
  constructor(readonly channel: NotificationChannel) {}

  supports(): boolean {
    return false;
  }

  async deliver(message: NotificationMessage): Promise<NotificationDeliveryReceipt> {
    return {
      channel: this.channel,
      status: DeliveryStatus.SKIPPED,
      deliveredAt: new Date(),
      providerMessageId: message.notificationId,
    };
  }
}

/** A registry over an explicit adapter list, so a test can leave a channel unbound. */
export class TestChannelRegistry implements NotificationChannelRegistry {
  private readonly adapters = new Map<NotificationChannel, NotificationChannelPort>();

  constructor(adapters: readonly NotificationChannelPort[] = []) {
    for (const adapter of adapters) this.adapters.set(adapter.channel, adapter);
  }

  resolve(channel: NotificationChannel): NotificationChannelPort | null {
    return this.adapters.get(channel) ?? null;
  }

  available(): readonly NotificationChannel[] {
    return [...this.adapters.keys()];
  }

  get unavailableReason(): string {
    return 'unbound in this test';
  }

  /** Every channel any adapter actually received a message on. */
  get deliveredOn(): readonly NotificationChannel[] {
    return [...this.adapters.entries()]
      .filter(([, adapter]) =>
        adapter instanceof RecordingChannel && adapter.delivered.length > 0,
      )
      .map(([channel]) => channel);
  }
}

// ---- consumer claims -----------------------------------------------------------

/** The claim store, in memory, with the claim history a test needs to assert on. */
export class InMemoryClaimStore implements ConsumerClaimStorePort {
  /** Key -> the moment it was claimed. */
  private readonly held = new Map<string, Date>();

  /** Every key in the order it was claimed. */
  readonly claimLog: string[] = [];

  /** Every key in the order it was released. */
  readonly releaseLog: string[] = [];

  /** Thrown from `claim` when set, so a test can simulate an unavailable database. */
  failNextClaim: Error | null = null;

  /** Thrown from `release` when set, so a test can prove the original failure survives. */
  failNextRelease: Error | null = null;

  async claim(key: string): Promise<ClaimResult> {
    if (this.failNextClaim) {
      const error = this.failNextClaim;
      this.failNextClaim = null;
      throw error;
    }

    if (this.held.has(key)) {
      return { claimed: false, refusal: ClaimRefusal.ALREADY_CLAIMED };
    }

    this.held.set(key, new Date());
    this.claimLog.push(key);
    return { claimed: true };
  }

  async release(key: string): Promise<boolean> {
    if (this.failNextRelease) {
      const error = this.failNextRelease;
      this.failNextRelease = null;
      throw error;
    }

    this.releaseLog.push(key);
    return this.held.delete(key);
  }

  async isClaimed(key: string): Promise<boolean> {
    return this.held.has(key);
  }

  async releaseAbandoned(olderThan: Date): Promise<number> {
    let released = 0;
    for (const [key, claimedAt] of [...this.held.entries()]) {
      if (claimedAt < olderThan) {
        this.held.delete(key);
        this.releaseLog.push(key);
        released += 1;
      }
    }
    return released;
  }

  /** How many claims are currently held. The invariant every idempotency test turns on. */
  get heldCount(): number {
    return this.held.size;
  }
}

// ---- dispatcher ----------------------------------------------------------------

/** Throws on every send, so a test can prove the claim is released on failure. */
export class FailingDispatcher implements NotificationDispatcherPort {
  calls = 0;

  constructor(private readonly message = 'the notification store is unavailable') {}

  async send(): Promise<SendNotificationResult> {
    this.calls += 1;
    throw new Error(this.message);
  }

  async markRead(): Promise<MarkNotificationReadResult> {
    this.calls += 1;
    throw new Error(this.message);
  }
}

/** Records what the processor asked for, without running a handler. */
export class RecordingDispatcher implements NotificationDispatcherPort {
  readonly sent: SendNotificationCommand[] = [];
  readonly marked: MarkNotificationReadCommand[] = [];

  async send(command: SendNotificationCommand): Promise<SendNotificationResult> {
    this.sent.push(command);

    return {
      notificationId: `0000000${this.sent.length}-4000-8000-000000000000`,
      template: command.template,
      outcome: 'sent',
      deliveries: [],
      redactedVariables: [],
    };
  }

  async markRead(command: MarkNotificationReadCommand): Promise<MarkNotificationReadResult> {
    this.marked.push(command);
    return {
      notificationId: command.notificationId.value,
      read: true,
      readAt: new Date().toISOString(),
      changed: true,
    };
  }
}

// ---- messages ------------------------------------------------------------------

export interface EventOverrides {
  readonly eventId?: string;
  readonly traceId?: string;
  readonly attempt?: number;
  readonly partition?: number;
  readonly offset?: string;
}

/** Builds a `ConsumedMessage` carrying a well-formed integration event. */
export const eventMessage = (
  topic: string,
  payload: Readonly<Record<string, unknown>>,
  overrides: EventOverrides = {},
): ConsumedMessage<unknown> => ({
  topic,
  partition: overrides.partition ?? 0,
  offset: overrides.offset ?? '42',
  traceId: overrides.traceId ?? '11111111-2222-4333-8444-555555555555',
  attempt: overrides.attempt ?? 1,
  payload: {
    eventId: overrides.eventId ?? '33333333-4444-4555-8666-777777777777',
    type: topic,
    schemaVersion: 1,
    occurredAt: '2026-01-01T00:00:00.000Z',
    aggregateId: USER_ID,
    aggregateType: 'user',
    partitionKey: USER_ID,
    payload,
  },
});

/** Builds a message whose payload is *not* an integration event at all. */
export const rawMessage = (
  topic: string,
  payload: unknown,
  overrides: EventOverrides = {},
): ConsumedMessage<unknown> => ({
  topic,
  partition: overrides.partition ?? 0,
  offset: overrides.offset ?? '7',
  traceId: overrides.traceId,
  attempt: overrides.attempt ?? 1,
  payload,
});

/** A valid notification id, as a string. */
export const notificationId = (seed = 1): string =>
  `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;

export const asNotificationId = (value: string): NotificationIdVO =>
  NotificationIdVO.create(value);