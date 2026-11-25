import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../../domain/ports/user-repository.port';
import { IDENTITY_CONFIG, type IdentityConfig } from '../../identity.config';
import { ReapGuestUsersCommand } from './reap-guest-users.command';

const MS_PER_DAY = 86_400_000;

/**
 * Deletes guest rows nothing has renewed inside the configured window.
 *
 * @remarks The freshness marker is `updated_at`, refreshed by `renewGuest` whenever the
 * browser returns — so the sweep can never take a placeholder an active shopper is still
 * holding, only one whose tab has been gone longer than the window.
 */
@Injectable()
@CommandHandler(ReapGuestUsersCommand)
export class ReapGuestUsersHandler
  implements ICommandHandler<ReapGuestUsersCommand, number>
{
  private static readonly logger = new Logger(ReapGuestUsersHandler.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(IDENTITY_CONFIG) private readonly config: IdentityConfig,
  ) {}

  async execute(): Promise<number> {
    const before = new Date(
      Date.now() - this.config.guestReapMaxAgeDays * MS_PER_DAY,
    );
    const reaped = await this.users.deleteStaleGuests(before);

    if (reaped > 0) {
      ReapGuestUsersHandler.logger.log(
        `reaped ${reaped} guest account(s) stale since ${before.toISOString()}`,
      );
    }
    return reaped;
  }
}
