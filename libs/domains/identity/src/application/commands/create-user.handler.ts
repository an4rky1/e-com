import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Email } from '@auth/core';
import {
  ResourceAlreadyExistsException,
  ValidationException,
} from '@auth/platform/error-handling';
import { User } from '../../domain/user.aggregate';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../../domain/ports/user-repository.port';
import { CreateUserCommand } from './create-user.command';

/**
 * The single write path for user creation.
 *
 * @remarks Commands are the only place mutations happen, so authorisation, auditing and
 * event publication have exactly one hook rather than one per entry point.
 */
@Injectable()
@CommandHandler(CreateUserCommand)
export class CreateUserHandler
  implements ICommandHandler<CreateUserCommand, string>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(command: CreateUserCommand): Promise<string> {
    const email = Email.create(command.email);
    if (email.isFailure) {
      // A malformed address is the caller's mistake, so it is a 400 and not a 500.
      throw new ValidationException('email is not a valid address', {
        email: String(command.email).slice(0, 64),
      });
    }

    // `Result` narrows only through its methods, not through the `isFailure` getter, so the
    // value is unwrapped explicitly once the failure branch has returned.
    const address = email.unwrapOrThrow();

    // Checked before the insert so the common case returns a clean 409, rather than relying
    // on the unique index to surface a driver-level error code.
    if (await this.users.existsByEmail(address.value)) {
      throw new ResourceAlreadyExistsException('a user with this email already exists', {
        email: address.obfuscated,
      });
    }

    const user = User.create({
      email: address,
      displayName: command.displayName,
      locale: command.locale,
      source: command.source,
    });

    // The repository writes the row and its `user.registered` event in one transaction.
    await this.users.save(user);

    return user.id;
  }
}