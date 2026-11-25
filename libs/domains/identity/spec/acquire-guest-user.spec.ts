/**
 * @fileoverview Guest acquisition as a use case: renew the placeholder the browser still
 * holds, mint one otherwise.
 *
 * @remarks The interesting assertions are the refusals — an id that is unknown or belongs
 * to a real account must buy the caller a *fresh* placeholder, never the row behind the id.
 */
import { Email } from '@auth/core';
import { AcquireGuestUserCommand } from '../src/application/commands/acquire-guest-user.command';
import { AcquireGuestUserHandler } from '../src/application/commands/acquire-guest-user.handler';
import { User } from '../src/domain/user.aggregate';
import type { UserRepositoryPort } from '../src/domain/ports/user-repository.port';
import { UserStatus } from '../src/domain/value-objects/user-status.vo';

class FakeUserRepo implements UserRepositoryPort {
  readonly rows = new Map<string, User>();

  async save(user: User): Promise<void> {
    this.rows.set(user.id, user);
  }

  async findById(id: string): Promise<User | null> {
    return this.rows.get(id) ?? null;
  }

  async findByEmail(): Promise<User | null> {
    throw new Error('not under test');
  }

  async existsByEmail(): Promise<boolean> {
    throw new Error('not under test');
  }

  async findAuthIdentity(): Promise<string | null> {
    throw new Error('not under test');
  }

  async linkAuthIdentity(): Promise<void> {
    throw new Error('not under test');
  }

  async find(): Promise<User[]> {
    throw new Error('not under test');
  }

  async count(): Promise<number> {
    throw new Error('not under test');
  }

  async deleteStaleGuests(): Promise<number> {
    throw new Error('not under test');
  }
}

const storedGuest = (id: string, updatedAt: Date): User =>
  User.fromRow({
    id,
    email: `guest-${id}@guest.invalid`,
    display_name: null,
    locale: 'en',
    status: 'guest',
    email_verified: false,
    version: 1,
    created_at: updatedAt,
    updated_at: updatedAt,
    deleted_at: null,
    deleted_reason: null,
  });

const GUEST_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('AcquireGuestUserHandler', () => {
  it('mints a placeholder on a first visit, with a mailbox that names its row', async () => {
    const repo = new FakeUserRepo();
    const handler = new AcquireGuestUserHandler(repo);

    const id = await handler.execute(new AcquireGuestUserCommand());

    const row = repo.rows.get(id);
    expect(row).toBeDefined();
    expect(row?.status).toBe(UserStatus.GUEST);
    expect(row?.email.value).toBe(`guest-${id}@guest.invalid`);
    expect(row?.domainEvents).toHaveLength(0);
  });

  it('renews the placeholder when the same browser comes back', async () => {
    const repo = new FakeUserRepo();
    const stale = new Date('2020-01-01T00:00:00.000Z');
    repo.rows.set(GUEST_ID, storedGuest(GUEST_ID, stale));
    const handler = new AcquireGuestUserHandler(repo);

    const id = await handler.execute(new AcquireGuestUserCommand(GUEST_ID));

    expect(id).toBe(GUEST_ID);
    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get(GUEST_ID)?.updatedAt.getTime()).toBeGreaterThan(
      stale.getTime(),
    );
    expect(repo.rows.get(GUEST_ID)?.domainEvents).toHaveLength(0);
  });

  it('mints a fresh placeholder when the id names a real account', async () => {
    const repo = new FakeUserRepo();
    const real = User.create({
      email: Email.fromTrusted('real@example.com'),
      id: '2b0f9d54-8f19-4a5c-9a3e-6f0b8f0d1c22',
    });
    repo.rows.set(real.id, real);
    const handler = new AcquireGuestUserHandler(repo);

    const id = await handler.execute(new AcquireGuestUserCommand(real.id));

    expect(id).not.toBe(real.id);
    expect(repo.rows.size).toBe(2);
    expect(repo.rows.get(id)?.status).toBe(UserStatus.GUEST);
  });

  it('mints a fresh placeholder when the id is unknown', async () => {
    const repo = new FakeUserRepo();
    const handler = new AcquireGuestUserHandler(repo);

    const id = await handler.execute(
      new AcquireGuestUserCommand('9c1d2e3f-0000-4000-8000-000000000000'),
    );

    expect(id).not.toBe('9c1d2e3f-0000-4000-8000-000000000000');
    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get(id)?.status).toBe(UserStatus.GUEST);
  });

  it('mints a fresh placeholder when the guest row was already reaped', async () => {
    const repo = new FakeUserRepo();
    const handler = new AcquireGuestUserHandler(repo);

    const id = await handler.execute(new AcquireGuestUserCommand(GUEST_ID));

    expect(id).not.toBe(GUEST_ID);
    expect(repo.rows.size).toBe(1);
  });

  it('mints a fresh placeholder for an id that is not even a uuid', async () => {
    // `users.id` is `@db.Uuid`: without the shape check the lookup itself throws, and the
    // promise "anything that is not a live guest row buys you a new placeholder" breaks.
    const repo = new FakeUserRepo();
    const findById = jest.spyOn(repo, 'findById');
    const handler = new AcquireGuestUserHandler(repo);

    const id = await handler.execute(new AcquireGuestUserCommand('not-a-uuid'));

    expect(findById).not.toHaveBeenCalled();
    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get(id)?.status).toBe(UserStatus.GUEST);
  });
});
