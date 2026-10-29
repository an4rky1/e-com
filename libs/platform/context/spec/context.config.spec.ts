/**
 * @fileoverview `REQUEST_CONTEXT_*` parsing: ids are on by default, header names are a
 * deployment decision, and a typo'd boolean fails the boot.
 *
 * @remarks The contract an operator sees: an unset namespace means every request still gets
 * an id (an unset namespace must not mean untraceable requests), the two header names can be
 * moved to whatever the ingress already speaks, and `ENABLED=mabye` is refused at startup
 * instead of silently becoming `false` — `Boolean('false')` is `true`, which is why the
 * parser refuses rather than coerces.
 */
import { Defaults, resolveContextConfig } from '../src/context.config';

const resolve = (env: Record<string, string | undefined>) =>
  resolveContextConfig(env as NodeJS.ProcessEnv);

describe('REQUEST_CONTEXT config', () => {
  it('defaults to tracing everything with the conventional header names', () => {
    const config = resolve({});
    expect(config).toEqual({
      enabled: true,
      correlationIdHeader: 'x-correlation-id',
      requestIdHeader: 'x-request-id',
      generateCorrelationId: true,
    });
    expect(Defaults.ENABLED).toBe(true);
  });

  it('reads header names and switches from its own namespace only', () => {
    const config = resolve({
      REQUEST_CONTEXT_CORRELATION_ID_HEADER: 'x-request-id-2',
      REQUEST_CONTEXT_GENERATE_CORRELATION_ID: 'false',
      // Another namespace's variable must not leak in through the prefix scan.
      REQUEST_CONTEXTS_ENABLED: 'false',
      CORRELATION_ID_HEADER: 'x-ignored',
    });
    expect(config.correlationIdHeader).toBe('x-request-id-2');
    expect(config.generateCorrelationId).toBe(false);
    expect(config.requestIdHeader).toBe('x-request-id');
  });

  it('parses every truthy and falsy spelling the helpers accept', () => {
    expect(resolve({ REQUEST_CONTEXT_ENABLED: 'off' }).enabled).toBe(false);
    expect(resolve({ REQUEST_CONTEXT_ENABLED: '1' }).enabled).toBe(true);
    expect(resolve({ REQUEST_CONTEXT_ENABLED: 'no' }).enabled).toBe(false);
  });

  it('refuses a boolean that is neither, naming the variable', () => {
    expect(() => resolve({ REQUEST_CONTEXT_ENABLED: 'maybe' })).toThrow(
      /Expected a boolean/,
    );
  });
});
