/**
 * @fileoverview Process entry point for the api-gateway.
 *
 * @remarks Thin by design: wiring lives in `libs/gateway`. This file owns only what is
 * genuinely process-scoped — the HTTP port and graceful shutdown order.
 *
 * @remarks **There is no `connectMicroservice` here, and that is the difference between this
 * and every other app in `apps/`.** The gateway is a client of gRPC, never a server: it has
 * no methods of its own, and opening a listener would make it look like a tenth service with
 * a contract nobody maintains.
 *
 * @remarks No `DATABASE_URL` is read, and none is required. `resolveGatewayConfig` has no such
 * key in its schema, so this process boots with no database in its environment at all — which
 * is what makes it an edge rather than a service with a thin API in front of its tables.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');

  logger.log(`${process.env.SERVICE_NAME ?? 'api-gateway'} listening on port ${port}`);
}

bootstrap().catch((error: unknown) => {
  // Logging and a non-zero exit, never a silent swallow: a service that dies during bootstrap
  // must be visibly dead to its orchestrator.
   
  console.error('Bootstrap failed', error);
  process.exit(1);
});
