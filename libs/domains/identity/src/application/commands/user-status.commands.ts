import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ResourceNotFoundException } from '@auth/platform/error-handling';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '../../domain/ports/user-repository.port';

export class UpdateUserStatusCommand extends Command<void> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly status: 'suspended' | 'active',
    readonly reason?: string,
  ) {
    super();
  }
}

@Injectable()
@CommandHandler(UpdateUserStatusCommand)
export class UpdateUserStatusHandler
  implements ICommandHandler<UpdateUserStatusCommand, void>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(command: UpdateUserStatusCommand): Promise<void> {
    const user = await this.users.findById(command.userId);
    if (!user) {
      throw new ResourceNotFoundException('user not found', {
        userId: command.userId,
      });
    }

    if (command.status === 'suspended') {
      user.suspend(command.reason ?? null);
    } else {
      user.reactivate();
    }

    await this.users.save(user);
  }
}

export class VerifyUserEmailCommand extends Command<void> {
  readonly commandId: string = crypto.randomUUID();

  constructor(readonly userId: string) {
    super();
  }
}

@Injectable()
@CommandHandler(VerifyUserEmailCommand)
export class VerifyUserEmailHandler
  implements ICommandHandler<VerifyUserEmailCommand, void>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(command: VerifyUserEmailCommand): Promise<void> {
    const user = await this.users.findById(command.userId);
    if (!user) {
      throw new ResourceNotFoundException('user not found', {
        userId: command.userId,
      });
    }

    user.verifyEmail();
    await this.users.save(user);
  }
}

export class DeleteUserCommand extends Command<void> {
  readonly commandId: string = crypto.randomUUID();

  constructor(
    readonly userId: string,
    readonly reason?: string,
  ) {
    super();
  }
}

@Injectable()
@CommandHandler(DeleteUserCommand)
export class DeleteUserHandler
  implements ICommandHandler<DeleteUserCommand, void>
{
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
  ) {}

  async execute(command: DeleteUserCommand): Promise<void> {
    const user = await this.users.findById(command.userId);
    if (!user) {
      throw new ResourceNotFoundException('user not found', {
        userId: command.userId,
      });
    }

    user.remove(command.reason ?? null);
    await this.users.save(user);
  }
}