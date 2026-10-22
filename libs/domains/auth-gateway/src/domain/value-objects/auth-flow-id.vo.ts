/**
 * @fileoverview The identity of an authentication flow.
 *
 * @remarks `auth_flows.id` is a `uuid` column and `auth_flow_steps.flow_id` is a second `uuid`
 * column that references it. Nothing at the type level stops a `SessionId` from being written
 * there, and the failure would not be loud — the step row would simply attach itself to some
 * other flow's history. Branding the two keeps that a compile error.
 */
import { EntityId } from '@auth/ddd-core';

export class AuthFlowId {
  private constructor(readonly value: string) {}

  /**
   * Mints a v4 id, or validates a supplied one.
   *
   * @remarks Ids are always supplied *into* aggregates rather than generated inside them:
   * replaying a write must reproduce the original id.
   */
  static create(value?: string): AuthFlowId {
    return new AuthFlowId(EntityId.create<'AuthFlowId'>(value));
  }

  /** Rehydration path: the row is trusted, so an unusual-but-stored id is never rejected. */
  static fromStored(value: string): AuthFlowId {
    return new AuthFlowId(EntityId.unwrap(value));
  }

  static isValid(value: unknown): value is string {
    return EntityId.isValid(value);
  }

  equals(other: AuthFlowId | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    return other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}