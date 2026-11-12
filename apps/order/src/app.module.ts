/**
 * @fileoverview Composition root for order.
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
import { createOrderModule } from '@shop/domains/order';
import { createKafkaPublisher } from '@auth/infra/kafka';

/**
 * Outbox transport, built here because a module factory cannot receive it through DI.
 *
 * @remarks Composition lives in the app: it is the only layer allowed to know that events
 * leave this process over Kafka. The domain module sees nothing but the transport port.
 */
const eventPublisher = createKafkaPublisher();
import { createStaticGrpcChannel } from '@auth/infra/grpc';
import path from 'node:path';

/**
 * Downstream channels for the peers this service calls over gRPC.
 *
 * @remarks One channel spans every peer package, because a channel built from a single
 * proto can only dispatch that package's methods — an orchestrator wired with one proto
 * works for its first dependency and fails on its second with an error that reads like a
 * missing method rather than a missing address.
 */
const PROTO_DIR = path.resolve(__dirname, '../../../libs/contracts/proto');

const peerChannel = createStaticGrpcChannel({
  protoPaths: [path.join(PROTO_DIR, 'cart.proto'), path.join(PROTO_DIR, 'inventory.proto'), path.join(PROTO_DIR, 'billing.proto')],
  url: process.env.CART_GRPC_URL ?? 'localhost:13012',
  addresses: {
    'cart.v1': process.env.CART_GRPC_URL ?? 'localhost:13012',
    'inventory.v1': process.env.INVENTORY_GRPC_URL ?? 'localhost:13013',
    'billing.v1': process.env.BILLING_GRPC_URL ?? 'localhost:13014',
  },
});


@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot('order'),
    ObservabilityModule.forRoot('order'),

    createOrderModule({publisher: eventPublisher, grpcChannel: peerChannel}),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
