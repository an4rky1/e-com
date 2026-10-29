/**
 * @fileoverview The process's Prometheus registry: every metric this service exposes, on one
 * registry, labelled with the service it came from.
 *
 * @remarks A registry per process rather than the prom-client default global: unit tests build
 * several in one Jest worker, and a global registry turns the second `forRoot` into a duplicate
 * registration error. `setDefaultLabels` stamps `service` on every series without each metric
 * repeating it — with one registry per process the label is a constant of the process, not a
 * dimension anything can vary.
 *
 * @remarks Default (Node process) metrics are included: CPU, memory, event-loop lag and GC are
 * the first thing a dashboard asks for when a service is slow and no request metric has moved.
 */
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/** Injection token for the registry bundle. An interface cannot be a token — see module. */
export const OBSERVABILITY_METRICS = Symbol('OBSERVABILITY_METRICS');

/** Injection token for the service name stamped on every series. */
export const OBSERVABILITY_SERVICE_NAME = Symbol('OBSERVABILITY_SERVICE_NAME');

export interface AppMetrics {
  /** The registry the `/metrics` controller serialises. */
  readonly registry: Registry;
  /** Server-side request latency histogram — the one metric every RED/latency SLO uses. */
  readonly httpRequestDurationSeconds: Histogram<string>;
}

/**
 * Latency buckets, in seconds.
 *
 * @remarks The Prometheus baseline (prometheus/histogram defaults) plus a 10s tail: an auth edge
 * that p99's at 8s is a real incident, and a bucket ceiling at 5s would fold it into `+Inf`.
 */
export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

/**
 * Builds the registry and the metrics every service shares.
 *
 * @param serviceName - The `service` label: identity, api-gateway, … — same value the tracing
 * resource uses, so a trace and a metric panel describe the same process.
 */
export function createMetricsRegistry(serviceName: string): AppMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: registry });

  const httpRequestDurationSeconds = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'Latency of HTTP server requests, in seconds.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [...HTTP_DURATION_BUCKETS],
    registers: [registry],
  });

  return { registry, httpRequestDurationSeconds };
}
