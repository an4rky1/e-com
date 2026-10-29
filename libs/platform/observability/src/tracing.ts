/**
 * @fileoverview Starts the OpenTelemetry trace SDK for this process.
 *
 * @remarks Called from each app's own `tracing.ts`, whose import is the first one in `main.ts`
 * — after `reflect-metadata`, before `app.module`. That order is the whole mechanism: the
 * instrumentations patch `http`, `@grpc/grpc-js`, `ioredis` and `kafkajs` as they are required,
 * so an SDK started after the composition root has loaded would trace nothing.
 *
 * @remarks Standard `OTEL_*` variables rather than the platform's namespaced scheme: the
 * exporter and the instrumentations read these names themselves, and a platform alias would
 * mean two spellings for one setting, only one of which the upstream code sees.
 *
 * @remarks Out of the box the exporter points at a local Jaeger (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * default `http://localhost:4318`). With no collector running the SDK still starts and batches
 * are dropped with a diagnostic — tracing must never be a reason a service does not boot, so
 * `OTEL_SDK_DISABLED=true` exists and nothing here throws.
 *
 * @remarks Not instrumented yet: Prisma (its client does not go through `pg`) and BullMQ (no
 * official instrumentation). Those spans need hand-written wrappers around the two call sites
 * and are deliberately left out of the first cut.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';

const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318';

let started = false;

/**
 * Boots the trace SDK once per process.
 *
 * @param serviceName - The `service.name` resource attribute: the same value the metrics
 * registry stamps on every series, so a trace and a dashboard panel name the same process.
 * @returns Whether this call started the SDK — false when it was already running or the SDK is
 * disabled. The return exists so the gate and the idempotency are testable without booting a
 * real exporter inside a unit test.
 */
export function startTracing(serviceName: string): boolean {
  if (started) {
    return false;
  }
  if (process.env.OTEL_SDK_DISABLED === 'true') {
    return false;
  }
  started = true;

  const endpoint = (
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT
  ).replace(/\/+$/, '');

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation(),
      new GrpcInstrumentation(),
      new ExpressInstrumentation(),
      new KafkaJsInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();

  // Best-effort flush of the last batch. Swallowed on purpose: this runs while the process is
  // already exiting, and a rejected shutdown promise there would be an unhandled rejection on
  // the way down — a dropped span beats a crash during signal handling.
  const flush = (): void => {
    void sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);

  return true;
}
