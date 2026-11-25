/**
 * @fileoverview Process entry point for catalog.
 *
 * @remarks Thin by design: wiring lives in `libs/domains/catalog`. This file owns only
 * what is genuinely process-scoped — the HTTP port, the gRPC server, signal handling and
 * graceful shutdown order.
 */
import 'reflect-metadata';
import { ServiceNames } from '@auth/contracts';
import './tracing';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

const DEFAULT_PORT = 3011;
const BIND_HOST = '0.0.0.0';

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
        url: process.env.GRPC_URL ?? `${BIND_HOST}:13011`,
        package: 'catalog.v1',
        protoPath: path.resolve(__dirname, '../../../libs/contracts/proto/catalog.proto'),
      },
    },
    { inheritAppConfig: true },
  );

  await app.startAllMicroservices();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port, BIND_HOST);

  logger.log(`${process.env.SERVICE_NAME ?? ServiceNames.CATALOG} listening on port ${port}`);
}

bootstrap().catch((error: unknown) => {
  // Logging and a non-zero exit, never a silent swallow: a service that dies during bootstrap
  // must be visibly dead to its orchestrator.
  console.error('Bootstrap failed', error);
  process.exit(1);
});
