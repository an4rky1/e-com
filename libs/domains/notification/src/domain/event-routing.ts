/**
 * @fileoverview Which event produces which notification, and with what.
 *
 * @remarks One table, one direction. The event catalogue is a contract; this file is the part
 * of it this service acts on. Adding a route is one entry — a scattered `switch (topic)` in a
 * handler is how `platform.security.anomaly_detected.v1` ends up subscribed but unrouted, so
 * the message is consumed, acknowledged and silently produces nothing.
 *
 * @remarks Address fields are read into the *recipient*, never into template variables. That
 * split is the reason a `welcome` email can be delivered to an address while no published
 * event ever carries one: `UserRegisteredPayload` has an `email` in it, and the only correct
 * places for that value are a provider SDK call and a column marked publishable=false.
 *
 * @remarks Topics this service does not route are simply absent from the table, so an event
 * arriving on one is a contract change and shows up as a dead letter naming the topic — not as
 * a silent no-op.
 */
import { Topics, type Topic } from '@auth/contracts';
import { orderedChannels } from './templates/notification-templates';
import { NotificationChannel } from './value-objects/notification-channel.vo';
import { NotificationTemplate } from './value-objects/notification-template.vo';
import type { NotificationRecipient } from './notification.aggregate';

/** Fields a producer might use to name the user, most specific first. */
const USER_ID_FIELDS = ['userId', 'accountId', 'ownerId'] as const;

/** Address-shaped payload fields, mapped to the channel they can reach. */
const ADDRESS_FIELDS: Readonly<
  Record<Exclude<NotificationChannel, 'inapp'>, readonly string[]>
> = {
  email: ['email', 'emailAddress', 'primaryEmail'],
  sms: ['phone', 'phoneNumber', 'msisdn', 'e164Phone'],
  push: ['deviceToken', 'pushToken', 'fcmToken'],
};

const stringOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const stringOfField = (
  payload: Readonly<Record<string, unknown>>,
  field: string,
): string | null => {
  const direct = stringOf(payload[field]);
  if (direct !== null) return direct;

  // Producers nest the address under `recipient` or `contact` about as often as they put it
  // at the top level; looking one level down is what stops half the catalogue being
  // un-deliverable for a purely cosmetic difference in payload shape.
  for (const container of ['recipient', 'contact', 'user']) {
    const nested = payload[container];
    if (typeof nested !== 'object' || nested === null) continue;

    const found = stringOf((nested as Record<string, unknown>)[field]);
    if (found !== null) return found;
  }

  return null;
};

/** Picks up every address the payload carries, in any of the shapes producers use. */
export function recipientFrom(
  payload: Readonly<Record<string, unknown>>,
): NotificationRecipient {
  return {
    email: ADDRESS_FIELDS.email
      .map((field) => stringOfField(payload, field))
      .find((value): value is string => value !== null) ?? null,
    phone: ADDRESS_FIELDS.sms
      .map((field) => stringOfField(payload, field))
      .find((value): value is string => value !== null) ?? null,
    deviceToken: ADDRESS_FIELDS.push
      .map((field) => stringOfField(payload, field))
      .find((value): value is string => value !== null) ?? null,
  };
}

/** The user a notification is for, or `null` when the payload does not identify one. */
export function userIdFrom(payload: Readonly<Record<string, unknown>>): string | null {
  for (const field of USER_ID_FIELDS) {
    const found = stringOfField(payload, field);
    if (found !== null) return found;
  }
  return null;
}

export interface EventRoute {
  readonly topic: Topic;
  readonly template: NotificationTemplate;
  /**
   * Builds template variables from the payload.
   *
   * @remarks Sees the raw payload and must return only variables its template declares.
   * Everything it returns goes through the template schema, which strips the rest — but the
   * schema is the last line, not the first, so this is written to be narrow.
   */
  readonly variablesFrom: (
    payload: Readonly<Record<string, unknown>>,
    now: Date,
  ) => Readonly<Record<string, unknown>>;
  /** Channels that carry a strong "tell the user now" signal. */
  readonly channels?: readonly NotificationChannel[];
}

const text = (
  payload: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined => stringOf(payload[field]) ?? undefined;

const number = (
  payload: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined => {
  const raw = payload[field];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * The route table.
 *
 * @remarks Every entry states its template variables explicitly, including the ones the
 * template schema would default. Explicit is worth the repetition here because the test that
 * keeps this table honest asserts the *exact* variable map — a producer rename that changes a
 * body should change a failing test, not a rendered string.
 */
export const EVENT_ROUTES: readonly EventRoute[] = [
  {
    topic: Topics.USER_REGISTERED,
    template: NotificationTemplate.WELCOME,
    variablesFrom: (payload) => ({
      displayName: text(payload, 'displayName') ?? 'there',
      source: text(payload, 'source') ?? 'web',
    }),
  },
  {
    topic: Topics.USER_EMAIL_VERIFIED,
    template: NotificationTemplate.VERIFY_EMAIL,
    variablesFrom: () => ({}),
  },
  {
    topic: Topics.USER_PASSWORD_CHANGED,
    template: NotificationTemplate.PASSWORD_CHANGED,
    variablesFrom: (_payload, now) => ({ changedAt: now.toISOString() }),
  },
  {
    topic: Topics.USER_LOCKED,
    template: NotificationTemplate.ACCOUNT_LOCKED,
    variablesFrom: (payload) => ({
      reason: text(payload, 'reason'),
      lockedUntil: text(payload, 'lockedUntil'),
    }),
  },
  {
    topic: Topics.USER_UNLOCKED,
    template: NotificationTemplate.ACCOUNT_UNLOCKED,
    variablesFrom: () => ({}),
  },
  {
    topic: Topics.USER_DELETED,
    template: NotificationTemplate.ACCOUNT_DELETED,
    variablesFrom: () => ({}),
    // Only the address that made the account exists can be told it is gone, and only that
    // one. There is nowhere else to send a "your account is closed" notice.
    channels: [NotificationChannel.EMAIL],
  },
  {
    topic: Topics.SESSION_REVOKED,
    template: NotificationTemplate.SESSION_REVOKED,
    variablesFrom: (payload) => ({
      reason: text(payload, 'reason') ?? 'unspecified',
      allSessions: payload['allSessions'] === true ? 'true' : 'false',
    }),
  },
  {
    topic: Topics.SESSION_TOKEN_REUSE_DETECTED,
    template: NotificationTemplate.SUSPICIOUS_REUSE,
    // The strongest signal the platform has: a replayed refresh token means the credentials
    // are in someone else's hands. It goes out on every channel that exists.
    channels: [
      NotificationChannel.INAPP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
      NotificationChannel.EMAIL,
    ],
    variablesFrom: (_payload, now) => ({
      revokedCount: number(_payload, 'revokedCount') ?? 0,
      detectedAt: now.toISOString(),
    }),
  },
  {
    topic: Topics.SECURITY_NEW_DEVICE_DETECTED,
    template: NotificationTemplate.NEW_DEVICE,
    variablesFrom: (payload) => ({
      deviceLabel: text(payload, 'deviceLabel') ?? 'An unrecognised device',
      ipAddress: text(payload, 'ipAddress') ?? 'an unknown location',
    }),
  },
  {
    topic: Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED,
    template: NotificationTemplate.SUSPICIOUS_LOGIN,
    variablesFrom: (payload) => ({
      riskLevel: text(payload, 'riskLevel') ?? 'medium',
      riskScore: number(payload, 'riskScore') ?? 0,
      ipAddress: text(payload, 'ipAddress') ?? 'an unknown location',
    }),
  },
  {
    topic: Topics.SECURITY_ANOMALY_DETECTED,
    template: NotificationTemplate.SECURITY_ANOMALY,
    variablesFrom: (payload) => ({
      riskLevel: text(payload, 'riskLevel') ?? 'medium',
      summary: text(payload, 'summary'),
    }),
  },
  {
    topic: Topics.ROLE_GRANTED,
    template: NotificationTemplate.ROLE_GRANTED,
    variablesFrom: (payload) => ({
      role: text(payload, 'role') ?? 'unknown',
      grantedBy: text(payload, 'grantedBy'),
    }),
  },
  {
    topic: Topics.ROLE_REVOKED,
    template: NotificationTemplate.ROLE_REVOKED,
    variablesFrom: (payload) => ({
      role: text(payload, 'role') ?? 'unknown',
      reason: text(payload, 'reason'),
    }),
  },
  {
    topic: Topics.AUTH_FLOW_FAILED,
    template: NotificationTemplate.AUTH_FLOW_FAILED,
    variablesFrom: (payload) => ({
      flow: text(payload, 'flow') ?? 'sign-in',
      reason: text(payload, 'reason') ?? 'unspecified',
    }),
  },
  {
    topic: Topics.MFA_ENROLLED,
    template: NotificationTemplate.MFA_ENROLLED,
    variablesFrom: (payload) => ({ method: text(payload, 'method') ?? 'unknown' }),
  },
  {
    topic: Topics.MFA_FAILED,
    template: NotificationTemplate.MFA_FAILED,
    channels: [
      NotificationChannel.INAPP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
      NotificationChannel.EMAIL,
    ],
    variablesFrom: (payload) => ({
      method: text(payload, 'method') ?? 'unknown',
      attempt: number(payload, 'attempt'),
    }),
  },
  {
    topic: Topics.CREDENTIAL_ROTATED,
    template: NotificationTemplate.CREDENTIAL_ROTATED,
    variablesFrom: (payload) => ({ method: text(payload, 'method') ?? 'password' }),
  },
];

const ROUTES_BY_TOPIC: ReadonlyMap<string, EventRoute> = new Map(
  EVENT_ROUTES.map((route) => [route.topic, route]),
);

/** Topics this service subscribes to. Empty means "no notification events at all". */
export const SUBSCRIBED_TOPICS: readonly Topic[] = EVENT_ROUTES.map(
  (route) => route.topic,
);

/** The route for a topic, or `null` when this service does not act on it. */
export function routeFor(topic: string): EventRoute | null {
  return ROUTES_BY_TOPIC.get(topic) ?? null;
}

/** What a resolved route says to send. Ready for `SendNotificationCommand`. */
export interface NotificationInstruction {
  readonly userId: string;
  readonly template: NotificationTemplate;
  readonly recipient: NotificationRecipient;
  /**
   * Channel override, or `undefined` to use the template's own channels.
   *
   * @remarks An override rather than a merge, because the two cases that declare one want
   * opposite things: `user.deleted` must be *narrowed* to the one channel that still has an
   * address, and a replayed refresh token must be *widened* to every channel. A merge could
   * express neither.
   */
  readonly channels?: readonly NotificationChannel[];
  readonly variables: Readonly<Record<string, unknown>>;
}

export type RouteResolution =
  | { readonly ok: true; readonly instruction: NotificationInstruction }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

/**
 * Turns an event payload into something sendable.
 *
 * @remarks Reports failure instead of throwing. A payload with no `userId` is a producer bug,
 * and a consumer that turns a producer bug into an exception takes its own partition down with
 * it. The caller dead-letters the reason, which is what makes the bug visible on the topic
 * rather than in a retry loop that never converges.
 *
 * @remarks The recipient is read but the channels are not narrowed to what it can reach. A
 * security template that cannot reach an SMS is *not* quietly downgraded: the dispatch loop
 * records `skipped` against that channel so "we could not text you" is visible, instead of
 * the notification reading as fully delivered.
 */
export function resolveRoute(
  route: EventRoute,
  payload: Readonly<Record<string, unknown>>,
  now: Date = new Date(),
): RouteResolution {
  const userId = userIdFrom(payload);
  if (userId === null) {
    return {
      ok: false,
      reason: 'no-recipient-identity',
      detail: `payload carries none of ${USER_ID_FIELDS.join(', ')}`,
    };
  }

  return {
    ok: true,
    instruction: {
      userId,
      template: route.template,
      recipient: recipientFrom(payload),
      ...(route.channels ? { channels: orderedChannels(route.channels) } : {}),
      variables: route.variablesFrom(payload, now),
    },
  };
}