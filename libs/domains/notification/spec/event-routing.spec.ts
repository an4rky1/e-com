/**
 * Every event in the catalogue maps to the template a user should receive.
 *
 * @remarks This is the suite that keeps the route table and the template catalogue honest with
 * each other. Both are `Record`s over closed unions, so the compiler guarantees each *name*
 * resolves; it guarantees nothing about whether the mapping is the right one. That is a
 * product decision, and a product decision with a test is the only kind that survives a
 * refactor.
 *
 * @remarks The table is written out longhand rather than derived from `EVENT_ROUTES`. A test
 * that asserted `routeFor(topic).template === EVENT_ROUTES.find(...)` would pass no matter
 * what the table said, and a test nobody can read is a test nobody fixes.
 */
import { Topics } from '@auth/contracts';
import {
  EVENT_ROUTES,
  SUBSCRIBED_TOPICS,
  recipientFrom,
  resolveRoute,
  routeFor,
  userIdFrom,
} from '../src/domain/event-routing';
import {
  NOTIFICATION_TEMPLATES,
  NotificationTemplate,
} from '../src/domain/value-objects/notification-template.vo';
import { NotificationChannel } from '../src/domain/value-objects/notification-channel.vo';
import { compileTemplate } from '../src/domain/templates/notification-templates';
import { EMAIL, PHONE, USER_ID, eventMessage } from './testing/fakes';
import { required } from './testing/helpers';

/** topic -> template -> the payload a producer actually sends. */
const EXPECTED: readonly {
  topic: string;
  template: NotificationTemplate;
  payload: Record<string, unknown>;
}[] = [
  {
    topic: Topics.USER_REGISTERED,
    template: NotificationTemplate.WELCOME,
    payload: { userId: USER_ID, email: EMAIL, displayName: 'Ada', source: 'web' },
  },
  {
    topic: Topics.USER_EMAIL_VERIFIED,
    template: NotificationTemplate.VERIFY_EMAIL,
    payload: { userId: USER_ID, email: EMAIL },
  },
  {
    topic: Topics.USER_PASSWORD_CHANGED,
    template: NotificationTemplate.PASSWORD_CHANGED,
    payload: { userId: USER_ID },
  },
  {
    topic: Topics.USER_LOCKED,
    template: NotificationTemplate.ACCOUNT_LOCKED,
    payload: { userId: USER_ID, previousStatus: 'active', status: 'locked' },
  },
  {
    topic: Topics.USER_UNLOCKED,
    template: NotificationTemplate.ACCOUNT_UNLOCKED,
    payload: { userId: USER_ID, previousStatus: 'locked', status: 'active' },
  },
  {
    topic: Topics.USER_DELETED,
    template: NotificationTemplate.ACCOUNT_DELETED,
    payload: { userId: USER_ID, email: EMAIL },
  },
  {
    topic: Topics.SESSION_REVOKED,
    template: NotificationTemplate.SESSION_REVOKED,
    payload: { userId: USER_ID, sessionId: 's-1', reason: 'user_initiated', allSessions: true },
  },
  {
    topic: Topics.SESSION_REUSE_DETECTED,
    template: NotificationTemplate.SUSPICIOUS_REUSE,
    payload: { userId: USER_ID, sessionId: 's-1', revokedCount: 3 },
  },
  {
    topic: Topics.SECURITY_NEW_DEVICE_DETECTED,
    template: NotificationTemplate.NEW_DEVICE,
    payload: {
      userId: USER_ID,
      type: 'new_device_detected',
      riskScore: 40,
      riskLevel: 'medium',
      ipAddress: '203.0.113.7',
      deviceFingerprint: 'fp',
      factors: ['mfa'],
    },
  },
  {
    topic: Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED,
    template: NotificationTemplate.SUSPICIOUS_LOGIN,
    payload: {
      userId: USER_ID,
      type: 'suspicious_login_detected',
      riskScore: 88,
      riskLevel: 'critical',
      ipAddress: '198.51.100.22',
      factors: [],
    },
  },
  {
    topic: Topics.SECURITY_ANOMALY_DETECTED,
    template: NotificationTemplate.SECURITY_ANOMALY,
    payload: {
      userId: USER_ID,
      type: 'anomaly_detected',
      riskScore: 61,
      riskLevel: 'high',
      factors: ['password'],
    },
  },
  {
    topic: Topics.ROLE_GRANTED,
    template: NotificationTemplate.ROLE_GRANTED,
    payload: { userId: USER_ID, role: 'support', grantedBy: 'an-admin' },
  },
  {
    topic: Topics.ROLE_REVOKED,
    template: NotificationTemplate.ROLE_REVOKED,
    payload: { userId: USER_ID, role: 'support', reason: 'offboarded' },
  },
  {
    topic: Topics.AUTH_FLOW_FAILED,
    template: NotificationTemplate.AUTH_FLOW_FAILED,
    payload: { flowId: 'f-1', userId: USER_ID, flow: 'mfa', state: 'failed', reason: 'timeout' },
  },
  {
    topic: Topics.MFA_ENROLLED,
    template: NotificationTemplate.MFA_ENROLLED,
    payload: { userId: USER_ID, method: 'totp' },
  },
  {
    topic: Topics.MFA_FAILED,
    template: NotificationTemplate.MFA_FAILED,
    payload: { userId: USER_ID, method: 'totp' },
  },
  {
    topic: Topics.CREDENTIAL_ROTATED,
    template: NotificationTemplate.CREDENTIAL_ROTATED,
    payload: { userId: USER_ID, method: 'password' },
  },
];

describe('event to template routing', () => {
  it.each(EXPECTED)(
    '$topic produces the "$template" notification',
    ({ topic, template, payload }) => {
      const route = routeFor(topic);
      expect(route).not.toBeNull();

      const resolution = resolveRoute(required(route, 'route'), payload);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;

      expect(resolution.instruction.template).toBe(template);

      // The template's own schema has to accept the variables the route built, or the mapping
      // is a mapping to something that cannot be rendered.
      const compiled = compileTemplate(
        resolution.instruction.template,
        resolution.instruction.variables,
      );
      expect(compiled.definition.name).toBe(template);
      expect(compiled.body.length).toBeGreaterThan(0);
    },
  );

  it('covers every topic the consumer subscribes to, and nothing else', () => {
    const expected = new Set(EXPECTED.map((entry) => entry.topic));

    expect(new Set(SUBSCRIBED_TOPICS)).toEqual(expected);
    expect(SUBSCRIBED_TOPICS).toHaveLength(EXPECTED.length);
    expect(EVENT_ROUTES).toHaveLength(EXPECTED.length);
  });

  it('never routes a topic twice', () => {
    const topics = EVENT_ROUTES.map((route) => route.topic);
    expect(new Set(topics).size).toBe(topics.length);
  });

  it('routes only to templates that exist', () => {
    for (const route of EVENT_ROUTES) {
      expect(NOTIFICATION_TEMPLATES).toContain(route.template);
    }
  });

  it('returns null for a topic this service does not act on', () => {
    expect(routeFor(Topics.SESSION_ISSUED)).toBeNull();
    expect(routeFor('platform.user.registered.v9')).toBeNull();
    expect(routeFor('platform.nonsense.v1')).toBeNull();
  });

  it('reports a payload that names no user instead of guessing', () => {
    const route = required(routeFor(Topics.USER_REGISTERED), 'route');

    const resolution = resolveRoute(route, { email: EMAIL, source: 'web' });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toBe('no-recipient-identity');
  });

  it('does not mistake a session id for a user id', () => {
    expect(userIdFrom({ sessionId: 's-1' })).toBeNull();
    expect(userIdFrom({ userId: ` ${USER_ID} ` })).toBe(USER_ID);
  });
});

describe('recipient resolution', () => {
  it('reads every address the payload carries', () => {
    const recipient = recipientFrom({
      userId: USER_ID,
      email: EMAIL,
      phone: PHONE,
      deviceToken: 'device-1',
    });

    expect(recipient).toEqual({
      email: EMAIL,
      phone: PHONE,
      deviceToken: 'device-1',
    });
  });

  it('looks one level down, because producers nest addresses as often as not', () => {
    const recipient = recipientFrom({
      userId: USER_ID,
      recipient: { email: EMAIL },
      contact: { phoneNumber: PHONE },
    });

    expect(recipient.email).toBe(EMAIL);
    expect(recipient.phone).toBe(PHONE);
  });

  it('reports an absent address as null rather than an empty string', () => {
    const recipient = recipientFrom({ userId: USER_ID, email: '   ', phone: '' });

    expect(recipient.email).toBeNull();
    expect(recipient.phone).toBeNull();
    expect(recipient.deviceToken).toBeNull();
  });

  it('never turns an address into a template variable', () => {
    // The reason `UserRegisteredPayload` can carry an email at all: the address becomes a
    // delivery target, never template content, and therefore never reaches a published event.
    const route = required(routeFor(Topics.USER_REGISTERED), 'route');
    const resolution = resolveRoute(route, {
      userId: USER_ID,
      email: EMAIL,
      displayName: 'Ada',
      source: 'web',
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.instruction.recipient.email).toBe(EMAIL);
    expect(Object.values(resolution.instruction.variables)).not.toContain(EMAIL);
    expect(resolution.instruction.variables).toEqual({
      displayName: 'Ada',
      source: 'web',
    });
  });
});

describe('channel overrides', () => {
  it('narrows account deletion to the one channel that still has an address', () => {
    const route = required(routeFor(Topics.USER_DELETED), 'route');
    const resolution = resolveRoute(route, { userId: USER_ID, email: EMAIL });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.instruction.channels).toEqual([NotificationChannel.EMAIL]);
  });

  it('widens a replayed refresh token to every channel', () => {
    const route = required(routeFor(Topics.SESSION_REUSE_DETECTED), 'route');
    const resolution = resolveRoute(route, { userId: USER_ID, revokedCount: 2 });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.instruction.channels).toEqual([
      NotificationChannel.INAPP,
      NotificationChannel.PUSH,
      NotificationChannel.SMS,
      NotificationChannel.EMAIL,
    ]);
  });

  it('leaves the choice to the template when a route declares nothing', () => {
    const route = required(routeFor(Topics.USER_EMAIL_VERIFIED), 'route');
    const resolution = resolveRoute(route, { userId: USER_ID, email: EMAIL });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.instruction.channels).toBeUndefined();
  });
});

describe('the events the catalogue carries that this service ignores', () => {
  it('does not subscribe to a topic it has no route for', () => {
    // `session.issued` is a fact about a session, not something a user needs told about.
    // Subscribing to it to then acknowledge it would keep this consumer in the rebalance set
    // of a topic it will never act on.
    expect(SUBSCRIBED_TOPICS).not.toContain(Topics.SESSION_ISSUED);
    expect(SUBSCRIBED_TOPICS).not.toContain(Topics.SESSION_REFRESHED);
    expect(SUBSCRIBED_TOPICS).not.toContain(Topics.API_KEY_CREATED);
    expect(SUBSCRIBED_TOPICS).not.toContain(Topics.PERMISSION_DENIED);
  });

  it('carries every subscribed topic in a real envelope when it arrives', () => {
    // A shape check rather than a behavioural one: it is the assertion that fails first when
    // a producer changes the envelope, and it names the topic that moved.
    for (const topic of SUBSCRIBED_TOPICS) {
      const message = eventMessage(topic, { userId: USER_ID });
      expect(message.topic).toBe(topic);
      expect(typeof (message.payload as { eventId: string }).eventId).toBe('string');
    }
  });
});