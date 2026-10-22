/**
 * @fileoverview The identity of one notification.
 *
 * @remarks A value object rather than the kernel's bare `NotificationId` brand so it carries a
 * `.value` and can be rehydrated without a cast. It matters here more than it does elsewhere:
 * a notification id arrives from a *client* as part of a "mark this read" request, and a raw
 * `string` at that boundary means a session id, a user id or a typo all reach the same query.
 */
import { EntityId } from '@auth/ddd-core';

export class NotificationId {
  private constructor(readonly value: string) {}

  /**
   * Mints a v4 id, or validates a supplied one.
   *
   * @remarks Ids are always supplied *into* the aggregate rather than generated inside it:
   * replaying a write has to reproduce the original id, or the record and the announcement
   * about it end up on two different rows.
   */
  static create(value?: string): NotificationId {
    return new NotificationId(EntityId.create<'NotificationId'>(value));
  }

  /** Rehydration path: the row is trusted, so an unusual-but-stored id is never rejected. */
  static fromStored(value: string): NotificationId {
    return new NotificationId(EntityId.unwrap(value));
  }

  static isValid(value: unknown): value is string {
    return EntityId.isValid(value);
  }

  equals(other: NotificationId | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    return other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}