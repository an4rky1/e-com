/**
 * @fileoverview Composition root for billing.
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

import { ShutdownService } from '@auth/platform/shutdown';
import { createBillingModule } from '@shop/domains/billing';
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
    HealthModule.forRoot(ServiceNames.BILLING),
    ObservabilityModule.forRoot(ServiceNames.BILLING),

    createBillingModule({publisher: eventPublisher}),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
