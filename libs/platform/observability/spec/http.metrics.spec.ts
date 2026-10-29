/**
 * @fileoverview The wiring contract: `ObservabilityModule.forRoot(…)` mounted the way every
 * app mounts it actually measures requests over Nest 11's real HTTP stack.
 *
 * @remarks The same reasoning as `context.http.spec`: a `configure()` mistake (a wildcard that
 * stopped matching, a path that never matches) fails silently in unit tests that call services
 * directly. This boots the module with a probe controller and asks the scrape three questions —
 * is a matched request measured with its route template, is an unmatched one measured at all,
 * and does every series carry the service label.
 */
import {
  Controller,
  type INestApplication,
  Get,
  Module,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { ObservabilityModule } from '../src/observability.module';

@Controller('probe')
class ProbeController {
  @Get()
  live(): { ok: boolean } {
    return { ok: true };
  }

  @Get(':id')
  byId(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [ObservabilityModule.forRoot('probe-service')],
  controllers: [ProbeController],
})
class ProbeHostModule {}

describe('http metrics over real HTTP', () => {
  let app: INestApplication;
  let base: string;
  let fetchRaw: (path: string) => Promise<{ status: number; body: string; contentType: string }>;

  const get = async (path: string): Promise<{ status: number; body: string; contentType: string }> => {
    const response = await fetch(`${base}${path}`);
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
    };
  };

  beforeAll(async () => {
    app = await NestFactory.create(ProbeHostModule, { logger: false });
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    fetchRaw = get;
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes the scrape endpoint in Prometheus format', async () => {
    const scrape = await fetchRaw('/metrics');

    expect(scrape.status).toBe(200);
    expect(scrape.contentType).toContain('text/plain');
    expect(scrape.body).toContain('process_cpu_user_seconds_total');
  });

  it('records a matched request under its route template and the service label', async () => {
    const before = await fetchRaw('/metrics');
    const matched = before.body.match(
      /http_server_request_duration_seconds_count\{[^}]*route="\/probe\/:id"[^}]*\}/,
    );

    const probe = await fetchRaw('/probe/42');
    expect(probe.status).toBe(200);

    const after = await fetchRaw('/metrics');
    const beforeCount = matched ? Number(matched[0].match(/_count\{[^}]*\} (\S+)/)?.[1] ?? '0') : 0;
    const series = after.body.match(
      /http_server_request_duration_seconds_count\{[^}]*route="\/probe\/:id"[^}]*\} (\S+)/,
    );

    expect(series).not.toBeNull();
    const afterCount = Number(series?.[1] ?? '0');
    expect(afterCount).toBeGreaterThan(beforeCount);
    expect(after.body).toContain('service="probe-service"');
    expect(after.body).toContain('status_code="200"');
  });

  it('records a request no route matched under the shared sentinel', async () => {
    const notFound = await fetchRaw('/nope');
    expect(notFound.status).toBe(404);

    const scrape = await fetchRaw('/metrics');
    expect(scrape.body).toContain('route="__unmatched__"');
    expect(scrape.body).toContain('status_code="404"');
  });

  it('labels every observation with the method the request used', async () => {
    const scrape = await fetchRaw('/metrics');
    expect(scrape.body).toContain('method="GET"');
  });
});
