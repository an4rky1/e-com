/**
 * @fileoverview Command to register a user.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a REST
 * field never reaches the domain.
 *
 * @remarks A class, not an interface. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is given.
 * A plain object or a string key therefore cannot dispatch at all — `@CommandHandler('Name')`
 * throws at import, because `Reflect.hasOwnMetadata` rejects a non-object.
 */
import { Command } from '@nestjs/cqrs';

export class CreateUserCommand extends Command<string> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly email: string,
    readonly displayName?: string,
    readonly locale?: string,
    /** Where the registration came from: `web`, `admin`, `oauth:<provider>`. */
    readonly source?: string,
  ) {
    super();
  }
}

export const toCreateUserCommand = (input: {
  email: string;
  displayName?: string;
  locale?: string;
  source?: string;
}): CreateUserCommand =>
  new CreateUserCommand(
    input.email,
    input.displayName,
    input.locale,
    input.source,
  );