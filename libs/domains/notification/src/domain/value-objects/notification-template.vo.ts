/**
 * @fileoverview The template names this service can render.
 *
 * @remarks Declared separately from the definitions so the union exists before the catalogue
 * that implements it. Every template is a *closed* member of this union rather than a
 * free-form string: a template name reaches a provider adapter, and a typo that reached one
 * would be a notification nobody receives and nobody notices.
 *
 * @remarks Adding a template is a two-step change — add the name here, add the definition to
 * `templates/notification-templates.ts`. The catalogue is typed as a total `Record` over this
 * union, so forgetting the second step is a compile error rather than a runtime lookup miss.
 */

export const NotificationTemplate = {
  WELCOME: 'welcome',
  VERIFY_EMAIL: 'verify-email',
  PASSWORD_CHANGED: 'password-changed',
  ACCOUNT_LOCKED: 'account-locked',
  ACCOUNT_UNLOCKED: 'account-unlocked',
  ACCOUNT_DELETED: 'account-deleted',
  SESSION_REVOKED: 'session-revoked',
  /** A refresh token was replayed: the strongest signal this platform has. */
  SUSPICIOUS_REUSE: 'suspicious-reuse',
  NEW_DEVICE: 'new-device',
  SUSPICIOUS_LOGIN: 'suspicious-login',
  SECURITY_ANOMALY: 'security-anomaly',
  ROLE_GRANTED: 'role-granted',
  ROLE_REVOKED: 'role-revoked',
  AUTH_FLOW_FAILED: 'auth-flow-failed',
  MFA_ENROLLED: 'mfa-enrolled',
  MFA_FAILED: 'mfa-failed',
  CREDENTIAL_ROTATED: 'credential-rotated',
} as const;

export type NotificationTemplate = (typeof NotificationTemplate)[keyof typeof NotificationTemplate];

export const NOTIFICATION_TEMPLATES: readonly NotificationTemplate[] = [
  NotificationTemplate.WELCOME,
  NotificationTemplate.VERIFY_EMAIL,
  NotificationTemplate.PASSWORD_CHANGED,
  NotificationTemplate.ACCOUNT_LOCKED,
  NotificationTemplate.ACCOUNT_UNLOCKED,
  NotificationTemplate.ACCOUNT_DELETED,
  NotificationTemplate.SESSION_REVOKED,
  NotificationTemplate.SUSPICIOUS_REUSE,
  NotificationTemplate.NEW_DEVICE,
  NotificationTemplate.SUSPICIOUS_LOGIN,
  NotificationTemplate.SECURITY_ANOMALY,
  NotificationTemplate.ROLE_GRANTED,
  NotificationTemplate.ROLE_REVOKED,
  NotificationTemplate.AUTH_FLOW_FAILED,
  NotificationTemplate.MFA_ENROLLED,
  NotificationTemplate.MFA_FAILED,
  NotificationTemplate.CREDENTIAL_ROTATED,
];

export function isNotificationTemplate(value: unknown): value is NotificationTemplate {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_TEMPLATES as readonly string[]).includes(value)
  );
}

/**
 * A `name -> template` pair as it crosses the wire.
 *
 * @remarks `as const satisfies` rather than an interface annotation, so the literal stays a
 * literal in the caller's type and a missing field is a compile error instead of an `undefined`
 * at the provider.
 */
export type TemplateVariableInput = Readonly<Record<string, unknown>>;

/** The validated, defaulted variable map a template renders from. */
export type NotificationVariables = Readonly<Record<string, string>>;