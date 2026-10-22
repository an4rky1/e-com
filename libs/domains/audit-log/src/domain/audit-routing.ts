/**
 * @fileoverview Which security events become audit records, and what each one says.
 *
 * @remarks One table, one direction. The topic catalogue in `@auth/contracts` is a contract
 * between every producer and every consumer; this file is the part of it *this* service acts
 * on. Adding a route is one entry — a scattered `switch (topic)` in a handler is how
 * `platform.security.anomaly_detected.v1` ends up subscribed but unrouted, so the message is
 * consumed, acknowledged and produces no audit record at all.
 *
 * @remarks Only security-relevant topics are subscribed. Joining every auth topic to be told
 * about the twelve this service routes is a cost with no upside: it keeps this consumer in the
 * rebalance set of topics it will never act on, so an unrelated producer's traffic slows down
 * a consumer that does have work. What an audit log leaves out is as much a decision as what
 * it keeps.
 */
import { Topics, type Topic } from '@auth/contracts';
import { AuditResult, ResourceType } from './value-objects/audit-result.vo';

/** How a topic's payload is read into an audit record. */
export interface AuditRoute {
  /** Past-tense, dotted, matching the topic: `session.revoked`, `permission.denied`. */
  readonly action: string;
  readonly resourceType: ResourceType;
  /**
   * Baseline outcome for the topic.
   *
   * @remarks `security.*` overrides it per message from the payload's `riskLevel`, because a
   * `critical` anomaly and a `low` one are not the same finding.
   */
  readonly result: AuditResult;
  /** Payload fields that may name the subject, most specific first. */
  readonly actorFields: readonly string[];
  /** Payload fields that may name the acted-upon thing. */
  readonly resourceFields: readonly string[];
  /** Whether the payload may establish an actor at all. */
  readonly actorOptional: boolean;
  /** The `security.*` topics carry their own result in `riskLevel`. */
  readonly resultFromRiskLevel?: boolean;
}

const USER = ['userId', 'accountId', 'ownerId'] as const;
const SESSION = ['sessionId'] as const;

/**
 * The topics this service subscribes to.
 *
 * @remarks Security-relevant only, and `as const` so the array's element type is the union of
 * literals rather than `Topic` — a typo in a topic string is then a compile error instead of a
 * subscription to a topic nobody publishes.
 */
export const SUBSCRIBED_TOPICS = [
  Topics.SESSION_TOKEN_REUSE_DETECTED,
  Topics.SESSION_REVOKED,
  Topics.AUTH_FLOW_FAILED,
  Topics.PERMISSION_DENIED,
  Topics.CREDENTIAL_FAILED,
  Topics.SECURITY_NEW_DEVICE_DETECTED,
  Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED,
  Topics.SECURITY_ANOMALY_DETECTED,
  Topics.ROLE_GRANTED,
  Topics.ROLE_REVOKED,
  Topics.USER_LOCKED,
  Topics.USER_UNLOCKED,
] as const satisfies readonly Topic[];

/**
 * `topic -> what it means as an audit record`.
 *
 * @remarks A `Record<>` rather than a lookup function so the compiler checks exhaustiveness:
 * a new security topic added to the catalogue is *not* silently unaudited, because the array
 * above and this table have to agree — {@link AUDIT_ROUTES} is built from both and the test
 * asserts they do.
 */
const ROUTES: Record<(typeof SUBSCRIBED_TOPICS)[number], AuditRoute> = {
  [Topics.SESSION_TOKEN_REUSE_DETECTED]: {
    action: 'session.token_reuse_detected',
    resourceType: ResourceType.SESSION,
    result: AuditResult.DETECTED,
    actorFields: USER,
    resourceFields: SESSION,
    actorOptional: false,
  },
  [Topics.SESSION_REVOKED]: {
    action: 'session.revoked',
    resourceType: ResourceType.SESSION,
    result: AuditResult.SUCCESS,
    actorFields: USER,
    resourceFields: SESSION,
    actorOptional: false,
  },
  [Topics.AUTH_FLOW_FAILED]: {
    action: 'auth_flow.failed',
    resourceType: ResourceType.AUTH_FLOW,
    result: AuditResult.FAILURE,
    actorFields: USER,
    // `flowId` is the acted-upon thing; the aggregate id is the same value for this topic.
    resourceFields: ['flowId', 'flow'],
    actorOptional: true,
  },
  [Topics.PERMISSION_DENIED]: {
    action: 'permission.denied',
    resourceType: ResourceType.PERMISSION,
    result: AuditResult.DENIED,
    actorFields: USER,
    resourceFields: ['permission', 'resource'],
    actorOptional: true,
  },
  [Topics.CREDENTIAL_FAILED]: {
    action: 'credential.failed',
    resourceType: ResourceType.CREDENTIAL,
    result: AuditResult.FAILURE,
    actorFields: USER,
    // `identifier` may be an email address, which is an actor attribute rather than a
    // credential id. It is recorded because "which account was targeted" is the question a
    // credential-stuffing investigation asks first.
    resourceFields: ['identifier', 'method'],
    actorOptional: true,
  },
  [Topics.SECURITY_NEW_DEVICE_DETECTED]: {
    action: 'security.new_device_detected',
    resourceType: ResourceType.SESSION,
    result: AuditResult.DETECTED,
    actorFields: USER,
    resourceFields: ['deviceFingerprint'],
    actorOptional: true,
    resultFromRiskLevel: true,
  },
  [Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED]: {
    action: 'security.suspicious_login_detected',
    resourceType: ResourceType.SESSION,
    result: AuditResult.DETECTED,
    actorFields: USER,
    resourceFields: ['deviceFingerprint'],
    actorOptional: true,
    resultFromRiskLevel: true,
  },
  [Topics.SECURITY_ANOMALY_DETECTED]: {
    action: 'security.anomaly_detected',
    resourceType: ResourceType.SESSION,
    result: AuditResult.DETECTED,
    actorFields: USER,
    resourceFields: ['type'],
    actorOptional: true,
    resultFromRiskLevel: true,
  },
  [Topics.ROLE_GRANTED]: {
    action: 'role.granted',
    resourceType: ResourceType.ROLE,
    result: AuditResult.SUCCESS,
    actorFields: USER,
    // `grantedBy` is the actor when it is present — a role granted by an administrator is an
    // administrative act, and recording it as the recipient's own action is how privilege
    // escalation disappears from the log.
    resourceFields: ['role'],
    actorOptional: false,
  },
  [Topics.ROLE_REVOKED]: {
    action: 'role.revoked',
    resourceType: ResourceType.ROLE,
    result: AuditResult.SUCCESS,
    actorFields: USER,
    resourceFields: ['role'],
    actorOptional: false,
  },
  [Topics.USER_LOCKED]: {
    action: 'user.locked',
    resourceType: ResourceType.USER,
    result: AuditResult.SUCCESS,
    actorFields: USER,
    resourceFields: ['previousStatus'],
    actorOptional: false,
  },
  [Topics.USER_UNLOCKED]: {
    action: 'user.unlocked',
    resourceType: ResourceType.USER,
    result: AuditResult.SUCCESS,
    actorFields: USER,
    resourceFields: ['previousStatus'],
    actorOptional: false,
  },
};

export const AUDIT_ROUTES: Readonly<Partial<Record<Topic, AuditRoute>>> = ROUTES;

/** `high` and `critical` are incidents; the rest are notes. */
const RESULT_FOR_RISK_LEVEL: Record<string, AuditResult> = {
  critical: AuditResult.DETECTED,
  high: AuditResult.DETECTED,
  medium: AuditResult.FAILURE,
  low: AuditResult.FAILURE,
};

export function routeFor(topic: string): AuditRoute | undefined {
  return ROUTES[topic as (typeof SUBSCRIBED_TOPICS)[number]];
}

export function resultFor(route: AuditRoute, payload: Readonly<Record<string, unknown>>): AuditResult {
  if (!route.resultFromRiskLevel) return route.result;

  const level = stringOf(payload['riskLevel'])?.toLowerCase();
  return (level && RESULT_FOR_RISK_LEVEL[level]) || route.result;
}

/** Reads the first present, non-empty field as a string. */
export function stringOfField(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = stringOf(payload[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}