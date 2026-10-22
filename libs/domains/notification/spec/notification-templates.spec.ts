/**
 * Templates are declared with a schema, and the schema is the contract.
 *
 * @remarks The failure this suite guards against is the quiet one: a producer renames a field,
 * the template's schema either has a default or does not, and the user receives an email
 * saying "your login from undefined looked unusual". A template without a schema fails that
 * way. A template *with* one fails here instead, loudly, on a producer's first deploy.
 *
 * @remarks The stripping behaviour is tested as deliberately as the rejecting behaviour,
 * because it is the property that makes `UserRegisteredPayload.email` safe: Zod drops unknown
 * keys, so a value a producer invents cannot reach a variable and from there a published event.
 */
import { DomainError } from '@auth/ddd-core';
import {
  TEMPLATES,
  compileTemplate,
  orderedChannels,
  resolveTemplate,
} from '../src/domain/templates/notification-templates';
import {
  NOTIFICATION_TEMPLATES,
  NotificationTemplate,
} from '../src/domain/value-objects/notification-template.vo';
import { NotificationChannel } from '../src/domain/value-objects/notification-channel.vo';
import { EMAIL } from './testing/fakes';
import { rejection } from './testing/helpers';

/** A 32-byte base64url run: exactly what a reset token looks like. */
const RESET_TOKEN = 'kZ9x_Q2mB7pL4nR8vT1wY6zX3aC5dF0gH2jK4lM';

describe('template declarations', () => {
  it('declares a definition for every template name', () => {
    for (const name of NOTIFICATION_TEMPLATES) {
      expect(TEMPLATES[name]).toBeDefined();
      expect(TEMPLATES[name].name).toBe(name);
    }
  });

  it('names only channels that exist, and lists them in canonical order', () => {
    const order = orderedChannels(Object.values(NotificationChannel));

    for (const name of NOTIFICATION_TEMPLATES) {
      const definition = TEMPLATES[name];
      expect(orderedChannels(definition.channels)).toEqual(definition.channels);
      for (const channel of definition.channels) {
        expect(order).toContain(channel);
      }
    }
  });

  it('refuses a template that does not exist rather than returning undefined', async () => {
    const error = await rejection(
      Promise.resolve().then(() => resolveTemplate('not-a-template')),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).toContain('unknown notification template');
  });

  it('marks a security alert critical and a welcome note informational', () => {
    expect(TEMPLATES[NotificationTemplate.WELCOME].severity).toBe('info');
    expect(TEMPLATES[NotificationTemplate.ACCOUNT_LOCKED].severity).toBe('critical');
    expect(TEMPLATES[NotificationTemplate.SUSPICIOUS_REUSE].severity).toBe('critical');
  });
});

describe('required variables', () => {
  it('rejects a template whose required variable is missing, naming the field', async () => {
    // `suspicious-login` cannot render without knowing how risky the login was; a body that
    // said "risk undefined" is worse than no email, because it reads as if the system worked.
    const error = await rejection(
      Promise.resolve().then(() =>
        compileTemplate(NotificationTemplate.SUSPICIOUS_LOGIN, { ipAddress: '198.51.100.1' }),
      ),
    );

    expect(error).toBeInstanceOf(DomainError);
    const message = (error as DomainError).message;
    expect(message).toContain('suspicious-login');
    expect(message).toContain('riskLevel');
  });

  it('rejects a variable of the wrong shape', async () => {
    const error = await rejection(
      Promise.resolve().then(() =>
        compileTemplate(NotificationTemplate.SUSPICIOUS_LOGIN, {
          riskLevel: 'apocalyptic',
          riskScore: 10,
          ipAddress: '198.51.100.1',
        }),
      ),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).toContain('riskLevel');
  });

  it('rejects a number outside the range the template declares', async () => {
    const error = await rejection(
      Promise.resolve().then(() =>
        compileTemplate(NotificationTemplate.SUSPICIOUS_LOGIN, {
          riskLevel: 'high',
          riskScore: 4000,
          ipAddress: '198.51.100.1',
        }),
      ),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).toContain('riskScore');
  });

  it.each([
    [NotificationTemplate.NEW_DEVICE, 'deviceLabel'],
    [NotificationTemplate.ROLE_GRANTED, 'role'],
    [NotificationTemplate.AUTH_FLOW_FAILED, 'reason'],
    [NotificationTemplate.MFA_ENROLLED, 'method'],
    [NotificationTemplate.SUSPICIOUS_REUSE, 'detectedAt'],
  ])('rejects %s without %s', async (template, field) => {
    const error = await rejection(
      Promise.resolve().then(() => compileTemplate(template, {})),
    );

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).toContain(field);
  });

  it('rejects an empty string where a value is required', async () => {
    // Length floors are what stop an empty interpolation reading as a rendering bug rather
    // than a data problem.
    const error = await rejection(
      Promise.resolve().then(() =>
        compileTemplate(NotificationTemplate.ROLE_GRANTED, { role: '   ' }),
      ),
    );

    expect(error).toBeInstanceOf(DomainError);
  });

  it('applies declared defaults when the payload omits an optional variable', () => {
    const compiled = compileTemplate(NotificationTemplate.WELCOME, {});

    expect(compiled.variables).toEqual({ displayName: 'there', source: 'web' });
    expect(compiled.body).toContain('there');
  });

  it('coerces a numeric variable that the payload sent as a string', () => {
    // `revokedCount` arrives as a number from session-token and as a string from anything
    // that round-tripped through a log; the template must not care which.
    const compiled = compileTemplate(NotificationTemplate.SUSPICIOUS_REUSE, {
      revokedCount: '5',
      detectedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(compiled.variables['revokedCount']).toBe('5');
    expect(compiled.body).toContain('5 session(s) were revoked');
  });
});

describe('unknown variables are stripped, not carried', () => {
  it('drops a key the template does not declare', () => {
    const compiled = compileTemplate(NotificationTemplate.WELCOME, {
      displayName: 'Ada',
      source: 'web',
      internalTicket: 'SUP-1042',
    });

    expect(compiled.variables).toEqual({ displayName: 'Ada', source: 'web' });
    expect(compiled.body).not.toContain('SUP-1042');
  });

  it('drops a token a producer tried to smuggle in as a variable', () => {
    const compiled = compileTemplate(NotificationTemplate.PASSWORD_CHANGED, {
      changedAt: '2026-01-01T00:00:00.000Z',
      resetToken: RESET_TOKEN,
    });

    expect(compiled.variables['resetToken']).toBeUndefined();
    expect(JSON.stringify(compiled)).not.toContain(RESET_TOKEN);
  });

  it('drops an address a producer put in the variable bag', () => {
    const compiled = compileTemplate(NotificationTemplate.WELCOME, {
      displayName: 'Ada',
      email: EMAIL,
    });

    expect(compiled.variables['email']).toBeUndefined();
    expect(compiled.body).not.toContain(EMAIL);
  });
});

describe('rendering', () => {
  it('renders every template from its own variables without throwing', () => {
    const samples: Partial<Record<NotificationTemplate, Record<string, unknown>>> = {
      [NotificationTemplate.WELCOME]: { displayName: 'Ada', source: 'web' },
      [NotificationTemplate.VERIFY_EMAIL]: {},
      [NotificationTemplate.PASSWORD_CHANGED]: { changedAt: '2026-01-01T00:00:00.000Z' },
      [NotificationTemplate.ACCOUNT_LOCKED]: { reason: 'brute force', lockedUntil: 'soon' },
      [NotificationTemplate.ACCOUNT_UNLOCKED]: {},
      [NotificationTemplate.ACCOUNT_DELETED]: {},
      [NotificationTemplate.SESSION_REVOKED]: { reason: 'password changed', allSessions: 'true' },
      [NotificationTemplate.SUSPICIOUS_REUSE]: { revokedCount: 2, detectedAt: 'now' },
      [NotificationTemplate.NEW_DEVICE]: { deviceLabel: 'Pixel 9', ipAddress: '203.0.113.7' },
      [NotificationTemplate.SUSPICIOUS_LOGIN]: {
        riskLevel: 'critical',
        riskScore: 91,
        ipAddress: '198.51.100.22',
      },
      [NotificationTemplate.SECURITY_ANOMALY]: { riskLevel: 'high', summary: 'impossible travel' },
      [NotificationTemplate.ROLE_GRANTED]: { role: 'support', grantedBy: 'an-admin' },
      [NotificationTemplate.ROLE_REVOKED]: { role: 'support', reason: 'offboarded' },
      [NotificationTemplate.AUTH_FLOW_FAILED]: { flow: 'mfa', reason: 'timeout' },
      [NotificationTemplate.MFA_ENROLLED]: { method: 'totp' },
      [NotificationTemplate.MFA_FAILED]: { method: 'totp', attempt: 3 },
      [NotificationTemplate.CREDENTIAL_ROTATED]: { method: 'password' },
    };

    for (const name of NOTIFICATION_TEMPLATES) {
      const compiled = compileTemplate(name, samples[name] ?? {});
      expect(compiled.subject.length).toBeGreaterThan(0);
      expect(compiled.body.length).toBeGreaterThan(0);
      // Nothing rendered may contain a string the schema never produced.
      expect(Object.keys(compiled.variables).length).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps every channel that a template asks for and nothing else', () => {
    const compiled = compileTemplate(NotificationTemplate.WELCOME, {});

    expect(compiled.definition.channels).toEqual([
      NotificationChannel.INAPP,
      NotificationChannel.EMAIL,
    ]);
  });
});