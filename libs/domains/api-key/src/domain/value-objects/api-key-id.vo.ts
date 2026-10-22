/**
 * @fileoverview The identity of an api key.
 *
 * @remarks `api_keys.id` and `api_keys.rotated_from_id` are both `uuid` columns, so nothing
 * at the type level stops one from reaching the other. Rotation links the successor to its
 * predecessor, and mixing the two up silently records the wrong lineage — the chain an
 * investigation walks. Branding them keeps that a compile error.
 *
 * @remarks A class rather than a `as const` union because an id is not a closed set of
 * values: it is a shape, validated once at the boundary and then trusted. The closed-set
 * treatment belongs to {@link ApiKeyPrefix}, {@link ApiKeyScope} and {@link ApiKeyStatus}.
 */
import { EntityId } from '@auth/ddd-core';

export class ApiKeyId {
  private constructor(readonly value: string) {}

  /**
   * Mints a v4 id, or validates a supplied one.
   *
   * @remarks Ids are always supplied *into* the aggregate rather than generated inside it:
   * replaying a write must reproduce the original id, so generation cannot happen in the
   * constructor.
   */
  static create(value?: string): ApiKeyId {
    return new ApiKeyId(EntityId.create<'ApiKeyId'>(value));
  }

  /** Rehydration path: the row is trusted, so an unusual-but-stored id is never rejected. */
  static fromStored(value: string): ApiKeyId {
    return new ApiKeyId(EntityId.unwrap(value));
  }

  static isValid(value: unknown): value is string {
    return EntityId.isValid(value);
  }

  equals(other: ApiKeyId | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    return other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}