import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Email, UUID_PATTERN } from '@auth/core';
import { User } from '../../domain/user.aggregate';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../../domain/ports/user-repository.port';
import { AcquireGuestUserCommand } from './acquire-guest-user.command';

/**
 * Mints the browser's placeholder account, or renews the one it already holds.
 *
 * @remarks The id the caller presents is a *hint*, never a claim. It is honoured only when
 * the row behind it still exists and is still a guest — an unknown id, or the id of a real
 * account, falls through to a freshly minted placeholder. That check is the whole security
 * boundary here: without it, guest acquisition would be an impersonation primitive, one
 * submitted uuid away from handing back somebody else's profile.
 */
@Injectable()
@CommandHandler(AcquireGuestUserCommand)
export class AcquireGuestUserHandler
  implements ICommandHandler<AcquireGuestUserCommand, string>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(command: AcquireGuestUserCommand): Promise<string> {
    const requested = command.userId?.trim() ?? '';
    // Shape-checked before the lookup: `users.id` is `@db.Uuid`, so a value that is not a
    // uuid reaches Prisma as a validation *error*, not a miss — and the proto promises a
    // freshly minted placeholder for anything that is not a live guest row, malformed
    // included. A 500 here would make "garbage in, new guest out" a lie on this transport.
    if (requested.length > 0 && UUID_PATTERN.test(requested)) {
      const existing = await this.users.findById(requested);
      if (existing !== null && !existing.isDeleted && existing.status === 'guest') {
        existing.renewGuest();
        await this.users.save(existing);
        return existing.id;
      }
    }

    // The address is composed from the row id, so ops can map a mailbox back to its row
    // by eye; `.invalid` is RFC 2606-reserved and can never route a letter anywhere.
    const id = crypto.randomUUID();
    const email = Email.create(`guest-${id}@guest.invalid`);

    const user = User.createGuest({ email: email.unwrapOrThrow(), id });
    await this.users.save(user);

    return user.id;
  }
}
