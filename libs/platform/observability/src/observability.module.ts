/**
 * @fileoverview Prometheus metrics for a service process: the `/metrics` endpoint and one
 * observation per HTTP request.
 *
 * @remarks The shape mirrors `HealthModule`: `forRoot(serviceName)` because the service name is
 * a compile-time fact of the composition root (the same string `HealthModule` receives), not
 * something a deployment injects. Config-only — a registry and a middleware have no dependency
 * that can be down.
 *
 * @remarks Mounts at `/` rather than a controller list so `/health`, a 404 and a request a
 * guard rejects are all measured — the same reasoning `RequestContextMiddleware` documents.
 */
import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsController } from './metrics.controller';
import {
  createMetricsRegistry,
  OBSERVABILITY_METRICS,
  OBSERVABILITY_SERVICE_NAME,
  type AppMetrics,
} from './metrics.registry';

@Module({})
export class ObservabilityModule implements NestModule {
  static forRoot(serviceName: string): DynamicModule {
    return {
      module: ObservabilityModule,
      controllers: [MetricsController],
      providers: [
        { provide: OBSERVABILITY_SERVICE_NAME, useValue: serviceName },
        {
          provide: OBSERVABILITY_METRICS,
          inject: [OBSERVABILITY_SERVICE_NAME],
          useFactory: (name: string): AppMetrics => createMetricsRegistry(name),
        },
      ],
      exports: [OBSERVABILITY_METRICS],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('/');
  }
}
