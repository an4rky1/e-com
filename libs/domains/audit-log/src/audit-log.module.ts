/**
 * @fileoverview Nest wiring for the audit-log service.
 *
 * @remarks A factory rather than a static `@Module`, for the same reason as its siblings: the
 * partition strategy, page ceiling and claim TTL come from `AUDIT_*`, and a module whose
 * metadata is evaluated at import time reads the environment before `ConfigModule` has loaded
 * it.
 *
 * @remarks This service *consumes* more than it produces. It has no gRPC surface at all: an
 * audit record is a fact another service announced, so there is nothing for a synchronous
 * caller to ask. Exporting a gRPC controller here would be rejected by Nest anyway — a
 * `@Controller()` with no verb contributes no route, and registering it in an HTTP application
 * is a no-op at best.
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import {
  AUDIT_LOG_CONFIG,
  AUDIT_LOG_PRISMA,
  resolveAuditLogConfig,
  type AuditLogConfig,
} from './audit-log.config';
import { RecordAuditEventHandler } from './application/commands/record-audit-event.handler';
import {
  SearchAuditEventsHandler,
  VerifyAuditChainHandler,
} from './application/queries/audit.queries';
import { AuditEventProcessor } from './application/consumers/audit-event.processor';
import { CommandBusAuditRecorder, AUDIT_RECORDER } from './application/ports/audit-recorder.port';
import { AuditLogService } from './application/facade/audit-log.service';
import {
  AUDIT_REPOSITORY,
  type AuditRepositoryPort,
} from './domain/ports/audit-repository.port';
import { IDEMPOTENCY_STORE } from './domain/ports/idempotency-store.port';
import { PrismaAuditRepository } from './infrastructure/persistence/prisma-audit.repository';
import { PrismaIdempotencyStore } from './infrastructure/persistence/prisma-idempotency.store';
import { AuditKafkaConsumer } from './infrastructure/messaging/audit.kafka.consumer';
import { AuditLogHealthIndicator } from './audit-log.health';
import { AuditController } from './presentation/audit.controller';

@Module({})
export class AuditLogModule {}

export interface AuditLogModuleOptions {
  /**
   * Transport the outbox publishes through.
   *
   * @remarks Supplied by the app because a module factory runs inside an `@Module` decorator,
   * where no injection container exists yet to hand over a Kafka producer. The domain layer
   * still only ever sees the {@link EventPublisher} port.
   *
   * @remarks Audit-log itself publishes nothing — it is append-only and read by operators, and
   * a record becoming an integration event would mean something downstream could react to a
   * security finding. The outbox pair is composed identically to every sibling service anyway:
   * the tables are part of this schema's contract, and `createOutboxModule` is what binds them
   * to *this* service's client rather than a shared one.
   */
  publisher: EventPublisher;
}

/**
 * Assembles the audit-log service.
 *
 * @remarks The provider graph is one chain, readable top to bottom: config -> adapters -> ports
 * -> handlers -> facade. Every port is bound to a `Symbol` from the port's own file, so the
 * application layer never names a class from `infrastructure/` and swapping the store for a
 * plain object is a one-line change here.
 *
 * @remarks One Prisma client is constructed here and shared by the repository, the idempotency
 * store and the outbox. That sharing is what makes "claim, append, advance the head" one
 * transaction rather than three — a second client would open a second connection and commit
 * independently, which is exactly the gap the chain cannot tolerate.
 */
export function createAuditLogModule(options: AuditLogModuleOptions): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: this client must never be able to point at
    // another service's database and read another service's chain.
    throw new Error('DATABASE_URL is required by the audit-log module');
  }

  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  const configProvider: Provider = {
    provide: AUDIT_LOG_CONFIG,
    useFactory: (): AuditLogConfig => resolveAuditLogConfig(),
  };

  return {
    module: AuditLogModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({ repository: outboxRepository, publisher: options.publisher }),
    ],
    controllers: [AuditController],
    providers: [
      { provide: AUDIT_LOG_PRISMA, useValue: prisma },
      configProvider,

      { provide: AUDIT_REPOSITORY, useClass: PrismaAuditRepository },
      { provide: IDEMPOTENCY_STORE, useClass: PrismaIdempotencyStore },
      // `useClass`, not `useFactory`: the recorder's constructor already names its own
      // dependency with `@Inject`, so restating it here would be a second list to keep in step.
      { provide: AUDIT_RECORDER, useClass: CommandBusAuditRecorder },

      RecordAuditEventHandler,
      SearchAuditEventsHandler,
      VerifyAuditChainHandler,
      AuditEventProcessor,
      AuditKafkaConsumer,
      AuditLogService,
      // `AuditRepositoryPort` is an interface, so it has no runtime token for Nest to find.
      // A bare `useClass` would leave the indicator's `audit` undefined and the health probe
      // reporting `up` for a log it never read. The factory names the token explicitly.
      {
        provide: AuditLogHealthIndicator,
        inject: [AUDIT_REPOSITORY],
        useFactory: (audit: AuditRepositoryPort) => new AuditLogHealthIndicator(audit),
      },
    ],
    exports: [AuditLogService, AuditEventProcessor, AuditKafkaConsumer, AuditLogHealthIndicator],
  };
}