/**
 * @fileoverview Command to resolve an identity-provider account to a local user.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a REST
 * field never reaches the domain.
 *
 * @remarks A class, not an interface. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is given.
 * A plain object or a string key therefore cannot dispatch at all.
 */
import { Command } from '@nestjs/cqrs';

export interface ResolvedOauthUser {
  readonly userId: string;
  /** True when this call created the account rather than finding an existing one. */
  readonly created: boolean;
}

export class ResolveOauthUserCommand extends Command<ResolvedOauthUser> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    /** The provider's own name: `google`, `github`. */
    readonly provider: string,
    /** The provider's stable subject for the account — Google's `sub`, GitHub's id. */
    readonly subject: string,
    readonly email: string,
    /** Whether the provider asserts the address is verified. */
    readonly emailVerified: boolean,
    readonly displayName?: string,
  ) {
    super();
  }
}
