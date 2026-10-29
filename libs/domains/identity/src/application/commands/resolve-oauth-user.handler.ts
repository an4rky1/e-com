/**
 * @fileoverview Resolving an identity-provider account to the local user behind it.
 *
 * @remarks Three answers, one decision: the `(provider, subject)` link is found, or the
 * address is already an account and gets linked, or the account is created and linked. All
 * three live here rather than in the caller because the linkage is identity's data — the
 * gateway has already been handed the provider's word ("this is the person who approved the
 * consent screen") and must not also hold the rules about what that word is worth.
 *
 * @remarks The creation half delegates to {@link CreateUserHandler} rather than repeating it.
 * Registration is one write path, and a second copy of "validate the address, refuse a
 * duplicate, save the aggregate" would drift from it the day either changes — the OAuth path
 * differs in *what it does before and after* the creation, not in how creation works.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { Email } from '@auth/core';
import {
  ResourceAlreadyExistsException,
  ValidationException,
} from '@auth/platform/error-handling';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../../domain/ports/user-repository.port';
import { CreateUserCommand } from './create-user.command';
import { CreateUserHandler } from './create-user.handler';
import {
  ResolveOauthUserCommand,
  type ResolvedOauthUser,
} from './resolve-oauth-user.command';

@Injectable()
@CommandHandler(ResolveOauthUserCommand)
export class ResolveOauthUserHandler
  implements ICommandHandler<ResolveOauthUserCommand, ResolvedOauthUser>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    private readonly createUser: CreateUserHandler,
  ) {}

  async execute(command: ResolveOauthUserCommand): Promise<ResolvedOauthUser> {
    if (command.provider.trim().length === 0 || command.subject.trim().length === 0) {
      throw new ValidationException('provider and subject are required', {
        provider: command.provider.slice(0, 32),
      });
    }

    const email = Email.create(command.email);
    if (email.isFailure) {
      // A provider that handed us a malformed or absent address is refused here rather than
      // becoming an account with a broken key: the address is how every later lookup finds
      // this person, and a bad one cannot be quietly repaired afterwards.
      throw new ValidationException('email is not a valid address', {
        provider: command.provider.slice(0, 32),
      });
    }
    const address = email.unwrapOrThrow();

    // 1. The link itself — the ordinary returning sign-in.
    const linked = await this.users.findAuthIdentity(
      command.provider,
      command.subject,
    );
    if (linked !== null) {
      return { userId: linked, created: false };
    }

    // 2. The address already has an account (signed up by password, or by the other
    // provider): attach the new identity to it rather than forking a second user.
    const existing = await this.users.findByEmail(address.value);
    if (existing !== null) {
      const userId = await this.attach(command.provider, command.subject, existing.id, address.value);
      return { userId, created: false };
    }

    // 3. Nothing matches: create the account, then attach. `CreateUserHandler` refuses an
    // address that already exists — the pre-checked 409 — and that refusal means somebody
    // else won the race between our lookup and our insert, which is case 2 by now.
    let userId: string;
    try {
      userId = await this.createUser.execute(
        new CreateUserCommand(
          address.value,
          command.displayName,
          undefined,
          `oauth:${command.provider}`,
          command.emailVerified,
        ),
      );
    } catch (error) {
      if (!(error instanceof ResourceAlreadyExistsException)) throw error;
      const raced = await this.users.findByEmail(address.value);
      if (raced === null) throw error;
      const winner = await this.attach(command.provider, command.subject, raced.id, address.value);
      return { userId: winner, created: false };
    }

    const attached = await this.attach(command.provider, command.subject, userId, address.value);
    return { userId: attached, created: attached === userId };
  }

  /**
   * Links the provider account, and reports which user ended up holding it.
   *
   * @remarks A unique violation on `(provider, subject)` means a concurrent callback linked
   * the same identity first — and the row that won is the authoritative answer, so it is read
   * back rather than refused. Anything else is not ours to translate and propagates.
   */
  private async attach(
    provider: string,
    subject: string,
    userId: string,
    email: string,
  ): Promise<string> {
    try {
      await this.users.linkAuthIdentity({ provider, subject, userId, email });
      return userId;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.users.findAuthIdentity(provider, subject);
      if (winner === null) throw error;
      return winner;
    }
  }
}

/** Postgres `23505`. Prisma surfaces it as `P2002`. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'P2002' || code === '23505';
}
