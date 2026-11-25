/**
 * @fileoverview Process entry point for api-key.
 *
 * @remarks Thin by design: wiring lives in `libs/domains/api-key`. This file owns only
 * what is genuinely process-scoped — the HTTP port, the gRPC server, signal handling and
 * graceful shutdown order.
 */
import 'reflect-metadata';
import { ServiceNames } from '@auth/contracts';
import './tracing';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const DEFAULT_PORT = 3007;
const BIND_HOST = '0.0.0.0';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  await app.startAllMicroservices();
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port, BIND_HOST);

  logger.log(`${process.env.SERVICE_NAME ?? ServiceNames.API_KEY} listening on port ${port}`);
}

bootstrap().catch((error: unknown) => {
  // Logging and a non-zero exit, never a silent swallow: a service that dies during bootstrap
  // must be visibly dead to its orchestrator.

  console.error('Bootstrap failed', error);
  process.exit(1);
});
