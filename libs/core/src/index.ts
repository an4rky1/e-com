export {
  EntityId,
  UUID_PATTERN,
  type Brand,
  type UserId,
  type RoleId,
  type PermissionId,
  type CredentialId,
  type SessionId,
  type AuthFlowId,
  type NotificationId,
  type AuditEventId,
  type SecurityEventId,
  type ApiKeyId,
  type OutboxId,
} from './domain/value-objects/entity-id';
export { ValueObject } from './domain/entities/value-object';
export { BaseEntity, AggregateRoot } from './domain/entities/base-entity';
export {
  DomainEvent,
  type IDomainEvent,
  type IDomainEventHandler,
} from './domain/events/domain-event';
export { DomainError, type DomainErrorCode } from './domain/errors/domain-error';
export { Ensure, type EnsureApi } from './domain/guards/ensure';
export { Result, type ResultError } from './domain/results/result';
export { Email } from './domain/value-objects/email.vo';
export {
  Specification,
  PredicateSpecification,
} from './domain/ports/specification.port';
export type {
  IRepository,
  ISpecification,
  PaginationOptions,
  PaginatedResult,
  IEventSourcedRepository,
} from './domain/ports/repository.port';
export type { IUnitOfWork, IClock } from './domain/ports/unit-of-work.port';
export type {
  IDomainEventBus,
  IIntegrationEventPublisher,
  IIntegrationEventConsumer,
  ConsumeMetadata,
} from './domain/ports/event-bus.port';
export {
  SagaOrchestrator,
  SagaExecutionError,
  type ISaga,
  type ISagaStep,
} from './domain/ports/saga.port';