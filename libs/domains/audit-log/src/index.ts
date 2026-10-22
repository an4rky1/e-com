export {
  AUDIT_LOG_CONFIG,
  AUDIT_LOG_PRISMA,
  Defaults,
  PartitionStrategy,
  auditLogSchema,
  resolveAuditLogConfig,
  type AuditLogConfig,
  type AuditLogEnvConfig,
} from './audit-log.config';
export {
  AUDIT_AGGREGATE,
  AuditEvent,
  type AuditEventProps,
  type AuditLink,
} from './domain/audit-event.aggregate';
export {
  ChainBreak,
  GENESIS_HASH,
  canonicalJson,
  canonicalLinkJson,
  computeChainHash,
  relinkFrom,
  verifyChain,
  type ChainLink,
  type ChainVerification,
  type ChainedRecord,
} from './domain/audit-chain';
export {
  AUDIT_ROUTES,
  SUBSCRIBED_TOPICS,
  resultFor,
  routeFor,
  stringOfField,
  type AuditRoute,
} from './domain/audit-routing';
export { dayBucket, partitionKeyFor } from './domain/value-objects/audit-partition.vo';
export {
  ActorType,
  AuditResult,
  ResourceType,
  UNKNOWN_ACTOR_ID,
  UNKNOWN_RESOURCE_ID,
  isAuditResult,
} from './domain/value-objects/audit-result.vo';
export {
  AUDIT_REPOSITORY,
  AppendOutcome,
  type AuditFilter,
  type AuditPage,
  type AuditRepositoryPort,
} from './domain/ports/audit-repository.port';
export {
  ClaimRefusal,
  IDEMPOTENCY_STORE,
  idempotencyKeyFor,
  type ClaimResult,
  type IdempotencyKey,
  type IdempotencyStorePort,
} from './domain/ports/idempotency-store.port';
export {
  RecordAuditEventCommand,
  toRecordAuditEventCommand,
  type RecordAuditEventInput,
} from './application/commands/record-audit-event.command';
export { RecordAuditEventHandler } from './application/commands/record-audit-event.handler';
export {
  SearchAuditEventsHandler,
  SearchAuditEventsQuery,
  VerifyAuditChainHandler,
  VerifyAuditChainQuery,
  toReadModel,
  type AuditEventReadModel,
  type PagedAuditEvents,
  type VerifyAuditChainResult,
} from './application/queries/audit.queries';
export {
  AuditEventProcessor,
  ConsumerOutcomeKind,
  parseEnvelope,
  redactPayload,
  toRoutedInput,
  type ConsumerOutcome,
  type Envelope,
} from './application/consumers/audit-event.processor';
export {
  AUDIT_RECORDER,
  CommandBusAuditRecorder,
  type AuditRecorderPort,
  type RecordResult,
} from './application/ports/audit-recorder.port';
export { AuditLogService } from './application/facade/audit-log.service';
export { PrismaAuditRepository } from './infrastructure/persistence/prisma-audit.repository';
export { PrismaIdempotencyStore } from './infrastructure/persistence/prisma-idempotency.store';
export { AuditKafkaConsumer } from './infrastructure/messaging/audit.kafka.consumer';
export { AuditLogHealthIndicator } from './audit-log.health';
export { AuditLogModule, createAuditLogModule, type AuditLogModuleOptions } from './audit-log.module';
export { AuditController } from './presentation/audit.controller';
export { toAuditFilter, toPageNumbers, type AuditQueryDto } from './presentation/dto/audit-query.dto';