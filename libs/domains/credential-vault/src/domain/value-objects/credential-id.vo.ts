/**
 * @fileoverview The identity of one credential.
 *
 * @remarks `credentials.id` and `recovery_codes.user_id` are both `uuid` columns, and the
 * `outbox_events.aggregate_id` column takes either. Branding the credential id means a user
 * id cannot be passed where a credential id is expected — the mix-up that matters most here is
 * revoking "credential `<user id>`" and silently revoking nothing.
 */
import { EntityId } from '@auth/ddd-core';

export class CredentialId {
  private constructor(readonly value: string) {}

  /**
   * Mints a v4 id, or validates a supplied one.
   *
   * @remarks Ids are always supplied *into* the aggregate rather than generated inside it:
   * replaying a write must reproduce the original id.
   */
  static create(value?: string): CredentialId {
    return new CredentialId(EntityId.create<'CredentialId'>(value));
  }

  /** Rehydration path: the row is trusted, so an unusual-but-stored id is never rejected. */
  static fromStored(value: string): CredentialId {
    return new CredentialId(EntityId.unwrap(value));
  }

  static isValid(value: unknown): value is string {
    return EntityId.isValid(value);
  }

  equals(other: CredentialId | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    return other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}