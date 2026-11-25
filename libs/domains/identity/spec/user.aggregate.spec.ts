import { Email } from '@auth/core';
import { User, type UserCreated, type UserEmailVerified, type UserSuspended } from '../src/domain/user.aggregate';
import { AUTHENTICATABLE, UserStatus } from '../src/domain/value-objects/user-status.vo';

const email = (value = 'user@example.com') => Email.fromTrusted(value);

describe('User.create', () => {
  it('starts pending verification and cannot authenticate', () => {
    const user = User.create({ email: email() });

    expect(user.status).toBe(UserStatus.PENDING_VERIFICATION);
    expect(user.isAuthenticatable).toBe(false);
  });

  it('emits exactly one user.registered event carrying the aggregate id', () => {
    const user = User.create({ email: email(), source: 'web' });

    const events = user.domainEvents;
    expect(events).toHaveLength(1);

    const [event] = events as UserCreated[];
    expect(event.eventType).toBe('user.registered');
    expect(event.aggregateId).toBe(user.id);
    expect(event.aggregateType).toBe('User');
    expect(event.payload.source).toBe('web');
  });

  it('normalises a blank display name to null rather than storing whitespace', () => {
    const user = User.create({ email: email(), displayName: '   ' });
    expect(user.displayName).toBeNull();
  });

  it('preserves an explicitly supplied id so replay is reproducible', () => {
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect(User.create({ email: email(), id }).id).toBe(id);
  });
});

describe('User.createGuest', () => {
  it('is a guest, unverified and non-authenticatable', () => {
    const user = User.createGuest({ email: email('guest-1@guest.invalid') });

    expect(user.status).toBe(UserStatus.GUEST);
    expect(user.emailVerified).toBe(false);
    expect(user.displayName).toBeNull();
    expect(user.isAuthenticatable).toBe(false);
    expect(AUTHENTICATABLE.has(user.status)).toBe(false);
  });

  it('announces nothing — a placeholder is not a registration', () => {
    // `user.registered` carries a welcome letter with it; a mailbox that by construction
    // cannot receive one must never reach that stream.
    const user = User.createGuest({ email: email('guest-1@guest.invalid') });

    expect(user.domainEvents).toHaveLength(0);
  });

  it('preserves a supplied id so the mailbox names the row it belongs to', () => {
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    expect(User.createGuest({ email: email(), id }).id).toBe(id);
  });
});

describe('User.renewGuest', () => {
  it('refreshes updated_at without a status change or an event', () => {
    const past = new Date('2026-01-01T00:00:00.000Z');
    const user = User.createGuest({ email: email(), now: past });

    const now = new Date('2026-11-16T12:00:00.000Z');
    user.renewGuest(now);

    expect(user.updatedAt).toEqual(now);
    expect(user.status).toBe(UserStatus.GUEST);
    expect(user.domainEvents).toHaveLength(0);
  });

  it('refuses an account that is not a guest', () => {
    const user = User.create({ email: email() });

    expect(() => user.renewGuest()).toThrow(/not a guest/);
  });
});

describe('User.verifyEmail', () => {
  it('activates a pending user and emits user.email_verified', () => {
    const user = User.create({ email: email() });
    user.clearDomainEvents();

    user.verifyEmail();

    expect(user.emailVerified).toBe(true);
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.isAuthenticatable).toBe(true);
    expect(AUTHENTICATABLE.has(user.status)).toBe(true);

    const [event] = user.domainEvents as UserEmailVerified[];
    expect(event.eventType).toBe('user.email_verified');
    expect(event.payload.email).toBe('user@example.com');
  });

  it('is idempotent — a verification link may be followed twice', () => {
    const user = User.create({ email: email() });
    user.verifyEmail();
    user.clearDomainEvents();

    user.verifyEmail();

    // A second click must not fail the user, and must not emit a duplicate event.
    expect(user.domainEvents).toHaveLength(0);
  });

  it('refuses to verify a deleted user', () => {
    const user = User.create({ email: email() });
    user.remove('user requested');

    expect(() => user.verifyEmail()).toThrow(/deleted user/);
  });
});

describe('User.suspend', () => {
  it('blocks authentication and records the previous status', () => {
    const user = User.create({ email: email() });
    user.verifyEmail();
    user.clearDomainEvents();

    user.suspend('fraud review');

    expect(user.status).toBe(UserStatus.SUSPENDED);
    expect(user.isAuthenticatable).toBe(false);

    const [event] = user.domainEvents as UserSuspended[];
    expect(event.payload.previousStatus).toBe(UserStatus.ACTIVE);
    expect(event.payload.reason).toBe('fraud review');
  });

  it('is idempotent', () => {
    const user = User.create({ email: email() });
    user.verifyEmail();
    user.suspend('first');
    user.clearDomainEvents();

    user.suspend('second');

    expect(user.domainEvents).toHaveLength(0);
  });
});

describe('User.reactivate', () => {
  it('returns a verified suspended user to active', () => {
    const user = User.create({ email: email() });
    user.verifyEmail();
    user.suspend('review');

    user.reactivate();

    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.isAuthenticatable).toBe(true);
  });

  it('returns an unverified user to pending, never straight to active', () => {
    const user = User.create({ email: email() });
    user.suspend('review');

    user.reactivate();

    // Granting `active` here would let an unverified address sign in, which is exactly what
    // registration is supposed to prevent.
    expect(user.status).toBe(UserStatus.PENDING_VERIFICATION);
    expect(user.isAuthenticatable).toBe(false);
  });

  it('ignores a user that was never suspended', () => {
    const user = User.create({ email: email() });
    user.verifyEmail();
    user.clearDomainEvents();

    user.reactivate();

    expect(user.domainEvents).toHaveLength(0);
  });
});

describe('User.remove', () => {
  it('soft-deletes and keeps the row resolvable for historical events', () => {
    const user = User.create({ email: email() });

    user.remove('gdpr request');

    expect(user.isDeleted).toBe(true);
    expect(user.status).toBe(UserStatus.DELETED);
    expect(user.deletedReason).toBe('gdpr request');
    expect(user.id).toBeTruthy();
  });

  it('is idempotent', () => {
    const user = User.create({ email: email() });
    user.remove('first');
    user.clearDomainEvents();

    user.remove('second');

    expect(user.domainEvents).toHaveLength(0);
  });

  it('blocks every subsequent lifecycle transition', () => {
    const user = User.create({ email: email() });
    user.remove('deleted');

    expect(() => user.suspend('again')).toThrow(/deleted user/);
    expect(() => user.reactivate()).toThrow(/deleted user/);
  });
});

describe('User.fromRow', () => {
  it('rehydrates without emitting events', () => {
    // Rehydration must not replay history: the write already happened and the events are
    // already in the outbox.
    const user = User.fromRow({
      id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      email: 'user@example.com',
      display_name: 'Ada',
      locale: 'en',
      status: 'active',
      email_verified: true,
      version: 3,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
      deleted_reason: null,
    });

    expect(user.domainEvents).toHaveLength(0);
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(user.displayName).toBe('Ada');
  });
});