/**
 * @fileoverview Process entry point for auth-flow.
 *
 * @remarks Thin by design: wiring lives in `libs/domains/auth-flow`. This file owns only
 * what is genuinely process-scoped — the HTTP port, the gRPC server, signal handling and
 * graceful shutdown order.
 *
 * @remarks **The browser never reaches this port.** The only caller of `auth_flow.v1` is
 * `api-gateway`, which drives a flow with two calls and holds no state of its own; the HTTP
 * listener below exists for `/health` and nothing else. This process is where flow state
 * lives (the `auth_flow` database and its outbox), which is exactly why it sits behind the
 * edge rather than in front of it: the edge is stateless, the flow is not, and neither
 * property survives the two being the same process.
 */
import 'reflect-metadata';
import './tracing';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
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
        url: process.env.GRPC_URL ?? '0.0.0.0:13005',
        package: 'auth_flow.v1',
        protoPath: path.resolve(__dirname, '../../../libs/contracts/proto/auth_flow.proto'),
      },
    },
    { inheritAppConfig: true },
  );

  await app.startAllMicroservices();
  await app.listen(Number(process.env.PORT ?? 3005), '0.0.0.0');

  logger.log(`${process.env.SERVICE_NAME ?? 'auth-flow'} listening on port ${process.env.PORT ?? 3005}`);
}

bootstrap().catch((error: unknown) => {
  // Logging and a non-zero exit, never a silent swallow: a service that dies during bootstrap
  // must be visibly dead to its orchestrator.
   
  console.error('Bootstrap failed', error);
  process.exit(1);
});
