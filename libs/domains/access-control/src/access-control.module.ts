import { type DynamicModule, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import { CreateRoleHandler } from './application/commands/create-role.handler';
import { toCreateRoleCommand } from './application/commands/role.command';
import {
  GrantRoleToUserHandler,
  RevokeRoleFromUserHandler,
} from './application/commands/role-assignment.commands';
import {
  CreatePolicyHandler,
  DeletePolicyHandler,
} from './application/commands/policy.commands';
import {
  GetUserPermissionsHandler,
  ListRolesHandler,
} from './application/queries/access-control.queries';
import { AccessControlService } from './application/facade/access-control.service';
import { POLICY_REPOSITORY } from './domain/ports/policy-repository.port';
import { ROLE_ASSIGNMENT_REPOSITORY } from './domain/ports/role-assignment-repository.port';
import { ROLE_REPOSITORY } from './domain/ports/role-repository.port';
import { PrismaPolicyRepository } from './infrastructure/persistence/prisma-policy.repository';
import { PrismaRoleAssignmentRepository } from './infrastructure/persistence/prisma-role-assignment.repository';
import { PrismaRoleRepository } from './infrastructure/persistence/prisma-role.repository';
import { SystemRoleSeeder } from './infrastructure/seeding/system-role.seeder';
import { AccessControlHealthIndicator } from './access-control.health';
import {
  ACCESS_CONTROL_CONFIG,
  ACCESS_CONTROL_PRISMA,
  resolveAccessControlConfig,
  type AccessControlConfig,
} from './access-control.config';
import { AccessControlController } from './presentation/controller';
import { AccessControlGrpcController } from './presentation/grpc/access-control.grpc.controller';
import { AccessControlGuard } from './presentation/guards/access-control.guard';
import { PERMISSION_CHECKER } from './presentation/guards/permission-checker.port';

@Module({})
export class AccessControlModule {}

export { ACCESS_CONTROL_CONFIG };

/**
 * Assembles the access-control service.
 *
 * @remarks `AccessControlGrpcController` is exported but contributes no HTTP route: it
 * derives from `GrpcControllerBase`, which is decorated with `@Controller()` and no verb, so
 * registering it cannot shadow the REST surface. The transport itself is attached in the
 * app's bootstrap with `mergeMicroservice`, because a microservice has to join an existing
 * HTTP server rather than open its own.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is global,
 * and a global module cannot see a provider declared by the module that imports it — so an
 * outbox repository supplied "from outside" is simply never injected, and `OutboxService`
 * fails to resolve at boot. Passing the repository in is what makes the relay bind to *this*
 * service's tables.
 *
 * @remarks The outbox repository is bound to *this* service's Prisma client. That is what
 * makes {@link OutboxService} transaction-aware here: the repository reads the ambient
 * client, so events a command writes are inside the same transaction as the state change.
 */
export interface AccessControlModuleOptions {
  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

export function createAccessControlModule(
  options: AccessControlModuleOptions,
): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: this client must never be able to point at
    // another service's database.
    throw new Error('DATABASE_URL is required by the access-control module');
  }

  // One client shared by the repositories and the outbox. A second client would open a second
  // connection and commit independently, which is exactly what the outbox exists to prevent.
  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: AccessControlModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [AccessControlController, AccessControlGrpcController],
    providers: [
      { provide: ACCESS_CONTROL_PRISMA, useValue: prisma },

      { provide: ROLE_REPOSITORY, useClass: PrismaRoleRepository },
      {
        provide: ROLE_ASSIGNMENT_REPOSITORY,
        useClass: PrismaRoleAssignmentRepository,
      },
      { provide: POLICY_REPOSITORY, useClass: PrismaPolicyRepository },
      { provide: ACCESS_CONTROL_CONFIG, useFactory: () => resolveAccessControlConfig() },
      // The guard depends on the narrow port rather than the facade, so a caller that only
      // needs a decision can bind its own implementation and skip the rest of the module.
      { provide: PERMISSION_CHECKER, useExisting: AccessControlService },

      CreateRoleHandler,
      GrantRoleToUserHandler,
      RevokeRoleFromUserHandler,
      CreatePolicyHandler,
      DeletePolicyHandler,
      GetUserPermissionsHandler,
      ListRolesHandler,
      AccessControlService,
      // Runs after the container is complete, so every repository and the facade are
      // resolved by the time it writes. Idempotent: a restart converges, never duplicates.
      SystemRoleSeeder,
      AccessControlHealthIndicator,
      AccessControlGuard,
    ],
    exports: [
      AccessControlGuard,
      ROLE_REPOSITORY,
      ROLE_ASSIGNMENT_REPOSITORY,
      POLICY_REPOSITORY,
      PERMISSION_CHECKER,
    ],
  };
}

export { toCreateRoleCommand };
export type { AccessControlConfig };