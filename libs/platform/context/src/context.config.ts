import { z } from 'zod';
import { envBoolean, envString, readNamespacedEnv } from '@auth/platform/config';

export const CONTEXT_CONFIG = Symbol('CONTEXT_CONFIG');

export const Defaults = {
  ENABLED: true,
  CORRELATION_ID_HEADER: 'x-correlation-id',
  REQUEST_ID_HEADER: 'x-request-id',
  /**
   * Mint a correlation id when the caller did not send one.
   *
   * @remarks A request with no id is a request nobody can follow through the logs, and
   * trusting the caller to always supply one means a caller that does not becomes invisible
   * precisely when they are doing something worth seeing. Off is for setups where an upstream
   * proxy already guarantees the header.
   */
  GENERATE_CORRELATION_ID: true,
} as const;

const schema = z.object({
  ENABLED: envBoolean(Defaults.ENABLED),
  CORRELATION_ID_HEADER: envString(Defaults.CORRELATION_ID_HEADER),
  REQUEST_ID_HEADER: envString(Defaults.REQUEST_ID_HEADER),
  GENERATE_CORRELATION_ID: envBoolean(Defaults.GENERATE_CORRELATION_ID),
});

export type ContextEnvConfig = z.infer<typeof schema>;

export interface ContextConfig {
  enabled: boolean;
  correlationIdHeader: string;
  requestIdHeader: string;
  generateCorrelationId: boolean;
}

/**
 * context's own configuration namespace.
 *
 * @remarks Header names are configurable rather than hardcoded because the correlation id
 * travels: an ingress that already stamps `x-request-id` and an internal caller that expects
 * `x-correlation-id` are two halves of the same wire, and a library that picks one half
 * cannot be deployed behind the other.
 */
export function resolveContextConfig(
  env: NodeJS.ProcessEnv = process.env,
): ContextConfig {
  const parsed = readNamespacedEnv('REQUEST_CONTEXT', schema, env);
  return {
    enabled: parsed.ENABLED,
    correlationIdHeader: parsed.CORRELATION_ID_HEADER,
    requestIdHeader: parsed.REQUEST_ID_HEADER,
    generateCorrelationId: parsed.GENERATE_CORRELATION_ID,
  };
}
