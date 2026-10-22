/**
 * @fileoverview Guards against the DI-metadata trap that has no static-analysis escape.
 *
 * @remarks A class extending a `@Controller()`-decorated base must still declare its own
 * `@Controller()`. `emitDecoratorMetadata` does **not** inherit across class inheritance, so a
 * subclass with no decorator of its own gets no `design:paramtypes`, Nest constructs it with
 * zero arguments, and every injected dependency arrives `undefined`. The service boots
 * cleanly, serves `/health`, and fails on the first request — which is how two controllers
 * shipped in a state that no unit test could detect, because no unit test builds a container.
 *
 * @remarks This is the static half of the guard. The runtime half is `tools/boot-check.sh`,
 * which boots all ten services and reports any provider graph that does not resolve — that
 * covers the related trap of a constructor parameter whose type was imported with
 * `import type`, which cannot be checked reliably without a type checker.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

function readAll(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'spec') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) readAll(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const sources = readAll(join(ROOT, 'domains'));

describe('Nest controller metadata', () => {
  it('finds the sources it inspects', () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it('never extends GrpcControllerBase without its own @Controller()', () => {
    const offenders: string[] = [];

    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('extends GrpcControllerBase')) continue;

      // The decorator has to sit directly on the declaration, not merely somewhere in the
      // file — an unrelated `@Controller()` on another class satisfies nothing.
      const declared = new RegExp(
        `@Controller\\(\\)\\s*(?://[^\\n]*\\s*)*export class \\w+ extends GrpcControllerBase`,
      ).test(src);

      if (!declared) offenders.push(file.replace(`${ROOT}/`, ''));
    }

    expect(offenders).toEqual([]);
  });

  it('finds the controllers it is guarding', () => {
    // Without this, deleting every controller would make the test above pass vacuously.
    const subclasses = sources.filter((file) =>
      readFileSync(file, 'utf8').includes('extends GrpcControllerBase'),
    );
    expect(subclasses.length).toBeGreaterThanOrEqual(4);
  });
});
