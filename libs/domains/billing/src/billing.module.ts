/**
 * @fileoverview Nest wiring for the billing service.
 *
 * @remarks A factory rather than a static `@Module`, so the configuration is resolved when
 * the module is built rather than when its metadata is evaluated at import time — a module
 * that reads the environment during `import` cannot be tested, and cannot be told which
 * environment it is in.
 *
 * @remarks Every provider is bound through a `Symbol` token declared by a port, so the
 * application layer never names a class from `infrastructure/`. The wiring is the only
 * place that knows a Prisma client is the implementation of the port the aggregates were
 * written against, and the only place that knows which PSP adapter `BILLING_PSP_PROVIDER`
 * selects.
 *
 * @remarks The outbox is wired here rather than left to the host. `OutboxModule` is
 * global, and a global module cannot see a provider declared by the module that imports
 * it — so an outbox repository supplied "from outside" is never injected, and the relay
 * fails to bind to *this* service's tables.
 *
 * @remarks `BillingGrpcController` is registered here but attached in the app's
 * bootstrap with `connectMicroservice`: a microservice has to join an existing HTTP server
 * rather than open its own.
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { PrismaService } from '@auth/infra/prisma';
import {
  createOutboxModule,
  PrismaOutboxRepository,
  type EventPublisher,
} from '@auth/infra/outbox';
import { PrismaClient } from './generated/prisma/client';
import { ChargeOrderHandler } from './application/commands/charge-order.handler';
import { RefundOrderHandler } from './application/commands/refund-order.handler';
import { GetInvoiceHandler, PreviewTotalsHandler } from './application/queries/billing.queries';
import { BillingService } from './application/facade/billing.service';
import { BILLING_REPOSITORY } from './domain/ports/billing-repository.port';
import { PAYMENT_PROVIDER } from './domain/ports/payment-provider.port';
import { PrismaBillingRepository } from './infrastructure/persistence/prisma-billing.repository';
import { createPaymentProvider } from './infrastructure/payment/fake-payment.provider';
import { BillingGrpcController } from './presentation/grpc/billing.grpc.controller';
import { BillingHealthIndicator } from './billing.health';
import { BILLING_CONFIG, BILLING_PRISMA, resolveBillingConfig } from './billing.config';

/** DI token carrying the factory's options. */
export const BILLING_MODULE_OPTIONS = Symbol('BILLING_MODULE_OPTIONS');

@Module({})
export class BillingModule {}

export interface BillingModuleOptions {
  /** Transport the outbox publishes through; supplied by the app, which owns process wiring. */
  publisher: EventPublisher;
}

/**
 * Assembles the billing service.
 *
 * @remarks One Prisma client is shared by the repository and the outbox. A second client
 * would open a second connection and commit independently, which is exactly what the
 * outbox exists to prevent.
 */
export function createBillingModule(options: BillingModuleOptions): DynamicModule {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Refusing to boot beats a wrong default: this client must never be able to point at
    // another service's database.
    throw new Error('DATABASE_URL is required by the billing module');
  }

  // Resolved once, before anything is constructed: an unknown PSP provider or an
  // unparseable tax table must fail here, not on the first charge that reads it.
  const config = resolveBillingConfig();

  const prisma = new PrismaService(new PrismaClient({ datasourceUrl: databaseUrl }));
  const outboxRepository = new PrismaOutboxRepository(prisma);

  return {
    module: BillingModule,
    imports: [
      CqrsModule.forRoot(),
      createOutboxModule({
        repository: outboxRepository,
        publisher: options.publisher,
      }),
    ],
    controllers: [BillingGrpcController],
    providers: [
      { provide: BILLING_PRISMA, useValue: prisma },
      { provide: BILLING_CONFIG, useValue: config },
      { provide: BILLING_REPOSITORY, useClass: PrismaBillingRepository },
      { provide: PAYMENT_PROVIDER, useValue: createPaymentProvider(config.pspProvider) },
      { provide: BILLING_MODULE_OPTIONS, useValue: options },

      ChargeOrderHandler,
      RefundOrderHandler,
      GetInvoiceHandler,
      PreviewTotalsHandler,

      BillingService,
      BillingHealthIndicator,
    ],
    // The gRPC controller is deliberately not exported: it is attached to the microservice
    // by the app's bootstrap, not injected by a consumer.
    exports: [
      BillingService,
      BillingHealthIndicator,
      BILLING_REPOSITORY,
      BILLING_MODULE_OPTIONS,
    ],
  };
}
