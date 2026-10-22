/**
 * @fileoverview Process entry point for identity.
 *
 * @remarks Thin by design: wiring lives in `libs/domains/identity`. This file owns only
 * what is genuinely process-scoped — the HTTP port, the gRPC server, signal handling and
 * graceful shutdown order.
 */
import 'reflect-metadata';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { loadServiceDefinition } from '@auth/infra/grpc';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();


  // gRPC joins the existing HTTP server rather than opening a second one: one process, one
  // port, two transports.
  app.connectMicroservice(
    {
      transport: Transport.GRPC,
      options: {
        url: process.env.GRPC_URL ?? '0.0.0.0:13001',
        package: 'identity.v1',
        protoPath: path.resolve(__dirname, '../../../libs/contracts/proto/identity.proto'),
      },
    },
    { inheritAppConfig: true },
  );

  await app.startAllMicroservices();
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');

  logger.log(`${process.env.SERVICE_NAME ?? 'identity'} listening on port ${process.env.PORT ?? 3001}`);
}

bootstrap().catch((error: unknown) => {
  // Logging and a non-zero exit, never a silent swallow: a service that dies during bootstrap
  // must be visibly dead to its orchestrator.
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', error);
  process.exit(1);
});
