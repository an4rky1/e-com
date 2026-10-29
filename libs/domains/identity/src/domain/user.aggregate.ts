import { AggregateRoot, DomainEvent, Email, Ensure, type IDomainEvent } from '@auth/core';
import type { UserStatus } from './value-objects/user-status.vo';

export interface UserProps {
  email: Email;
  displayName: string | null;
  locale: string;
  status: UserStatus;
  emailVerified: boolean;
  version: number;
  deletedReason: string | null;
}

/** Aggregate/event identity constants — the prefix that scopes every user event. */
export const USER_AGGREGATE = 'User';

export class UserCreated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: {
      userId: string;
      email: string;
      displayName: string | null;
      source: string;
    },
    version = 1,
  ) {
    super(aggregateId, USER_AGGREGATE, 'user.registered', version);
  }
}

export class UserActivated extends DomainEvent {
  constructor(aggregateId: string, version = 1) {
    super(aggregateId, USER_AGGREGATE, 'user.activated', version);
  }
}

export class UserEmailVerified extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; email: string },
    version = 1,
  ) {
    super(aggregateId, USER_AGGREGATE, 'user.email_verified', version);
  }
}

export class UserSuspended extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; previousStatus: UserStatus; reason: string | null },
    version = 1,
  ) {
    super(aggregateId, USER_AGGREGATE, 'user.suspended', version);
  }
}

export class UserReactivated extends DomainEvent {
  constructor(aggregateId: string, version = 1) {
    super(aggregateId, USER_AGGREGATE, 'user.reactivated', version);
  }
}

export class UserDeleted extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: { userId: string; reason: string | null },
    version = 1,
  ) {
    super(aggregateId, USER_AGGREGATE, 'user.deleted', version);
  }
}

/**
 * The user account.
 *
 * @remarks Identity owns *who someone is* and nothing else. Passwords live in
 * credential-vault, tokens in session and roles in access-control, each behind a gRPC
 * call. Storing any of them here would make "who you are" inseparable from "what you may do".
 */
export class User extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: UserProps,
    createdAt: Date,
    updatedAt: Date,
    deletedAt: Date | null,
  ) {
    super(id, createdAt, updatedAt, deletedAt);
  }

  static create(input: {
    email: Email;
    displayName?: string;
    locale?: string;
    source?: string;
    /**
     * True when the address arrived already vouched for — an OAuth sign-up where the
     * provider asserted a verified mailbox. Absent means the usual case: a letter is on
     * its way and the account stays `pending_verification` until it is opened.
     */
    emailVerified?: boolean;
    id?: string;
    now?: Date;
  }): User {
    Ensure.notEmpty(input.locale ?? 'en', 'locale');

    const now = input.now ?? new Date();
    const id = input.id ?? crypto.randomUUID();

    const user = new User(
      id,
      {
        email: input.email,
        displayName: input.displayName?.trim() || null,
        locale: input.locale ?? 'en',
        status: 'pending_verification',
        emailVerified: input.emailVerified ?? false,
        version: 1,
        deletedReason: null,
      },
      now,
      now,
      null,
    );

    user.addDomainEvent(
      new UserCreated(id, {
        userId: id,
        email: input.email.value,
        displayName: user.props.displayName,
        source: input.source ?? 'web',
      }),
    );

    return user;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: {
    id: string;
    email: string;
    display_name: string | null;
    locale: string;
    status: string;
    email_verified: boolean;
    version: number;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
    deleted_reason: string | null;
  }): User {
    return new User(
      row.id,
      {
        email: Email.fromTrusted(row.email),
        displayName: row.display_name,
        locale: row.locale,
        status: row.status as UserStatus,
        emailVerified: row.email_verified,
        version: row.version,
        deletedReason: row.deleted_reason,
      },
      row.created_at,
      row.updated_at,
      row.deleted_at,
    );
  }

  get email(): Email {
    return this.props.email;
  }

  get displayName(): string | null {
    return this.props.displayName;
  }

  get locale(): string {
    return this.props.locale;
  }

  get status(): UserStatus {
    return this.props.status;
  }

  get emailVerified(): boolean {
    return this.props.emailVerified;
  }

  get deletedReason(): string | null {
    return this.props.deletedReason;
  }

  get isAuthenticatable(): boolean {
    return !this.isDeleted && this.props.status === 'active';
  }

  /**
   * Confirms the address.
   *
   * @remarks Idempotent: verification links are emailed and may be followed twice, and a
   * second click must not fail the user with a conflict.
   */
  verifyEmail(now: Date = new Date()): void {
    if (this.isDeleted) {
      throw new Error('Cannot verify the email of a deleted user');
    }
    if (this.props.emailVerified) return;

    this.props.emailVerified = true;
    if (this.props.status === 'pending_verification') {
      this.props.status = 'active';
    }
    this.bump(now);
    this.addDomainEvent(
      new UserEmailVerified(this.id, {
        userId: this.id,
        email: this.props.email.value,
      }),
    );
  }

  suspend(reason: string | null, now: Date = new Date()): void {
    if (this.isDeleted) {
      throw new Error('Cannot suspend a deleted user');
    }
    if (this.props.status === 'suspended') return;

    const previousStatus = this.props.status;
    this.props.status = 'suspended';
    this.bump(now);
    this.addDomainEvent(
      new UserSuspended(this.id, { userId: this.id, previousStatus, reason }),
    );
  }

  reactivate(now: Date = new Date()): void {
    if (this.isDeleted) {
      throw new Error('Cannot reactivate a deleted user');
    }
    if (this.props.status !== 'suspended' && this.props.status !== 'locked') {
      return;
    }

    this.props.status = this.props.emailVerified ? 'active' : 'pending_verification';
    this.bump(now);
    this.addDomainEvent(new UserReactivated(this.id));
  }

  changeDisplayName(displayName: string | null, now: Date = new Date()): void {
    this.props.displayName = displayName?.trim() || null;
    this.bump(now);
  }

  changeLocale(locale: string, now: Date = new Date()): void {
    Ensure.notEmpty(locale, 'locale');
    this.props.locale = locale;
    this.bump(now);
  }

  /** Soft delete. The row is retained so historical events still resolve the user. */
  remove(reason: string | null, now: Date = new Date()): void {
    if (this.isDeleted) return;

    this.softDelete(now);
    this.props.status = 'deleted';
    this.props.deletedReason = reason;
    this.bump(now);
    this.addDomainEvent(new UserDeleted(this.id, { userId: this.id, reason }));
  }

  /** Every mutation goes through here, so `version` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

export type UserEvent =
  | UserCreated
  | UserActivated
  | UserEmailVerified
  | UserSuspended
  | UserReactivated
  | UserDeleted;

export const isUserEvent = (event: IDomainEvent): event is UserEvent =>
  event.aggregateType === USER_AGGREGATE;