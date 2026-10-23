import { AggregateRoot, DomainEvent, EntityId, Ensure, type IDomainEvent } from '@auth/core';
import type { RoleChangedPayload } from '@auth/contracts';
import { RoleName } from './value-objects/role-name.vo';

/** Aggregate/event identity constants — the prefix that scopes every assignment event. */
export const ROLE_ASSIGNMENT_AGGREGATE = 'RoleAssignment';

export class RoleGranted extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: RoleChangedPayload,
    version = 1,
  ) {
    super(aggregateId, ROLE_ASSIGNMENT_AGGREGATE, 'role.granted', version);
  }
}

export class RoleRevoked extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: RoleChangedPayload,
    version = 1,
  ) {
    super(aggregateId, ROLE_ASSIGNMENT_AGGREGATE, 'role.revoked', version);
  }
}

export interface RoleAssignmentProps {
  userId: string;
  role: RoleName;
  /** The operator who granted it — the "who asked for this access" half of an audit. */
  grantedBy: string | null;
  grantedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  reason: string | null;
  version: number;
}

/**
 * The link between a user and a role.
 *
 * @remarks A separate aggregate from `Role` even though the row is a join: revoking one
 * person's access must not require loading and re-saving the role, and the two change for
 * completely different reasons. Keeping them apart is also what lets a grant be an
 * idempotent command against one row rather than a scan of every holder of the role.
 */
export class RoleAssignment extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: RoleAssignmentProps,
  ) {
    super(id, props.grantedAt, props.grantedAt);
  }

  /**
   * Grants a role.
   *
   * @remarks `grantedAt` defaults to now but is explicit so a replayed or backdated grant
   * reproduces byte-for-byte. Ids are supplied rather than minted here: replaying an event
   * stream has to produce the original row, and a fresh uuid would fork the history.
   */
  static grant(input: {
    userId: string;
    role: string | RoleName;
    grantedBy?: string | null;
    grantedAt?: Date;
    expiresAt?: Date | null;
    reason?: string | null;
    id?: string;
  }): RoleAssignment {
    Ensure.notEmpty(input.userId, 'userId');

    const role =
      input.role instanceof RoleName ? input.role : RoleName.fromTrusted(input.role);
    const grantedAt = input.grantedAt ?? new Date();
    const id = input.id ?? EntityId.create();

    Ensure.isTrue(
      input.expiresAt === null ||
        input.expiresAt === undefined ||
        input.expiresAt > grantedAt,
      'expiresAt must be in the future',
      'OUT_OF_RANGE',
    );

    const assignment = new RoleAssignment(id, {
      userId: input.userId,
      role,
      grantedBy: input.grantedBy ?? null,
      grantedAt,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      reason: input.reason ?? null,
      version: 1,
    });

    assignment.addDomainEvent(
      new RoleGranted(id, {
        userId: assignment.props.userId,
        role: assignment.props.role.value,
        grantedBy: assignment.props.grantedBy ?? undefined,
        reason: assignment.props.reason ?? undefined,
      }),
    );

    return assignment;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: {
    id: string;
    user_id: string;
    role: string;
    granted_by: string | null;
    granted_at: Date;
    expires_at: Date | null;
    revoked_at: Date | null;
  }): RoleAssignment {
    return new RoleAssignment(row.id, {
      userId: row.user_id,
      role: RoleName.fromTrusted(row.role),
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      reason: null,
      version: 1,
    });
  }

  get userId(): string {
    return this.props.userId;
  }

  get role(): RoleName {
    return this.props.role;
  }

  get grantedBy(): string | null {
    return this.props.grantedBy;
  }

  get grantedAt(): Date {
    return this.props.grantedAt;
  }

  get expiresAt(): Date | null {
    return this.props.expiresAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get reason(): string | null {
    return this.props.reason;
  }

  /** Aggregated revision, independent of how many events this instance has buffered. */
  get revision(): number {
    return this.props.version;
  }

  /**
   * Whether the assignment confers the role at `at`.
   *
   * @remarks Expiry is evaluated on read rather than by a scheduled job, so access ends the
   * moment the deadline passes whether or not anything woke up to clean it up. A sweeper
   * only decides when the row may be deleted, never whether access was ever valid.
   */
  isActiveAt(at: Date = new Date()): boolean {
    if (this.props.revokedAt !== null) return false;
    if (this.props.expiresAt !== null && this.props.expiresAt <= at) return false;
    return true;
  }

  /**
   * Revokes the assignment.
   *
   * @remarks Idempotent: an operator clicking revoke twice, or a cleanup pass racing an
   * explicit revocation, must not produce two `role.revoked` facts about one assignment.
   */
  revoke(reason: string | null = null, now: Date = new Date()): void {
    if (this.props.revokedAt !== null) return;

    this.props.revokedAt = now;
    if (reason) this.props.reason = reason;
    this.bump(now);

    this.addDomainEvent(
      new RoleRevoked(this.id, {
        userId: this.props.userId,
        role: this.props.role.value,
        reason: reason ?? this.props.reason ?? undefined,
      }),
    );
  }

  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

export type RoleAssignmentEvent = RoleGranted | RoleRevoked;

export const isRoleAssignmentEvent = (
  event: IDomainEvent,
): event is RoleAssignmentEvent =>
  event.aggregateType === ROLE_ASSIGNMENT_AGGREGATE;