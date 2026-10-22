export {
  ACCOUNT_SECURITY_CONFIG,
  ACCOUNT_SECURITY_PRISMA,
  ACCOUNT_SECURITY_REDIS,
  Defaults,
  accountSecuritySchema,
  resolveAccountSecurityConfig,
  type AccountSecurityConfig,
  type AccountSecurityEnvConfig,
} from './account-security.config';
export {
  AccountSecurityModule,
  createAccountSecurityModule,
  type AccountSecurityModuleOptions,
} from './account-security.module';
export { AccountSecurityHealthIndicator } from './account-security.health';
export {
  LockAccountCommand,
  RecordLoginAttemptCommand,
  RevokeDeviceCommand,
  UnlockAccountCommand,
  toLockAccountCommand,
  toRecordLoginAttemptCommand,
  toRevokeDeviceCommand,
  toUnlockAccountCommand,
  type AttemptOutcome,
  type LoginAttemptInput,
} from './application/commands/login-attempt.commands';
export {
  LockAccountHandler,
  RecordLoginAttemptHandler,
  RevokeDeviceHandler,
  UnlockAccountHandler,
} from './application/commands/login-attempt.handlers';
export {
  AssessRiskHandler,
  AssessRiskQuery,
  GetLoginHistoryHandler,
  GetLoginHistoryQuery,
  ListDevicesHandler,
  ListDevicesQuery,
  type DeviceReadModel,
  type LoginHistoryPage,
  type LoginHistoryReadModel,
  type RiskAssessmentReadModel,
} from './application/queries/account-security.queries';
export {
  toFingerprint,
  toLocation,
  toRiskAssessmentInput,
  toRiskAssessmentReadModel,
  type RiskContext,
} from './application/queries/risk-assessment.read-model';
export { AccountSecurityService } from './application/facade/account-security.service';
export {
  AccountSecurityGrpcController,
} from './presentation/grpc/account-security.grpc.controller';
export {
  FAILED_ATTEMPTS_LOCK_REASON,
  LOGIN_ATTEMPT_AGGREGATE,
  AccountLocked,
  AccountUnlocked,
  LoginAttempt,
  type LoginAttemptProps,
  type LoginHistoryRow,
  type LockoutPolicy,
} from './domain/login-attempt.aggregate';
export {
  SECURITY_SIGNAL_AGGREGATE,
  SecuritySignal,
  SecuritySignalRaised,
  type SecuritySignalProps,
  type SecuritySignalRow,
} from './domain/security-signal.aggregate';
export {
  FAILURE_TRACKER,
  type FailureTrackerPort,
} from './domain/ports/failure-tracker.port';
export { RISK_SCORING, type RiskScoringPort } from './domain/ports/risk-scoring.port';
export {
  DEVICE_REGISTRY,
  SECURITY_REPOSITORY,
  type DeviceRegistryPort,
  type DeviceUsage,
  type LoginHistoryEntry,
  type SecurityRepositoryPort,
} from './domain/ports/security-repository.port';
export {
  DeviceFingerprint,
  canonicaliseDeviceSignals,
  normaliseDeviceSignal,
  type DeviceSignals,
} from './domain/value-objects/device-fingerprint.vo';
export {
  DEFAULT_IMPOSSIBLE_TRAVEL_KM,
  EARTH_RADIUS_KM,
  GeoLocation,
  haversineDistanceKm,
  type Coordinates,
} from './domain/value-objects/geo-location.vo';
export {
  EMPTY_COUNTERS,
  normaliseScope,
  type FailureCounters,
  type FailureScope,
} from './domain/value-objects/failure-counters.vo';
export {
  RISK_BOUNDARIES,
  RISK_SCORE_MAX,
  RISK_SCORE_MIN,
  RiskLevel,
  RiskScore,
  riskCeilingFor,
  riskLevelFor,
} from './domain/value-objects/risk-score.vo';
export {
  SecuritySignalType,
  isSecuritySignalType,
  type PublishedSignalType,
} from './domain/value-objects/security-signal-type.vo';
export {
  Defaults as RiskDefaults,
  RISK_FACTOR_WEIGHTS,
  RiskFactorType,
  RiskScoringService,
  type RiskAssessment,
  type RiskAssessmentInput,
  type RiskFactor,
  type RiskScoringPolicy,
} from './domain/services/risk-scoring.service';
export { PrismaSecurityRepository } from './infrastructure/persistence/prisma-security.repository';
export {
  NoopFailureTracker,
  RedisFailureTracker,
  type RedisCounterOptions,
} from './infrastructure/cache/redis-failure-tracker';