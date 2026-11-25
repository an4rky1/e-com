// ---- configuration & composition --------------------------------------------------
export {
  ACCESS_CONTROL_PRISMA,
  Defaults,
  accessControlSchema,
  resolveAccessControlConfig,
} from './access-control.config';
export type {
  AccessControlConfig,
  AccessControlEnvConfig,
} from './access-control.config';
export { AccessControlHealthIndicator } from './access-control.health';
export {
  AccessControlModule,
  createAccessControlModule,
  ACCESS_CONTROL_CONFIG,
} from './access-control.module';

// ---- domain ----------------------------------------------------------------------
export {
  Role,
  RoleCreated,
  RoleDeleted,
  RolePermissionDeclared,
  RolePermissionWithdrawn,
  ROLE_AGGREGATE,
  isRoleEvent,
  type RoleEvent,
  type RoleProps,
} from './domain/role.aggregate';
export {
  RoleAssignment,
  RoleGranted,
  RoleRevoked,
  ROLE_ASSIGNMENT_AGGREGATE,
  isRoleAssignmentEvent,
  type RoleAssignmentEvent,
  type RoleAssignmentProps,
} from './domain/role-assignment.aggregate';
export {
  Policy,
  PolicyCreated,
  PolicyDeleted,
  POLICY_AGGREGATE,
  isPolicyEvent,
  type PolicyEvent,
  type PolicyProps,
} from './domain/policy.aggregate';
export {
  PermissionEvaluator,
  type EvaluablePolicy,
  type EvaluableRole,
  type PermissionDecision,
  type PermissionEvaluation,
} from './domain/permission-evaluator';
export {
  PermissionSlug,
  PERMISSION_SLUG_PATTERN,
  MAX_PERMISSION_SLUG_LENGTH,
  type PermissionSlugProps,
} from './domain/value-objects/permission-slug.vo';
export {
  RoleName,
  ROLE_NAME_PATTERN,
  MIN_ROLE_NAME_LENGTH,
  MAX_ROLE_NAME_LENGTH,
} from './domain/value-objects/role-name.vo';
export {
  DENYING_EFFECTS,
  PolicyEffect,
  isPolicyEffect,
} from './domain/value-objects/policy-effect.vo';
export {
  ConditionOperator,
  RESOURCE_TYPE_ATTRIBUTE,
  conditionMatches,
  conditionsHold,
  isConditionOperator,
  type EvaluationContext,
  type PolicyCondition,
} from './domain/value-objects/policy-condition.vo';

// ---- ports ------------------------------------------------------------------------
export {
  ROLE_REPOSITORY,
  type RoleRepositoryPort,
} from './domain/ports/role-repository.port';
export {
  ROLE_ASSIGNMENT_REPOSITORY,
  type RoleAssignmentRepositoryPort,
} from './domain/ports/role-assignment-repository.port';
export {
  POLICY_REPOSITORY,
  type PolicyRepositoryPort,
} from './domain/ports/policy-repository.port';

// ---- application ------------------------------------------------------------------
export {
  CreateRoleCommand,
  toCreateRoleCommand,
} from './application/commands/role.command';
export { CreateRoleHandler } from './application/commands/create-role.handler';
export {
  GrantRoleToUserCommand,
  RevokeRoleFromUserCommand,
  GrantRoleToUserHandler,
  RevokeRoleFromUserHandler,
} from './application/commands/role-assignment.commands';
export {
  CreatePolicyCommand,
  DeletePolicyCommand,
  CreatePolicyHandler,
  DeletePolicyHandler,
} from './application/commands/policy.commands';
export {
  GetUserPermissionsQuery,
  ListRolesQuery,
  GetUserPermissionsHandler,
  ListRolesHandler,
  toEvaluablePolicy,
  toEvaluableRole,
  toRoleReadModel,
  type PagedRoles,
  type RoleReadModel,
  type UserPermissionsReadModel,
} from './application/queries/access-control.queries';
export {
  AccessControlService,
  type DeniedPermissionReport,
  type PermissionChecker,
} from './application/facade/access-control.service';

// ---- infrastructure ---------------------------------------------------------------
export { PrismaRoleRepository } from './infrastructure/persistence/prisma-role.repository';
export { PrismaRoleAssignmentRepository } from './infrastructure/persistence/prisma-role-assignment.repository';
export { PrismaPolicyRepository } from './infrastructure/persistence/prisma-policy.repository';
export { SystemRoleSeeder } from './infrastructure/seeding/system-role.seeder';
export {
  enqueueEvents,
  type EnqueueOptions,
  type TopicMap,
} from './infrastructure/persistence/outbox-enqueue';

// ---- presentation -----------------------------------------------------------------
export { AccessControlController } from './presentation/controller';
export { AccessControlGrpcController } from './presentation/grpc/access-control.grpc.controller';
export { AccessControlGuard } from './presentation/guards/access-control.guard';
export { PERMISSION_CHECKER } from './presentation/guards/permission-checker.port';
export type { AuthenticatedPrincipal } from './presentation/guards/access-control.guard';
export {
  PublicEndpoint,
  RequireAnyPermission,
  RequirePermissions,
  REQUIRED_PERMISSIONS,
  type PermissionRequirement,
} from './presentation/decorators/require-permissions.decorator';
export {
  CreatePolicyRequestDto,
  CreateRoleRequestDto,
  GrantRoleRequestDto,
  ListRolesQueryDto,
  PagedRolesResponseDto,
  PermissionDecisionResponseDto,
  PolicyConditionDto,
  RevokeRoleRequestDto,
  RoleResponseDto,
  UserPermissionsResponseDto,
  toRoleResponse,
  toUserPermissionsResponse,
} from './presentation/dto/access-control.dto';