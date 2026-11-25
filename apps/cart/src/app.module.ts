/**
 * @fileoverview Composition root for cart.
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
import { createCartModule } from '@shop/domains/cart';

import { RedisModule } from '@auth/infra/redis';
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
  protoPaths: [path.join(PROTO_DIR, 'catalog.proto')],
  url: process.env.CATALOG_GRPC_URL ?? 'localhost:13011',
  addresses: {
    'catalog.v1': process.env.CATALOG_GRPC_URL ?? 'localhost:13011',
  },
});

@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot(ServiceNames.CART),
    ObservabilityModule.forRoot(ServiceNames.CART),
    // The shared client the cart's store and its distributed lock ride on. Listed here
    // rather than inside the domain module so the composition root stays the only place that
    // knows which processes of this service have Redis.
    RedisModule.forRoot(),

    createCartModule({ grpcChannel: peerChannel }),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
