import { z } from 'zod';
import {
  ENV_PREFIXES,
  envInt,
  envString,
  readNamespacedEnv,
} from '@auth/platform/config';

export const ELASTICSEARCH = Symbol('ELASTICSEARCH');
export const ELASTICSEARCH_CONFIG = Symbol('ELASTICSEARCH_CONFIG');

export const Defaults = {
  /**
   * The usual single-node dev/stack address; a deployment points the platform elsewhere
   * through ELASTICSEARCH_URL.
   */
  URL: 'http://localhost:9200',
  /** The index the platform writes product documents to. */
  INDEX: 'products',
  REQUEST_TIMEOUT_MS: 10_000,
} as const;

const schema = z.object({
  URL: envString(Defaults.URL),
  INDEX: envString(Defaults.INDEX),
  REQUEST_TIMEOUT_MS: envInt(Defaults.REQUEST_TIMEOUT_MS, { min: 100, max: 60_000 }),
});

export type ElasticsearchEnvConfig = z.infer<typeof schema>;

export interface ElasticsearchConfig {
  /** Where the search engine answers HTTP, e.g. `http://localhost:9200`. */
  url: string;
  /** Default index for searches that name none. */
  index: string;
  /** Per-request ceiling in milliseconds; searches stay bounded by it. */
  requestTimeoutMs: number;
}

/**
 * Reads the platform-wide Elasticsearch settings.
 *
 * @remarks `ELASTICSEARCH_URL` is platform-owned rather than per-module: a second owner
 * for the same variable is how two consumers end up pointing at different instances
 * after a rotation nobody coordinated.
 */
export function resolveElasticsearchConfig(
  env: NodeJS.ProcessEnv = process.env,
): ElasticsearchConfig {
  const parsed = readNamespacedEnv(ENV_PREFIXES.elasticsearch, schema, env);
  return {
    url: parsed.URL,
    index: parsed.INDEX,
    requestTimeoutMs: parsed.REQUEST_TIMEOUT_MS,
  };
}
