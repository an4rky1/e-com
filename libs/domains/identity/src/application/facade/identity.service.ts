import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { toCreateUserCommand, CreateUserCommand } from '../commands/create-user.command';
import { AcquireGuestUserCommand } from '../commands/acquire-guest-user.command';
import { ResolveOauthUserCommand } from '../commands/resolve-oauth-user.command';
import {
  DeleteUserCommand,
  UpdateUserStatusCommand,
  VerifyUserEmailCommand,
} from '../commands/user-status.commands';
import {
  GetUserByEmailQuery,
  GetUserByIdQuery,
  ListUsersQuery,
  type PagedUsers,
  type UserReadModel,
} from '../queries/user.queries';

/**
 * The only public surface of the identity module.
 *
 * @remarks Controllers, gRPC handlers and other services depend on this class and nothing
 * else. They therefore cannot reach the repository, the CQRS bus or the aggregate — which is
 * what makes the module's internals replaceable without touching a single caller.
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  createUser(input: {
    email: string;
    displayName?: string;
    locale?: string;
    source?: string;
    emailVerified?: boolean;
    id?: string;
  }): Promise<string> {
    return this.commandBus.execute<string>(toCreateUserCommand(input));
  }

  /**
   * The browser's placeholder account — renewed when the caller still holds a live guest
   * id, minted fresh otherwise.
   *
   * @remarks The id is a hint, not a claim: anything that is not (or is no longer) a guest
   * row buys the caller a brand-new placeholder rather than the account behind the id.
   */
  acquireGuestUser(userId?: string): Promise<string> {
    return this.commandBus.execute<string>(new AcquireGuestUserCommand(userId));
  }

  /**
   * Resolves a provider account to the local user behind it — link, link-by-address, or
   * create. The one place the (provider, subject) linkage is read or written.
   */
  resolveOauthUser(input: {
    provider: string;
    subject: string;
    email: string;
    emailVerified: boolean;
    displayName?: string;
  }): Promise<{ userId: string; created: boolean }> {
    return this.commandBus.execute(
      new ResolveOauthUserCommand(
        input.provider,
        input.subject,
        input.email,
        input.emailVerified,
        input.displayName,
      ),
    );
  }

  updateUserStatus(input: {
    userId: string;
    status: 'suspended' | 'active';
    reason?: string;
  }): Promise<void> {
    return this.commandBus.execute(
      new UpdateUserStatusCommand(input.userId, input.status, input.reason),
    );
  }

  verifyUserEmail(userId: string): Promise<void> {
    return this.commandBus.execute(new VerifyUserEmailCommand(userId));
  }

  deleteUser(userId: string, reason?: string): Promise<void> {
    return this.commandBus.execute(new DeleteUserCommand(userId, reason));
  }

  getUserById(userId: string): Promise<UserReadModel> {
    return this.queryBus.execute(new GetUserByIdQuery(userId));
  }

  getUserByEmail(email: string): Promise<UserReadModel | null> {
    return this.queryBus.execute(new GetUserByEmailQuery(email));
  }

  listUsers(input: {
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<PagedUsers> {
    return this.queryBus.execute(
      new ListUsersQuery(input.status, input.page, input.limit),
    );
  }
}

export { CreateUserCommand };
export type { UserReadModel, PagedUsers };