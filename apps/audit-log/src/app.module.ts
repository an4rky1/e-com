/**
 * @fileoverview Composition root for audit-log.
 *
 * @remarks Imports the service's module from `libs/` rather than declaring providers here.
 * Everything this service does is testable without booting Nest, because the composition root
 * contains no behaviour to test.
 */
import { ServiceNames } from '@auth/contracts';
import { Module } from '@nestjs/common';
import { PlatformConfigModule } from '@auth/platform/config';
import { ErrorHandlingModule } from '@auth/platform/error-handling';
import { HealthModule } from '@auth/platform/health';
import { ObservabilityModule } from '@auth/platform/observability';
import { createKafkaModule, createKafkaPublisher } from '@auth/infra/kafka';
import { ShutdownService } from '@auth/platform/shutdown';
import { createAuditLogModule } from '@auth/domains/audit-log';

/**
 * Outbox transport, built here because a module factory cannot receive it through DI.
 *
 * @remarks Composition lives in the app: it is the only layer allowed to know that events
 * leave this process over Kafka. The domain module sees nothing but the transport port, and
 * audit-log itself never calls it — the log is append-only and read by operators, so nothing
 * here acts on a security finding.
 */
const eventPublisher = createKafkaPublisher();

@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot(ServiceNames.AUDIT_LOG),
    ObservabilityModule.forRoot(ServiceNames.AUDIT_LOG),
    // Supplies the Kafka consumer the audit-log module exports but does not provide: the
    // module is consume-driven and takes its transport from here.
    createKafkaModule(),
    createAuditLogModule({ publisher: eventPublisher }),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}