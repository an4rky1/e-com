/**
 * @fileoverview Integration event envelope and the topic catalogue.
 *
 * Why an envelope rather than the domain event itself: the wire format must survive a
 * change to the aggregate's internals. The domain says `UserEmailChanged`; the envelope
 * carries a flat payload plus a schema version, so a consumer can be validated and a
 * breaking payload change becomes a version bump instead of silent corruption.
 */

export const EVENT_SCHEMA_VERSION = 1;

/** Envelope every cross-service message is wrapped in. */
export interface IntegrationEvent<TPayload> {
  eventId: string;
  /** `platform.<aggregate>.<event>.v<N>` — dot separated, past tense, version last. */
  type: string;
  /** Bumped only on a breaking payload change; also encoded in the topic suffix. */
  schemaVersion: number;
  occurredAt: string;
  aggregateId: string;
  aggregateType: string;
  /**
   * Id of the entity whose ordering matters; drives the partition key. Two events about
   * the same aggregate must land on the same partition or concurrent changes reorder.
   */
  partitionKey: string;
  traceId?: string;
  correlationId?: string;
  payload: TPayload;
}

/**
 * The topic catalogue.
 *
 * Why one file: a topic name is a contract between a producer and every consumer.
 * Scattering literals across services is how `user.registered` and `user.v1.registered`
 * end up coexisting with half the consumers listening to the wrong one.
 *
 * Convention: `platform.<aggregate>.<event>.v<major>`. The `platform.` prefix keeps auth
 * traffic separable from other domains on a shared cluster.
 */
export const Topics = {
  // identity
  USER_REGISTERED: 'platform.user.registered.v1',
  USER_DELETED: 'platform.user.deleted.v1',
  USER_EMAIL_VERIFIED: 'platform.user.email_verified.v1',
  USER_PASSWORD_CHANGED: 'platform.user.password_changed.v1',
  USER_LOCKED: 'platform.user.locked.v1',
  USER_UNLOCKED: 'platform.user.unlocked.v1',

  // credential vault
  CREDENTIAL_VERIFIED: 'platform.credential.verified.v1',
  CREDENTIAL_FAILED: 'platform.credential.failed.v1',
  CREDENTIAL_ROTATED: 'platform.credential.rotated.v1',
  CREDENTIAL_RECOVERY_CODES_REGENERATED:
    'platform.credential.recovery_codes_regenerated.v1',

  // mfa
  MFA_ENROLLED: 'platform.mfa.enrolled.v1',
  MFA_VERIFIED: 'platform.mfa.verified.v1',
  MFA_FAILED: 'platform.mfa.failed.v1',
  MFA_DISABLED: 'platform.mfa.disabled.v1',

  // api key
  API_KEY_CREATED: 'platform.api_key.created.v1',
  API_KEY_ROTATED: 'platform.api_key.rotated.v1',
  API_KEY_REVOKED: 'platform.api_key.revoked.v1',

  // session engine
  SESSION_ISSUED: 'platform.session.issued.v1',
  SESSION_REFRESHED: 'platform.session.refreshed.v1',
  SESSION_REVOKED: 'platform.session.revoked.v1',
  SESSION_REUSE_DETECTED: 'platform.session.token_reuse_detected.v1',

  // access control
  ROLE_GRANTED: 'platform.role.granted.v1',
  ROLE_REVOKED: 'platform.role.revoked.v1',
  PERMISSION_DENIED: 'platform.permission.denied.v1',

  // auth-flow
  AUTH_FLOW_STARTED: 'platform.auth_flow.started.v1',
  AUTH_FLOW_STEP_COMPLETED: 'platform.auth_flow.step_completed.v1',
  AUTH_FLOW_COMPLETED: 'platform.auth_flow.completed.v1',
  AUTH_FLOW_FAILED: 'platform.auth_flow.failed.v1',

  // account security
  SECURITY_NEW_DEVICE_DETECTED: 'platform.security.new_device_detected.v1',
  SECURITY_SUSPICIOUS_LOGIN_DETECTED: 'platform.security.suspicious_login_detected.v1',
  SECURITY_ANOMALY_DETECTED: 'platform.security.anomaly_detected.v1',
} as const;

export type Topic = (typeof Topics)[keyof typeof Topics];

/** Dead-letter sibling: a message that exhausted its retries. */
export const dlqTopicFor = (topic: Topic): string => `${topic}.dlq`;

/** Retry sibling: a message being redelivered after a transient failure. */
export const retryTopicFor = (topic: Topic): string => `${topic}.retry`;

/** Topics grouped by the service that produces them — used to provision and to document. */
export const TopicsByProducer = {
  identity: [
    Topics.USER_REGISTERED,
    Topics.USER_DELETED,
    Topics.USER_EMAIL_VERIFIED,
    Topics.USER_PASSWORD_CHANGED,
    Topics.USER_LOCKED,
    Topics.USER_UNLOCKED,
  ],
  'credential-vault': [
    Topics.CREDENTIAL_VERIFIED,
    Topics.CREDENTIAL_FAILED,
    Topics.CREDENTIAL_ROTATED,
    Topics.CREDENTIAL_RECOVERY_CODES_REGENERATED,
  ],
  mfa: [
    Topics.MFA_ENROLLED,
    Topics.MFA_VERIFIED,
    Topics.MFA_FAILED,
    Topics.MFA_DISABLED,
  ],
  'api-key': [Topics.API_KEY_CREATED, Topics.API_KEY_ROTATED, Topics.API_KEY_REVOKED],
  'session': [
    Topics.SESSION_ISSUED,
    Topics.SESSION_REFRESHED,
    Topics.SESSION_REVOKED,
    Topics.SESSION_REUSE_DETECTED,
  ],
  'access-control': [Topics.ROLE_GRANTED, Topics.ROLE_REVOKED, Topics.PERMISSION_DENIED],
  'auth-flow': [
    Topics.AUTH_FLOW_STARTED,
    Topics.AUTH_FLOW_STEP_COMPLETED,
    Topics.AUTH_FLOW_COMPLETED,
    Topics.AUTH_FLOW_FAILED,
  ],
  'account-security': [
    Topics.SECURITY_NEW_DEVICE_DETECTED,
    Topics.SECURITY_SUSPICIOUS_LOGIN_DETECTED,
    Topics.SECURITY_ANOMALY_DETECTED,
  ],
} as const satisfies Record<string, readonly Topic[]>;

export const ALL_TOPICS: readonly Topic[] = Object.values(Topics);

// ---- Payload contracts -----------------------------------------------------------

export interface UserRegisteredPayload {
  userId: string;
  email: string;
  displayName?: string;
  source: string;
}

export interface UserEmailVerifiedPayload {
  userId: string;
  email: string;
}

export interface UserStatusChangedPayload {
  userId: string;
  previousStatus: string;
  status: string;
  reason?: string;
}

export interface CredentialVerifiedPayload {
  userId: string;
  method: string;
  /** Set when the stored hash was weaker than policy and was transparently upgraded. */
  rehashed?: boolean;
}

export interface CredentialFailedPayload {
  userId?: string;
  identifier: string;
  attempt: number;
  ipAddress?: string;
}

export interface MfaVerifiedPayload {
  userId: string;
  method: 'totp' | 'backup_code';
}

export interface SessionIssuedPayload {
  sessionId: string;
  userId: string;
  deviceId?: string;
  ipAddress?: string;
}

export interface SessionRevokedPayload {
  sessionId: string;
  userId: string;
  reason: string;
  allSessions: boolean;
}

export interface SessionReuseDetectedPayload {
  sessionId: string;
  userId: string;
  ipAddress?: string;
  /** Sessions revoked as a result of the replay. */
  revokedCount: number;
}

export interface RoleChangedPayload {
  userId: string;
  role: string;
  grantedBy?: string;
  reason?: string;
}

export interface PermissionDeniedPayload {
  userId?: string;
  permission: string;
  resource?: string;
  reason: string;
  ipAddress?: string;
}

export interface AuthFlowChangedPayload {
  flowId: string;
  userId?: string;
  flow: string;
  state: string;
  /** Present on `failed` only. */
  reason?: string;
}

export interface SecurityEventPayload {
  userId?: string;
  type:
    | 'new_device_detected'
    | 'suspicious_login_detected'
    | 'anomaly_detected';
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  ipAddress?: string;
  deviceFingerprint?: string;
  factors: string[];
}