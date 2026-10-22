export { IDENTITY_PRISMA, Defaults, identitySchema } from './identity.config';
export type { IdentityConfig, IdentityEnvConfig } from './identity.config';
export {
  CreateUserCommand,
  toCreateUserCommand,
} from './application/commands/create-user.command';
export {
  DeleteUserCommand,
  UpdateUserStatusCommand,
  VerifyUserEmailCommand,
  DeleteUserHandler,
  UpdateUserStatusHandler,
  VerifyUserEmailHandler,
} from './application/commands/user-status.commands';
export { CreateUserHandler } from './application/commands/create-user.handler';
export {
  GetUserByEmailQuery,
  GetUserByIdQuery,
  ListUsersQuery,
  GetUserByEmailHandler,
  GetUserByIdHandler,
  ListUsersHandler,
  toReadModel,
  type PagedUsers,
  type UserReadModel,
} from './application/queries/user.queries';
export { IdentityService } from './application/facade/identity.service';
export {
  User,
  UserActivated,
  UserCreated,
  UserDeleted,
  UserEmailVerified,
  UserReactivated,
  UserSuspended,
  USER_AGGREGATE,
  type UserEvent,
  type UserProps,
} from './domain/user.aggregate';
export {
  AUTHENTICATABLE,
  TERMINAL_STATUSES,
  UserStatus,
  isUserStatus,
} from './domain/value-objects/user-status.vo';
export {
  ByStatus,
  NotDeleted,
  USER_REPOSITORY,
  UserSpecification,
  type UserRepositoryPort,
} from './domain/ports/user-repository.port';
export { PrismaUserRepository } from './infrastructure/persistence/prisma-user.repository';
export { IdentityHealthIndicator } from './identity.health';
export { IdentityModule, createIdentityModule } from './identity.module';
export { UserController } from './presentation/user.controller';
export { IdentityGrpcController } from './presentation/grpc/identity.grpc.controller';
export { UserResponseDto } from './presentation/dto/user.dto';