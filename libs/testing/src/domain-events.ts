/**
 * @fileoverview Reads a service's domain layer and reports which event types its aggregates
 * actually raise.
 *
 * Why a source scan rather than a list: the classification contract ("every domain event is
 * either an integration event or explicitly internal") is only worth as much as its check.
 * A hand-written expected list would have to be updated in two places when an event is
 * added, and the second update is exactly the one that gets skipped. The `super(...)` call is
 * where every event class in this codebase states its type, so the domain sources are the
 * single source of truth.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The slice of an `EventRegistry` this check reads; kept structural so types do not couple. */
export interface EventRegistryShape {
  readonly integration: Readonly<Record<string, unknown>>;
  readonly internal: readonly string[];
}

export interface EventRegistryCheck {
  /** Event types declared as literals but classified in neither list. */
  readonly unclassified: readonly string[];
  /**
   * Types assembled from a template (`security.${signal}`) whose static prefix has no
   * classified key — the dynamic counterpart of `unclassified`.
   */
  readonly uncoveredPrefixes: readonly string[];
  /** Keys present in both lists: a contradiction `classify()` would silently resolve. */
  readonly duplicated: readonly string[];
}

/**
 * Matches `super(<aggregateId>, <aggregateType>, <eventType>, ...)`.
 *
 * @remarks The third argument is the event type by convention in every aggregate file; the
 * first two are never quoted literals we care about, and value-object/aggregate base calls
 * pass identifiers rather than a quoted third argument, so they do not match at all.
 */
const SUPER_DECLARATION = /super\(\s*[^,()]+,\s*[^,()]+,\s*('[^']+'|`[^`]*`)/g;

/** Classifies nothing: reports what a registry must contain to be complete for `domainDir`. */
export function checkEventRegistry(
  registry: EventRegistryShape,
  domainDir: string,
): EventRegistryCheck {
  const classified = new Set<string>([
    ...Object.keys(registry.integration),
    ...registry.internal,
  ]);
  const unclassified = new Set<string>();
  const uncoveredPrefixes = new Set<string>();

  for (const source of sourcesIn(domainDir)) {
    for (const match of source.matchAll(SUPER_DECLARATION)) {
      const stated = match[1] ?? '';
      const type = unquote(stated);

      if (!stated.startsWith('`')) {
        if (!classified.has(type)) unclassified.add(type);
        continue;
      }

      const interpolation = type.indexOf('${');
      const prefix = interpolation === -1 ? type : type.slice(0, interpolation);
      const matches = [...classified].some((key) => key.startsWith(prefix));

      if (!matches) uncoveredPrefixes.add(prefix || type);
    }
  }

  return {
    unclassified: [...unclassified].sort(),
    uncoveredPrefixes: [...uncoveredPrefixes].sort(),
    duplicated: Object.keys(registry.integration)
      .filter((key) => registry.internal.includes(key))
      .sort(),
  };
}

function unquote(stated: string): string {
  return stated.startsWith("'") || stated.startsWith('`')
    ? stated.slice(1, -1)
    : stated;
}

function sourcesIn(dir: string): string[] {
  const sources: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      sources.push(...sourcesIn(path));
      continue;
    }

    if (!entry.name.endsWith('.ts')) continue;
    if (/\.spec\.ts$|\.test\.ts$/.test(entry.name)) continue;

    sources.push(readFileSync(path, 'utf8'));
  }

  return sources;
}
