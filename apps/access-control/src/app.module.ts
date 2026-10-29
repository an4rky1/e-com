/**
 * @fileoverview Composition root for access-control.
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

import { ShutdownService } from '@auth/platform/shutdown';
import { createAccessControlModule } from '@auth/domains/access-control';
import { createKafkaPublisher } from '@auth/infra/kafka';

/**
 * Outbox transport, built here because a module factory cannot receive it through DI.
 *
 * @remarks Composition lives in the app: it is the only layer allowed to know that events
 * leave this process over Kafka. The domain module sees nothing but the transport port.
 */
const eventPublisher = createKafkaPublisher();


@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot('access-control'),
    ObservabilityModule.forRoot('access-control'),

    createAccessControlModule({ publisher: eventPublisher }),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
