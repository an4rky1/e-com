/**
 * @fileoverview Structural guard: a service that writes integration events must publish them.
 *
 * @remarks The failure this prevents is invisible to every other kind of test. A service
 * writes its `outbox_events` rows inside the business transaction — correct, and asserted
 * nowhere else — but if no relay is wired, nothing ever drains those rows to Kafka. The
 * service looks healthy, its unit tests pass, its outbox keeps filling up, and every consumer
 * downstream silently never hears from it.
 *
 * This ran for real: seven of nine services were in exactly that state.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Services that legitimately have no relay. */
const CONSUMER_ONLY = new Set(['notification']);

/** Services with no database of their own. */
const NO_DATABASE = new Set(['api-gateway']);

type ServiceReport = {
  service: string;
  writesEvents: boolean;
  hasRelay: boolean;
};

function readAll(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'spec') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) readAll(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function collect(): ServiceReport[] {
  const root = join(__dirname, '..', '..', 'domains');
  return readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .map((service) => {
      const files = readAll(join(root, service));
      const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');

      return {
        service,
        // A write is `outbox_events.create/createMany/upsert` or the outbox service port.
        writesEvents:
          /outbox_events\.(create|createMany|upsert)/.test(src) ||
          /OutboxService/.test(src),
        hasRelay: /createOutboxModule/.test(src),
      };
    })
    .filter((report) => !CONSUMER_ONLY.has(report.service))
    .filter((report) => !NO_DATABASE.has(report.service));
}

describe('outbox composition', () => {
  const reports = collect();

  it('finds the domain services it expects', () => {
    expect(reports.length).toBeGreaterThanOrEqual(8);
  });

  it.each(reports.map((r) => [r.service, r] as const))(
    '%s publishes the events it writes',
    (_name, report) => {
      if (!report.writesEvents) {
        // A service that writes nothing has nothing to publish; that is not this defect.
        return;
      }
      expect({
        service: report.service,
        hasRelay: report.hasRelay,
      }).toEqual({ service: report.service, hasRelay: true });
    },
  );

  it('binds the outbox repository to the service own Prisma client', () => {
    // A shared or second client commits independently, which removes the guarantee the whole
    // pattern exists for — and it type-checks perfectly well.
    for (const report of reports.filter((r) => r.writesEvents && r.hasRelay)) {
      const files = readAll(join(__dirname, '..', '..', 'domains', report.service));
      const moduleSrc = files.find((f) => f.endsWith('.module.ts'));
      expect(moduleSrc).toBeDefined();

      const src = readFileSync(moduleSrc as string, 'utf8');
      expect(
        /createOutboxModule\(\{\s*repository:/s.test(src),
      ).toBe(true);
    }
  });
});
