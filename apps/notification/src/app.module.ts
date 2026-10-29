/**
 * @fileoverview Composition root for notification.
 *
 * @remarks Imports the service's module from `libs/` rather than declaring providers here.
 * Everything this service does is testable without booting Nest, because the composition root
 * contains no behaviour to test.
 */
import { Module } from '@nestjs/common';
import { PlatformConfigModule } from '@auth/platform/config';
import { ErrorHandlingModule } from '@auth/platform/error-handling';
import { HealthModule } from '@auth/platform/health';
import { ObservabilityModule } from '@auth/platform/observability';
import { createKafkaModule } from '@auth/infra/kafka';
import { ShutdownService } from '@auth/platform/shutdown';
import { createNotificationModule } from '@auth/domains/notification';



@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot('notification'),
    ObservabilityModule.forRoot('notification'),
    // Supplies the Kafka consumer the notification module exports but does not
    // provide: the module is consumer-only and takes its transport from here.
    createKafkaModule(),
    createNotificationModule(),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
