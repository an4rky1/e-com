/**
 * @fileoverview Command to define a role.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means changing a REST
 * field name never reaches the domain.
 *
 * @remarks A class rather than an interface: `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off whatever it is given.
 * A string bus key therefore throws at import (`Reflect.hasOwnMetadata` rejects a non-object)
 * and can never dispatch. `Command<R>` still carries the result type, so the bus call is as
 * type-checked as it would be with a plain interface.
 */
import { Command } from '@nestjs/cqrs';

export class CreateRoleCommand extends Command<string> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly name: string,
    readonly permissions?: readonly string[],
    readonly description?: string,
    /** Seeding path only. A role created through the API is never a system role. */
    readonly isSystem?: boolean,
  ) {
    super();
  }
}

export const toCreateRoleCommand = (input: {
  name: string;
  permissions?: string[];
  description?: string;
  isSystem?: boolean;
}): CreateRoleCommand =>
  new CreateRoleCommand(
    input.name,
    input.permissions,
    input.description,
    input.isSystem,
  );