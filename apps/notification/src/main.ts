/**
 * @fileoverview Process entry point for notification.
 *
 * @remarks Thin by design: wiring lives in `libs/domains/notification`. This file owns only
 * what is genuinely process-scoped — the HTTP port, the gRPC server, signal handling and
 * graceful shutdown order.
 */
import 'reflect-metadata';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();


  await app.startAllMicroservices();
  await app.listen(Number(process.env.PORT ?? 3009), '0.0.0.0');

  logger.log(`${process.env.SERVICE_NAME ?? 'notification'} listening on port ${process.env.PORT ?? 3009}`);
}

bootstrap().catch((error: unknown) => {
  // Logging and a non-zero exit, never a silent swallow: a service that dies during bootstrap
  // must be visibly dead to its orchestrator.
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', error);
  process.exit(1);
});
