/**
 * @fileoverview Composition root for auth-gateway.
 *
 * @remarks Imports the service's module from `libs/` rather than declaring providers here.
 * Everything this service does is testable without booting Nest, because the composition root
 * contains no behaviour to test.
 */
import { Module } from '@nestjs/common';
import { PlatformConfigModule } from '@auth/platform/config';
import { ErrorHandlingModule } from '@auth/platform/error-handling';
import { HealthModule } from '@auth/platform/health';

import { ShutdownService } from '@auth/platform/shutdown';
import { createAuthGatewayModule } from '@auth/domains/auth-gateway';
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
 * Downstream channel for the four peers this orchestrator calls.
 *
 * @remarks Built eagerly rather than through DI: `createAuthGatewayModule` is invoked inside an
 * `@Module` decorator, where no injection container exists yet. Keeping the construction here
 * means the library still only ever sees the `GrpcChannel` port.
 *
 * @remarks One channel spans four proto packages, each on its own host. A channel built from a
 * single proto can only dispatch that package's methods, so an orchestrator wired that way
 * works for its first dependency and fails on its second — with an error that reads like a
 * missing method rather than a missing address.
 */
const PROTO_DIR = path.resolve(__dirname, '../../../libs/contracts/proto');

const downstreamChannel = createStaticGrpcChannel({
  protoPaths: [
    path.join(PROTO_DIR, 'identity.proto'),
    path.join(PROTO_DIR, 'credential_vault.proto'),
    path.join(PROTO_DIR, 'session_token.proto'),
    path.join(PROTO_DIR, 'mfa.proto'),
    path.join(PROTO_DIR, 'account_security.proto'),
  ],
  url: process.env.IDENTITY_GRPC_URL ?? 'localhost:31001',
  addresses: {
    'identity.v1': process.env.IDENTITY_GRPC_URL ?? 'localhost:31001',
    'credential_vault.v1': process.env.CREDENTIAL_VAULT_GRPC_URL ?? 'localhost:31003',
    'session_token.v1': process.env.SESSION_TOKEN_GRPC_URL ?? 'localhost:31004',
    'mfa.v1': process.env.MFA_GRPC_URL ?? 'localhost:31006',
    // account-security owns the failure counters and the lock. The address is platform-owned,
    // like every other peer: this service reads it and nothing here decides it.
    'account_security.v1':
      process.env.ACCOUNT_SECURITY_GRPC_URL ?? 'localhost:31007',
  },
});

@Module({
  imports: [
    PlatformConfigModule,
    ErrorHandlingModule.forRoot(),
    HealthModule.forRoot('auth-gateway'),

    createAuthGatewayModule({ publisher: eventPublisher, grpcChannel: downstreamChannel }),
  ],
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class AppModule {}
