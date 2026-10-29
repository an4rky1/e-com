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
    /** True when the address came vouched for (an OAuth provider); absent means pending. */
    readonly emailVerified?: boolean,
    /**
     * Caller-chosen id for the account; absent lets `User.create` generate one. Registration
     * pre-chooses it so the password is stored against the id the account will have — the
     * credential is written first and revoked if this command then refuses the address.
     */
    readonly id?: string,
  ) {
    super();
  }
}

export const toCreateUserCommand = (input: {
  email: string;
  displayName?: string;
  locale?: string;
  source?: string;
  emailVerified?: boolean;
  id?: string;
}): CreateUserCommand =>
  new CreateUserCommand(
    input.email,
    input.displayName,
    input.locale,
    input.source,
    input.emailVerified,
    input.id,
  );