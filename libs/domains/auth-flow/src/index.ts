// ---- configuration -------------------------------------------------------------
export {
  AUTH_FLOW_CONFIG,
  AUTH_FLOW_PRISMA,
  Defaults,
  authFlowSchema,
  resolveAuthFlowConfig,
  type AuthFlowConfig,
  type AuthFlowEnvConfig,
} from './auth-flow.config';

// ---- the state machine ---------------------------------------------------------
export {
  AUTH_FLOW_AGGREGATE,
  AuthFlow,
  AuthFlowCompleted,
  AuthFlowEnded,
  AuthFlowStarted,
  AuthFlowStepCompleted,
  MAX_ATTEMPTS_REASON,
  isAuthFlowEvent,
  type AuthFlowEvent,
  type AuthFlowProps,
  type AuthFlowRow,
  type AuthFlowStepRow,
} from './domain/auth-flow.aggregate';

export {
  AUTH_FLOW_STATES,
  AUTH_FLOW_TRANSITIONS,
  AuthFlowState,
  OPEN_STATES,
  TERMINAL_STATES,
  allowedTargets,
  assertTransition,
  canTransition,
  describeTransitionTable,
  isAuthFlowState,
  isTerminalState,
} from './domain/value-objects/auth-flow-state.vo';

export {
  AUTH_FLOW_TYPES,
  AuthFlowType,
  INITIAL_STATE_BY_TYPE,
  SECOND_FACTOR_TYPES,
  SESSION_ISSUING_TYPES,
  isAuthFlowType,
  issuesSession,
} from './domain/value-objects/auth-flow-type.vo';

export { AuthFlowId } from './domain/value-objects/auth-flow-id.vo';

export {
  FLOW_ORIGIN,
  FLOW_STEPS,
  FlowStep,
  describeSteps,
  isProofStep,
  recordStep,
  type FlowOrigin,
  type FlowStepEntry,
  type FlowStepFrom,
} from './domain/value-objects/flow-step.vo';

// ---- ports ---------------------------------------------------------------------
export {
  AUTH_FLOW_REPOSITORY,
  type AuthFlowRepositoryPort,
} from './domain/ports/auth-flow-repository.port';
export { CLOCK, type IClock } from './domain/ports/clock.port';
export {
  CREDENTIAL_PORT,
  type CredentialPort,
  type PasswordVerification,
} from './domain/ports/credential.port';
export {
  IDENTITY_PORT,
  type IdentityPort,
  type IdentityUserView,
} from './domain/ports/identity.port';
export {
  MFA_PORT,
  type FactorVerification,
  type MfaPort,
} from './domain/ports/mfa.port';
export {
  SESSION_PORT,
  type IssuedTokens,
  type RotatedTokens,
  type SessionPort,
} from './domain/ports/session.port';

// ---- application ---------------------------------------------------------------
export {
  AdvanceFlowCommand,
  CancelFlowCommand,
  FlowMessage,
  StartFlowCommand,
  isRetryable,
  messageFor,
  type FlowOutcome,
} from './application/commands/auth-flow.commands';
export {
  AdvanceFlowHandler,
  CancelFlowHandler,
  StartFlowHandler,
} from './application/commands/auth-flow.handlers';
export {
  GetFlowHandler,
  GetFlowQuery,
} from './application/queries/auth-flow.queries';
export { AuthFlowService } from './application/facade/auth-flow.service';

// ---- infrastructure ------------------------------------------------------------
export { PrismaAuthFlowRepository } from './infrastructure/persistence/prisma-auth-flow.repository';
export {
  GrpcCredentialAdapter,
  GrpcIdentityAdapter,
  GrpcMfaAdapter,
  GrpcSessionAdapter,
} from './infrastructure/grpc/grpc-ports';
export { FixedClock, SystemClock } from './infrastructure/time/system-clock';

// ---- presentation --------------------------------------------------------------
export { AuthFlowGrpcController } from './presentation/grpc/auth-flow.grpc.controller';
export { toFlowResponse } from './presentation/dto/auth-flow.dto';

// ---- module --------------------------------------------------------------------
export { AuthFlowHealthIndicator } from './auth-flow.health';
export {
  AuthFlowModule,
  createAuthFlowModule,
  type AuthFlowModuleOptions,
} from './auth-flow.module';