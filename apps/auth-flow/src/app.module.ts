/**
 * @fileoverview Composition root for auth-flow.
 *
 * @remarks Imports the service's module from `libs/` rather than declaring providers here.
 * Everything this service does is testable without booting Nest, because the composition root
 * contains no behaviour to test.
 */
import { GrpcPackages, resolvePeerAddresses, ServiceNames } from '@auth/contracts';
import { Module } from '@nestjs/common';
import { PlatformConfigModule } from '@auth/platform/config';
import { ErrorHandlingModule } from '@auth/platform/error-handling';
import { HealthModule } from '@auth/platform/health';
import { ObservabilityModule } from '@auth/platform/observability';

import { ShutdownService } from '@auth/platform/shutdown';
import { createAuthFlowModule } from '@auth/domains/auth-flow';
import { createKafkaPublisher } from '@auth/infra/kafka';

/**
 * Outbox transport, built here because a module factory cannot receive it through DI.
 *
 * @remarks Composition lives in the app: it is the only layer allowed to know that events
 * leave this process over Kafka. The domain module sees nothing but the transport port.
 */
const eventPublisher = createKafkaPublisher();
import { createStaticGrpcChannel, readServiceToken } from '@auth/infra/grpc';
import path from 'node:path';

/**
 * Downstream channel for the four peers this orchestrator calls.
 *
 * @remarks Built eagerly rather than through DI: `createAuthFlowModule` is invoked inside an
 * `@Module` decorator, where no injection container exists yet. Keeping the construction here
 * means the library still only ever sees the `GrpcChannel` port.
 *
 * @remarks One channel spans four proto packages, each on its own host. A channel built from a
 * single proto can only dispatch that package's methods, so an orchestrator wired that way
 * works for its first dependency and fails on its second — with an error that reads like a
 * missing method rather than a missing address.
 */
const PROTO_DIR = path.resolve(__dirname, '../../../libs/contracts/proto');

const downstreamAddresses = resolvePeerAddresses();

const downstreamChannel = createStaticGrpcChannel({
  protoPaths: [
    path.join(PROTO_DIR, 'identity.proto'),
    path.join(PROTO_DIR, 'credential_vault.proto'),
    path.join(PROTO_DIR, 'session.proto'),
    path.join(PROTO_DIR, 'mfa.proto'),
    path.join(PROTO_DIR, 'account_security.proto'),
  ],
  url: downstreamAddresses[GrpcPackages.IDENTITY],
  addresses: downstreamAddresses,
  // Every peer's guard rejects a call that presents nothing, so this service refuses to build
  // its channel without the shared secret — at composition time, not on the first call that
  // happens to reach a healthy peer.
  serviceToken: readServiceToken(),
});

@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot(ServiceNames.AUTH_FLOW),
    ObservabilityModule.forRoot(ServiceNames.AUTH_FLOW),

    createAuthFlowModule({ publisher: eventPublisher, grpcChannel: downstreamChannel }),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
