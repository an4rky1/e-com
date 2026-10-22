/**
 * @fileoverview Where a notification is *not* allowed to go.
 *
 * @remarks The redaction rules live in the domain, not in the persistence adapter, for one
 * reason: they have to be unit-testable without a database, and the adapter is only exercised
 * by an integration test nobody runs. A rule that can only be verified end to end is a rule
 * that gets removed the first time it is slow.
 *
 * @remarks Two independent guards, because they fail differently. The *structural* one is the
 * field list in {@link toAnnouncementPayload}: it names exactly what may leave, so an address
 * has no path into the payload. The *content* one scans the values that survived it for
 * address- and token-shaped text, which is what catches a variable a producer invented and a
 * template declared — the case a field list alone cannot see coming.
 */
import type {
  DeliveryStatus,
  NotificationChannel,
  NotificationSeverity,
} from './value-objects/notification-channel.vo';
import type {
  NotificationVariables,
  NotificationTemplate,
} from './value-objects/notification-template.vo';
import type { Notification } from './notification.aggregate';

/**
 * Keys that must never appear in a published payload.
 *
 * @remarks A guard, not a convention. Templates already validate their variables, and a later
 * edit that adds a `resetLink` to one "so the email body is complete" would otherwise ship a
 * live reset token to a Kafka topic with a retention measured in days — from which every
 * future consumer, every replay and every log dump could read it.
 */
export const FORBIDDEN_PAYLOAD_KEY =
  /email|phone|address|recipient|^to$|token|secret|password|credential|digest|otp|^code$|link|reset|cookie|session|api[-_]?key|bearer|jwt|salt/i;

/** What an address looks like once it is a string in a JSON column. */
const EMAIL_SHAPED = /[^\s@,;"']+@[^\s@,;"']+\.[^\s@,;"']+/;

/**
 * A reset token or a bearer token: a long opaque run of URL-safe base64.
 *
 * @remarks Anchored, because this asks "is this *whole* value a secret?" — a `riskScore` of
 * `91` is not, and neither is a `riskLevel`. The unanchored {@link TOKEN_SHAPED_RUN} is the
 * one that finds a credential quoted inside a sentence.
 */
const TOKEN_SHAPED = /^[A-Za-z0-9_-]{24,}$/;

/** The same shape, found anywhere inside a longer string. */
const TOKEN_SHAPED_RUN = /[A-Za-z0-9_-]{24,}/g;

/**
 * A UUID is opaque and long, and this service is full of them.
 *
 * @remarks Excluded from {@link TOKEN_SHAPED} so `notificationId` and `userId` do not read as
 * leaked credentials. They are the identifiers consumers join on; treating them as secrets
 * would mean stripping exactly the fields the event exists to carry.
 */
const UUID_SHAPED =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One channel's outcome, as published. */
export interface AnnouncementDelivery {
  readonly channel: NotificationChannel;
  readonly status: DeliveryStatus;
  /**
   * Why a channel failed, truncated and provider-message-id free.
   *
   * @remarks A provider's own message id is *not* published. It is long, opaque, and
   * URL-safe — the exact shape a leaked token has — and it is bookkeeping for a support
   * conversation rather than a fact about the user.
   */
  readonly error?: string;
}

/**
 * The outbound shape of a notification.
 *
 * @remarks Everything here is either an identifier this service minted or a status. Note what
 * is absent and why: no `recipient`, no `email`, no rendered `body`, and no template
 * `variables` that failed the content guard. The body in particular is not an oversight — a
 * rendered body embeds a display name and, in most templates, an address, and publishing it
 * would put both on a topic.
 */
export interface NotificationAnnouncement {
  readonly notificationId: string;
  readonly userId: string;
  readonly template: NotificationTemplate;
  readonly severity: NotificationSeverity;
  readonly subject: string;
  readonly channels: readonly NotificationChannel[];
  readonly deliveries: readonly AnnouncementDelivery[];
  readonly variables: NotificationVariables;
  /**
   * Names of the variables the content guard removed, never their values.
   *
   * @remarks The names are worth publishing: a producer that starts sending an address as a
   * template variable is a bug in the *producer*, and an operator reading only the topic would
   * otherwise have no evidence of it. The names carry that evidence without the value.
   */
  readonly redactedVariables: readonly string[];
  readonly createdAt: string;
}

/**
 * Narrows an arbitrary record to a flat string map.
 *
 * @remarks Stringifies rather than rejects. Every template schema is built from `z.string()`
 * fields, so this only ever has to cope with what Zod already validated; refusing here would
 * turn a schema mistake into an opaque failure three layers away from its cause.
 */
export function toVariableMap(value: unknown): NotificationVariables {
  if (typeof value !== 'object' || value === null) return {};

  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined || entry === null) continue;
    output[key] = String(entry);
  }
  return output;
}

/**
 * Removes values that must not leave this service.
 *
 * @remarks Names are reported instead of the fact being hidden. A template whose variable was
 * dropped is a template that renders with a hole in it, and an operator who can see *which*
 * one can fix the producer instead of guessing from a support ticket.
 */
export function redactVariables(variables: NotificationVariables): {
  variables: NotificationVariables;
  redacted: readonly string[];
} {
  const kept: Record<string, string> = {};
  const redacted: string[] = [];

  for (const [key, value] of Object.entries(variables)) {
    if (
      FORBIDDEN_PAYLOAD_KEY.test(key) ||
      EMAIL_SHAPED.test(value) ||
      TOKEN_SHAPED.test(value)
    ) {
      redacted.push(key);
      continue;
    }
    kept[key] = value;
  }

  return { variables: kept, redacted: redacted.sort() };
}

/**
 * Longest error text kept on a delivery record.
 *
 * @remarks A provider's exception can be several kilobytes of stack, and a row that grows to
 * fit one is a row that pushes everything else out of a result set.
 */
export const MAX_DELIVERY_ERROR_LENGTH = 500;

/**
 * Scrubs a provider error before it is stored.
 *
 * @remarks Provider error strings are the least predictable text this service ever handles,
 * and the most likely to carry something sensitive: "invalid api key sk_live_4eC39…", "no
 * verified address for ada@example.com". Truncation alone is not enough, because the sensitive
 * part is usually at the *start* of the message.
 *
 * @remarks Scrubbed rather than rejected, because an error is not a fact about the user —
 * dropping the whole delivery because a provider quoted a key would turn a one-line config
 * mistake into a lost notification. The unscrubbed text goes to the log, where it belongs and
 * where redaction is somebody else's access-control problem.
 */
export function sanitiseDeliveryError(error: string): string {
  return error
    .slice(0, MAX_DELIVERY_ERROR_LENGTH)
    // The unanchored runs, deliberately: the sensitive part of a provider error is almost
    // always *inside* a sentence ("invalid api key sk_live_…"), never the whole of it.
    .replace(new RegExp(EMAIL_SHAPED.source, 'g'), '[redacted-email]')
    .replace(TOKEN_SHAPED_RUN, '[redacted-token]');
}

/**
 * Fails when a payload is about to leave the service carrying something it must not.
 *
 * @remarks Throws rather than filters. By the time this runs the structural guard has already
 * chosen the fields and {@link sanitiseDeliveryError} has run, so a hit means someone added a
 * field to the list — a decision somebody made deliberately. Silently dropping it would let
 * the decision stand while the payload said something other than what was decided.
 */
export function assertPublishable(announcement: NotificationAnnouncement): void {
  for (const [path, value] of flatten(announcement)) {
    if (typeof value !== 'string') continue;
    if (EMAIL_SHAPED.test(value)) {
      throw new Error(
        `refusing to publish notification announcement: ${path} carries an email address`,
      );
    }
    if (TOKEN_SHAPED.test(value) && !UUID_SHAPED.test(value)) {
      throw new Error(
        `refusing to publish notification announcement: ${path} carries a token-shaped value`,
      );
    }
  }
}

/**
 * The announcement a store writes beside the record.
 *
 * @remarks Lives here rather than in each store adapter, because "what leaves this service" is
 * a decision, not an implementation detail: two adapters that each built their own payload
 * would be two definitions of it, and the one nobody reads would be the one that leaked.
 *
 * @remarks The field list *is* the structural guard. There is no code path from
 * `notification.recipient` or `notification.body` to the result, so an address cannot reach a
 * topic even before {@link assertPublishable} is given a chance to object.
 */
export function announcementFor(notification: Notification): NotificationAnnouncement {
  const announcement: NotificationAnnouncement = {
    notificationId: notification.id.value,
    userId: notification.userId,
    template: notification.template,
    severity: notification.severity,
    subject: notification.subject,
    channels: notification.channels,
    deliveries: notification.deliveries.map((delivery) => ({
      channel: delivery.channel,
      status: delivery.status,
      ...(delivery.error ? { error: delivery.error } : {}),
    })),
    variables: notification.variables,
    redactedVariables: notification.redactedVariables,
    createdAt: notification.createdAt.toISOString(),
  };

  assertPublishable(announcement);
  return announcement;
}

/** `a.b[0]` for every string leaf, so a rejection names the field that caused it. */
function* flatten(
  value: unknown,
  path = '$',
): Generator<[string, unknown]> {
  if (value === null || typeof value !== 'object') {
    yield [path, value];
    return;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      yield* flatten(entry, `${path}[${index}]`);
    }
    return;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    yield* flatten(entry, `${path}.${key}`);
  }
}