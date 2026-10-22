/**
 * @fileoverview The identity of a refresh-token family.
 *
 * @remarks A family is the blast radius of reuse detection: every session sharing this id is
 * revoked the moment one already-consumed token is replayed. It is modelled as its own type
 * rather than a `SessionId` so that a family can never be persisted into `sessions.id`, and
 * so the repository's family-wide queries read as what they are.
 */
import { EntityId } from '@auth/ddd-core';

export class TokenFamilyId {
  private constructor(readonly value: string) {}

  static create(value?: string): TokenFamilyId {
    return new TokenFamilyId(EntityId.create<'TokenFamilyId'>(value));
  }

  static fromStored(value: string): TokenFamilyId {
    return new TokenFamilyId(EntityId.unwrap(value));
  }

  static isValid(value: unknown): value is string {
    return EntityId.isValid(value);
  }

  equals(other: TokenFamilyId | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    return other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}