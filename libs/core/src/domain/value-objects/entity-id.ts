/**
 * @fileoverview Branded, UUID-backed identity primitives.
 *
 * Why this exists: passing a raw `string` as an id lets a `UserId` reach a column that
 * expects an `OrderId` and nothing complains until the database does. Branding makes the
 * distinction a compile-time error while staying a plain string at runtime, so ids cost
 * nothing to serialise.
 */

/**
 * A structural marker attached to a string so the compiler tracks which aggregate an id
 * belongs to. Erased entirely by the compiler.
 */
export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type UserId = Brand<string, 'UserId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type PermissionId = Brand<string, 'PermissionId'>;
export type CredentialId = Brand<string, 'CredentialId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type AuthFlowId = Brand<string, 'AuthFlowId'>;
export type NotificationId = Brand<string, 'NotificationId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type SecurityEventId = Brand<string, 'SecurityEventId'>;
export type ApiKeyId = Brand<string, 'ApiKeyId'>;
export type OutboxId = Brand<string, 'OutboxId'>;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const UUID_PATTERN = UUID_V4_PATTERN;

export class EntityId {
  private constructor(private readonly raw: string) {}

  /**
   * Builds a typed id. Pass an explicit `value` when rehydrating from storage; omit it to
   * mint a fresh v4 UUID.
   *
   * @remarks Ids are always supplied *into* aggregates rather than generated inside them:
   * replaying an event stream must reproduce the original id, so generation cannot happen
   * in the constructor.
   */
  static create<TBrand extends string>(value?: string): Brand<string, TBrand> {
    const candidate =
      value ?? globalThis.crypto.randomUUID().toLowerCase();

    if (!EntityId.isValid(candidate)) {
      throw new Error(`Invalid UUID v4: "${candidate}"`);
    }

    return candidate as Brand<string, TBrand>;
  }

  static isValid(value: unknown): value is string {
    return typeof value === 'string' && UUID_V4_PATTERN.test(value);
  }

  /** Normalises any branded id back to its string form for transport. */
  static unwrap(value: Brand<string, string> | string): string {
    return value as string;
  }
}