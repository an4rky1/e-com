/**
 * @fileoverview The identity of a session.
 *
 * @remarks `sessions.id` and `sessions.token_family_id` are both `uuid` columns, so nothing
 * at the type level stops one from reaching the other. Reuse detection revokes *every*
 * session sharing a family id, which means swapping the two does not fail loudly — it
 * silently revokes the wrong sessions. Branding them keeps that a compile error.
 */
import { EntityId } from '@auth/core';

export class SessionId {
  private constructor(readonly value: string) {}

  /**
   * Mints a v4 id, or validates a supplied one.
   *
   * @remarks Ids are always supplied *into* the aggregate rather than generated inside it:
   * replaying a write must reproduce the original id.
   */
  static create(value?: string): SessionId {
    return new SessionId(EntityId.create<'SessionId'>(value));
  }

  /** Rehydration path: the row is trusted, so an unusual-but-stored id is never rejected. */
  static fromStored(value: string): SessionId {
    return new SessionId(EntityId.unwrap(value));
  }

  static isValid(value: unknown): value is string {
    return EntityId.isValid(value);
  }

  equals(other: SessionId | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    return other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}