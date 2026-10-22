/**
 * @fileoverview The template catalogue: one Zod schema per template.
 *
 * @remarks A template is declared, not rendered by string interpolation of whatever arrived.
 * Its variable set is a schema, so a producer that renames `riskLevel` to `risk_level` fails
 * here — loudly, at the point of the mismatch — instead of producing a security email that
 * says "your login from undefined looked unusual". A template with no schema is a template
 * whose body can be anything.
 *
 * @remarks Zod's default object behaviour *strips* unknown keys, and that is load-bearing here
 * rather than incidental. `UserRegisteredPayload` carries an `email`, and a producer that adds
 * a `resetToken` to a payload must not be able to get that string into a template variable
 * and from there into a published event. Unknown keys are dropped at the schema, so the value
 * cannot exist downstream to be leaked.
 *
 * @remarks Every schema is `z.ZodType<unknown, unknown>` at the port type rather than a
 * `ZodObject`: each template narrows its own shape, and the definition only promises "some
 * schema". Narrowing happens in {@link compileTemplate}, which is the single place a parsed
 * value becomes a `NotificationVariables`.
 */
import { DomainError } from '@auth/ddd-core';
import { z } from 'zod';
import {
  NOTIFICATION_CHANNELS,
  NotificationChannel,
  NotificationSeverity,
} from '../value-objects/notification-channel.vo';
import {
  NotificationTemplate,
  type NotificationVariables,
} from '../value-objects/notification-template.vo';
import { toVariableMap } from '../notification-announcement';

/** A template's variable schema. Deliberately opaque about its output shape. */
export type NotificationVariableSchema = z.ZodType<unknown, unknown>;

export interface NotificationTemplateDefinition {
  readonly name: NotificationTemplate;
  /** Human-readable one-liner; also the push/inapp title and the log line. */
  readonly subject: string;
  readonly severity: NotificationSeverity;
  /** Channels this template is meant to go out on, in the order they should be attempted. */
  readonly channels: readonly NotificationChannel[];
  /**
   * Whether a missing address is a reason to skip the channel or to refuse the whole send.
   *
   * @remarks `inapp` never has an address, so it is always safe. A template that is only
   * meaningful on a channel that costs money or can be spoofed — a phone number we did not
   * verify — says so here rather than sending to whatever `+1…` string the payload carried.
   */
  readonly requiresAddress: boolean;
  readonly schema: NotificationVariableSchema;
  /** Renders the body from *validated* variables. Never sees raw payload. */
  readonly body: (variables: NotificationVariables) => string;
}

/** Where a push/inapp title stops and a body starts. Short on purpose. */
const TITLE_MAX = 120;

/**
 * Per-template variable schemas.
 *
 * @remarks `requiredString` is a helper rather than repeated `z.string().min(1)` because a
 * field with no length floor is a field that accepts `""`, and an empty interpolation reads
 * as a rendering bug rather than a data problem.
 */
const requiredString = (min = 1) => z.string().trim().min(min);
const optionalString = () => z.string().trim().min(1).optional();

const VARIABLES: Readonly<
  Record<NotificationTemplate, NotificationVariableSchema>
> = {
  [NotificationTemplate.WELCOME]: z.object({
    displayName: z.string().trim().min(1).default('there'),
    source: requiredString().default('web'),
  }),
  [NotificationTemplate.VERIFY_EMAIL]: z.object({}),
  [NotificationTemplate.PASSWORD_CHANGED]: z.object({
    // Never the password, never a hash, never a reset link — only when it happened.
    changedAt: requiredString(),
  }),
  [NotificationTemplate.ACCOUNT_LOCKED]: z.object({
    reason: optionalString(),
    lockedUntil: optionalString(),
  }),
  [NotificationTemplate.ACCOUNT_UNLOCKED]: z.object({}),
  [NotificationTemplate.ACCOUNT_DELETED]: z.object({}),
  [NotificationTemplate.SESSION_REVOKED]: z.object({
    reason: requiredString(),
    allSessions: z.string().default('false'),
  }),
  [NotificationTemplate.SUSPICIOUS_REUSE]: z.object({
    revokedCount: z.coerce.number().int().nonnegative().transform(String),
    detectedAt: requiredString(),
  }),
  [NotificationTemplate.NEW_DEVICE]: z.object({
    deviceLabel: requiredString(),
    ipAddress: requiredString(3),
  }),
  [NotificationTemplate.SUSPICIOUS_LOGIN]: z.object({
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
    riskScore: z.coerce.number().min(0).max(100).transform(String),
    ipAddress: requiredString(3),
  }),
  [NotificationTemplate.SECURITY_ANOMALY]: z.object({
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
    summary: optionalString(),
  }),
  [NotificationTemplate.ROLE_GRANTED]: z.object({
    role: requiredString(),
    grantedBy: optionalString(),
  }),
  [NotificationTemplate.ROLE_REVOKED]: z.object({
    role: requiredString(),
    reason: optionalString(),
  }),
  [NotificationTemplate.AUTH_FLOW_FAILED]: z.object({
    flow: requiredString(),
    reason: requiredString(),
  }),
  [NotificationTemplate.MFA_ENROLLED]: z.object({
    method: requiredString(),
  }),
  [NotificationTemplate.MFA_FAILED]: z.object({
    method: requiredString(),
    attempt: z.coerce.number().int().positive().transform(String).optional(),
  }),
  [NotificationTemplate.CREDENTIAL_ROTATED]: z.object({
    method: requiredString(),
  }),
};

/**
 * The catalogue.
 *
 * @remarks Typed as a total `Record` over the template union, so a name added to
 * `NotificationTemplate` without a definition here is a compile error. A template that only
 * resolved at runtime would mean a welcome email that silently never renders.
 */
export const TEMPLATES: Readonly<
  Record<NotificationTemplate, NotificationTemplateDefinition>
> = {
  [NotificationTemplate.WELCOME]: {
    name: NotificationTemplate.WELCOME,
    subject: 'Welcome to the platform',
    severity: NotificationSeverity.INFO,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.WELCOME],
    body: (v) =>
      `Welcome, ${v['displayName'] ?? 'there'}. Your account is ready — you signed up via ${v['source'] ?? 'web'}.`,
  },
  [NotificationTemplate.VERIFY_EMAIL]: {
    name: NotificationTemplate.VERIFY_EMAIL,
    subject: 'Your email address is verified',
    severity: NotificationSeverity.INFO,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.VERIFY_EMAIL],
    body: () =>
      'Your email address is confirmed. You can now use every feature that requires a verified address.',
  },
  [NotificationTemplate.PASSWORD_CHANGED]: {
    name: NotificationTemplate.PASSWORD_CHANGED,
    subject: 'Your password was changed',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.PASSWORD_CHANGED],
    body: (v) =>
      `The password on your account was changed at ${v['changedAt']}. If this was not you, revoke every session now.`,
  },
  [NotificationTemplate.ACCOUNT_LOCKED]: {
    name: NotificationTemplate.ACCOUNT_LOCKED,
    subject: 'Your account is temporarily locked',
    severity: NotificationSeverity.CRITICAL,
    channels: [NotificationChannel.INAPP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.ACCOUNT_LOCKED],
    body: (v) =>
      `Your account was locked after repeated failed sign-in attempts${v['reason'] ? ` (${v['reason']})` : ''}. It unlocks automatically${
        v['lockedUntil'] ? ` at ${v['lockedUntil']}` : ''
      }.`,
  },
  [NotificationTemplate.ACCOUNT_UNLOCKED]: {
    name: NotificationTemplate.ACCOUNT_UNLOCKED,
    subject: 'Your account is unlocked',
    severity: NotificationSeverity.INFO,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.ACCOUNT_UNLOCKED],
    body: () =>
      'Your account is unlocked and sign-in is available again. Review your recent sessions if you do not recognise anything.',
  },
  [NotificationTemplate.ACCOUNT_DELETED]: {
    name: NotificationTemplate.ACCOUNT_DELETED,
    subject: 'Your account was closed',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.EMAIL],
    requiresAddress: true,
    schema: VARIABLES[NotificationTemplate.ACCOUNT_DELETED],
    body: () =>
      'Your account and its sessions have been closed. Any credential held by this platform has been destroyed.',
  },
  [NotificationTemplate.SESSION_REVOKED]: {
    name: NotificationTemplate.SESSION_REVOKED,
    subject: 'A session of yours was signed out',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.SESSION_REVOKED],
    body: (v) =>
      `A session of yours was signed out (${v['reason'] ?? 'unknown reason'}).${
        v['allSessions'] === 'true' ? ' Every session was signed out.' : ''
      }`,
  },
  [NotificationTemplate.SUSPICIOUS_REUSE]: {
    name: NotificationTemplate.SUSPICIOUS_REUSE,
    subject: 'We blocked a replayed sign-in token',
    severity: NotificationSeverity.CRITICAL,
    channels: [NotificationChannel.INAPP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.SUSPICIOUS_REUSE],
    body: (v) =>
      `A refresh token that was already used was presented again at ${v['detectedAt']}. ${
        v['revokedCount'] ?? '0'
      } session(s) were revoked. Change your password if you do not recognise this.`,
  },
  [NotificationTemplate.NEW_DEVICE]: {
    name: NotificationTemplate.NEW_DEVICE,
    subject: 'A new device signed in to your account',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.NEW_DEVICE],
    body: (v) =>
      `${v['deviceLabel']} signed in to your account from ${v['ipAddress']}. If this was not you, revoke that session immediately.`,
  },
  [NotificationTemplate.SUSPICIOUS_LOGIN]: {
    name: NotificationTemplate.SUSPICIOUS_LOGIN,
    subject: 'A sign-in attempt looked unusual',
    severity: NotificationSeverity.CRITICAL,
    channels: [NotificationChannel.INAPP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.SUSPICIOUS_LOGIN],
    body: (v) =>
      `We blocked a sign-in from ${v['ipAddress']} (risk ${v['riskLevel']}, score ${
        v['riskScore'] ?? 'n/a'
      }). If this was you, no action is needed.`,
  },
  [NotificationTemplate.SECURITY_ANOMALY]: {
    name: NotificationTemplate.SECURITY_ANOMALY,
    subject: 'We flagged unusual activity on your account',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.SECURITY_ANOMALY],
    body: (v) =>
      `Our systems flagged activity on your account at risk level ${v['riskLevel']}.${
        v['summary'] ? ` ${v['summary']}` : ''
      }`,
  },
  [NotificationTemplate.ROLE_GRANTED]: {
    name: NotificationTemplate.ROLE_GRANTED,
    subject: 'You were granted a role',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.ROLE_GRANTED],
    body: (v) =>
      `The role "${v['role']}" was granted to your account${v['grantedBy'] ? ` by ${v['grantedBy']}` : ''}.`,
  },
  [NotificationTemplate.ROLE_REVOKED]: {
    name: NotificationTemplate.ROLE_REVOKED,
    subject: 'A role was removed from your account',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.ROLE_REVOKED],
    body: (v) =>
      `The role "${v['role']}" was removed from your account${
        v['reason'] ? ` (${v['reason']})` : ''
      }.`,
  },
  [NotificationTemplate.AUTH_FLOW_FAILED]: {
    name: NotificationTemplate.AUTH_FLOW_FAILED,
    subject: 'A sign-in attempt did not complete',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.AUTH_FLOW_FAILED],
    body: (v) =>
      `A "${v['flow']}" sign-in attempt did not complete: ${v['reason']}. We did not contact you about it — if this was not you, no action is needed.`,
  },
  [NotificationTemplate.MFA_ENROLLED]: {
    name: NotificationTemplate.MFA_ENROLLED,
    subject: 'A second factor was added to your account',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.MFA_ENROLLED],
    body: (v) =>
      `A ${v['method']} second factor was added to your account. Sign-in will ask for it from now on.`,
  },
  [NotificationTemplate.MFA_FAILED]: {
    name: NotificationTemplate.MFA_FAILED,
    subject: 'A second-factor check failed',
    severity: NotificationSeverity.CRITICAL,
    channels: [NotificationChannel.INAPP, NotificationChannel.PUSH, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.MFA_FAILED],
    body: (v) =>
      `A ${v['method']} second-factor check failed${
        v['attempt'] ? ` on attempt ${v['attempt']}` : ''
      }. If this was not you, change your password now.`,
  },
  [NotificationTemplate.CREDENTIAL_ROTATED]: {
    name: NotificationTemplate.CREDENTIAL_ROTATED,
    subject: 'A credential was rotated',
    severity: NotificationSeverity.SECURITY,
    channels: [NotificationChannel.INAPP, NotificationChannel.EMAIL],
    requiresAddress: false,
    schema: VARIABLES[NotificationTemplate.CREDENTIAL_ROTATED],
    body: (v) =>
      `The ${v['method']} credential on your account was rotated. Any copy you stored elsewhere no longer works.`,
  },
};

/** Looks a template up, or throws. Never returns `undefined` to a caller. */
export function resolveTemplate(name: string): NotificationTemplateDefinition {
  const definition = TEMPLATES[name as NotificationTemplate];

  if (!definition) {
    // A build-time oversight rather than bad input: the routes in `event-routing.ts` name
    // templates by constant, so an unmapped one means a route was added without its template.
    throw new DomainError('INVALID_VALUE', `unknown notification template "${name}"`, {
      template: name,
      known: Object.keys(TEMPLATES),
    });
  }

  return definition;
}

export interface CompiledTemplate {
  readonly definition: NotificationTemplateDefinition;
  readonly variables: NotificationVariables;
  readonly subject: string;
  readonly body: string;
}

/**
 * Validates a raw variable map against the template's schema and renders it.
 *
 * @remarks The only place a raw record becomes a `NotificationVariables`, which is what makes
 * "unknown keys are stripped" a property of the system rather than of every call site. A
 * caller that wants a variable the template does not declare has to add it to the schema,
 * where it can be reviewed.
 *
 * @throws {DomainError} `MISSING_REQUIRED` naming the offending fields, so a producer can see
 * which one it got wrong. Retrying will not help: a payload that failed its schema will fail
 * it identically on every delivery attempt, which is why the consumer dead-letters rather
 * than rethrows.
 */
export function compileTemplate(
  name: NotificationTemplate,
  raw: Readonly<Record<string, unknown>>,
): CompiledTemplate {
  const definition = resolveTemplate(name);
  const parsed = definition.schema.safeParse(raw);

  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${field}: ${issue.message}`;
    });

    throw new DomainError(
      'MISSING_REQUIRED',
      `template "${name}" rejected its variables: ${missing.join('; ')}`,
      { template: name, issues: missing },
    );
  }

  const variables = toVariableMap(parsed.data);

  return {
    definition,
    variables,
    subject: clamp(definition.subject, TITLE_MAX),
    body: definition.body(variables),
  };
}

/**
 * Reorders a template's channels so delivery is attempted in a fixed order.
 *
 * @remarks {@link NOTIFICATION_CHANNELS} is the order, not the template's own declaration, so
 * two templates that both want `email` and `push` attempt them in the same sequence. Ordering
 * that varied per template would make "which channel did we try first" unanswerable from a
 * production log.
 */
export function orderedChannels(
  channels: readonly NotificationChannel[],
): readonly NotificationChannel[] {
  const requested = new Set(channels);
  return NOTIFICATION_CHANNELS.filter((channel) => requested.has(channel));
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}