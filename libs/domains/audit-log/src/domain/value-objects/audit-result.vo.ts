/**
 * @fileoverview The audit record's vocabulary: who, what, and how it went.
 *
 * @remarks `as const` objects rather than TypeScript `enum`s. An enum emits a runtime object
 * that a `JSON` column can accidentally serialise, its reverse mapping turns `result: 0` into a
 * legitimate-looking row, and the generated client for a Prisma enum would make adding a
 * result kind a schema migration on the one table nobody may rewrite.
 */

/** Who acted. A failed sign-in has no actor, and saying so is the point. */
export const ActorType = {
  USER: 'user',
  /** No authenticated subject: an anonymous sign-in attempt, a public endpoint. */
  ANONYMOUS: 'anonymous',
  /** This platform acting on its own — a rotation, a scheduled sweep. */
  SYSTEM: 'system',
} as const;

export type ActorType = (typeof ActorType)[keyof typeof ActorType];

/** How the action ended. The column an operator filters on when answering "was it blocked?". */
export const AuditResult = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  /** Rejected by a policy rather than by a failed check: permission denied. */
  DENIED: 'denied',
  /** Something anomalous was observed and acted upon or flagged. */
  DETECTED: 'detected',
} as const;

export type AuditResult = (typeof AuditResult)[keyof typeof AuditResult];

/**
 * What kind of thing was acted upon.
 *
 * @remarks `other` is a legitimate value rather than a failure: a payload this service has no
 * mapping for still names its aggregate, and coercing it to a known type would put a
 * `permission` in a row that claims the action touched a `session`.
 */
export const ResourceType = {
  USER: 'user',
  SESSION: 'session',
  ROLE: 'role',
  PERMISSION: 'permission',
  CREDENTIAL: 'credential',
  AUTH_FLOW: 'auth_flow',
  OTHER: 'other',
} as const;

export type ResourceType = (typeof ResourceType)[keyof typeof ResourceType];

export const isAuditResult = (value: string): value is AuditResult =>
  (Object.values(AuditResult) as string[]).includes(value);

/** Placeholder for a record whose actor could not be established from the payload. */
export const UNKNOWN_ACTOR_ID = 'anonymous';

/** Placeholder for a resource the payload does not name. */
export const UNKNOWN_RESOURCE_ID = 'unknown';