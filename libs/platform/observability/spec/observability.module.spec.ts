/**
 * @fileoverview The registry's contract: one `service` label on every series, the shared
 * latency histogram present, and the trace SDK's start gate behaving as documented.
 *
 * @remarks `NodeSDK` is mocked — a real SDK inside a Jest worker would patch `http` for every
 * other test in the same worker and point a batch exporter at a port nothing listens on. The
 * instrumentation list is asserted through the constructor arguments instead, which is where a
 * dropped instrumentation would show up.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  createMetricsRegistry,
  HTTP_DURATION_BUCKETS,
} from '../src/metrics.registry';
import { startTracing } from '../src/tracing';

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    shutdown: jest.fn(),
  })),
}));

const OTEL_ENV_KEYS = [
  'OTEL_SDK_DISABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
] as const;

describe('metrics registry', () => {
  it('stamps the service label on every series and keeps the shared histogram', async () => {
    const { registry, httpRequestDurationSeconds } =
      createMetricsRegistry('identity');

    expect(httpRequestDurationSeconds).toBeDefined();
    expect(HTTP_DURATION_BUCKETS).toContain(1);
    expect(registry.getSingleMetric('http_server_request_duration_seconds')).toBe(
      httpRequestDurationSeconds,
    );

    const scrape = await registry.metrics();
    // A default metric carries the label without naming it per metric: the registry applies it.
    expect(scrape).toContain('service="identity"');
    expect(registry.contentType).toContain('text/plain');
  });

  it('exposes the latency histogram under the documented name', async () => {
    const { registry, httpRequestDurationSeconds } =
      createMetricsRegistry('api-gateway');
    // An unobserved histogram serialises as HELP/TYPE only — prom-client draws no series for
    // buckets nobody has fallen into yet. One observation gives the scrape a line to find.
    httpRequestDurationSeconds.observe(
      { method: 'GET', route: '/probe', status_code: '200' },
      0.01,
    );

    const scrape = await registry.metrics();

    expect(scrape).toContain(
      'http_server_request_duration_seconds_bucket',
    );
  });
});

describe('startTracing', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of OTEL_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    jest.mocked(NodeSDK).mockClear();
    // The module-level gate is set by whichever test runs first; the disable gate is checked
    // before it, so the disabled assertions stay meaningful regardless of order.
  });

  afterEach(() => {
    for (const key of OTEL_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('refuses to start when the SDK is disabled, without constructing one', () => {
    process.env.OTEL_SDK_DISABLED = 'true';

    expect(startTracing('identity')).toBe(false);
    expect(NodeSDK).not.toHaveBeenCalled();
  });

  it('starts once with the service name and the full instrumentation list', () => {
    // Idempotency note: `started` is module-level, so this asserts first-start only when no
    // earlier test in this file enabled the SDK — the disabled test above cannot set it.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';

    const first = startTracing('identity');

    expect(first).toBe(true);
    expect(NodeSDK).toHaveBeenCalledTimes(1);
    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'identity',
        instrumentations: [expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything()],
      }),
    );

    expect(startTracing('identity')).toBe(false);
    expect(NodeSDK).toHaveBeenCalledTimes(1);
  });
});
