/**
 * @fileoverview The context's behaviour contract: opened before the request, echoed to the
 * caller, closed when the response is, and never leaking between requests.
 *
 * @remarks Doubles are structural on purpose — the service reads headers, stamps two fields,
 * subscribes to two events and calls `setHeader`, and a fake that satisfies exactly that is
 * also the documentation of what the service is allowed to touch.
 */
import { resolveContextConfig } from '../src/context.config';
import { RequestContextService } from '../src/context.service';
import type {
  ContextRequestLike,
  ContextResponseLike,
} from '../src/context.types';

interface FakeRequest extends ContextRequestLike {
  headers: Record<string, string | string[] | undefined>;
}

function fakeResponse() {
  const headers = new Map<string, string>();
  const listeners = new Map<string, Array<() => void>>();
  const res: ContextResponseLike & {
    headers: Map<string, string>;
    emit: (event: string) => void;
  } = {
    headers,
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    },
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    },
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
  return res;
}

const serviceWith = (env: Record<string, string | undefined> = {}) =>
  new RequestContextService(
    resolveContextConfig(env as NodeJS.ProcessEnv),
  );

describe('RequestContextService', () => {
  it('mints both ids, echoes them as headers and stamps them on the request', () => {
    const service = serviceWith();
    const req: FakeRequest = { headers: {} };
    const res = fakeResponse();

    service.runWithRequest(req, res, () => {
      expect(service.getCorrelationId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(service.getRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    });

    expect(res.headers.get('x-correlation-id')).toBe(req.correlationId);
    expect(res.headers.get('x-request-id')).toBe(req.requestId);
    expect(req.correlationId).toBeDefined();
  });

  it('replays a caller-supplied correlation id instead of inventing one', () => {
    const service = serviceWith();
    const req: FakeRequest = { headers: { 'x-correlation-id': 'trace-42' } };
    const res = fakeResponse();

    let seen: string | undefined;
    service.runWithRequest(req, res, () => {
      seen = service.getCorrelationId();
    });

    expect(seen).toBe('trace-42');
    expect(res.headers.get('x-correlation-id')).toBe('trace-42');
  });

  it('refuses an id that would inject into a header or a log line', () => {
    const service = serviceWith();
    const res = fakeResponse();

    const req: FakeRequest = {
      headers: { 'x-correlation-id': 'ok\r\nSet-Cookie: admin=1' },
    };
    service.runWithRequest(req, res, () => {
      expect(service.getCorrelationId()).not.toContain('\r');
      expect(service.getCorrelationId()).toMatch(/^[0-9a-f-]{36}$/);
    });

    expect(res.headers.get('x-correlation-id')).not.toContain('\r');
  });

  it('mints nothing when generation is off and the caller sent nothing', () => {
    const service = serviceWith({
      REQUEST_CONTEXT_GENERATE_CORRELATION_ID: 'false',
    });
    const req: FakeRequest = { headers: {} };

    service.runWithRequest(req, fakeResponse(), () => {
      expect(service.getCorrelationId()).toBe('unknown');
      expect(service.getRequestId()).toBeDefined();
    });
  });

  it('passes requests straight through when disabled', () => {
    const service = serviceWith({ REQUEST_CONTEXT_ENABLED: 'false' });
    const req: FakeRequest = { headers: {} };
    const res = fakeResponse();

    const result = service.runWithRequest(req, res, () => {
      expect(service.getContext()).toBeUndefined();
      return 'ran';
    });

    expect(result).toBe('ran');
    expect(res.headers.size).toBe(0);
    expect(req.correlationId).toBeUndefined();
  });

  it('sees the context inside the callback and nowhere after it', () => {
    const service = serviceWith();
    const req: FakeRequest = { headers: {} };

    service.runWithRequest(req, fakeResponse(), () => {
      expect(service.getContext()).toBeDefined();
    });
    expect(service.getContext()).toBeUndefined();
  });

  it('keeps two concurrent requests on their own ids', () => {
    const service = serviceWith();
    const seen: string[] = [];

    const run = (header: string): Promise<void> => {
      const req: FakeRequest = { headers: { 'x-correlation-id': header } };
      return new Promise<void>((resolve) => {
        service.runWithRequest(req, fakeResponse(), () => {
          setTimeout(() => {
            seen.push(service.getCorrelationId() ?? 'missing');
            resolve();
          }, 5);
        });
      });
    };

    return Promise.all([run('first'), run('second')]).then(() => {
      expect(seen).toEqual(['first', 'second']);
    });
  });

  it('propagates to a resumed callback, and says so when there is nothing to resume', () => {
    const service = serviceWith();
    const req: FakeRequest = { headers: {} };

    expect(service.runWithCurrentContext(() => 'nope')).toBeUndefined();

    service.runWithRequest(req, fakeResponse(), () => {
      const resumed = service.runWithCurrentContext(
        () => service.getCorrelationId(),
      );
      expect(resumed).toBe(req.correlationId);
    });
  });

  it('round-trips metadata inside the request and no-ops outside one', () => {
    const service = serviceWith();
    const req: FakeRequest = { headers: {} };

    service.setMetadata('roles', ['admin']);
    expect(service.getMetadata('roles')).toBeUndefined();
    expect(service.hasMetadata('roles')).toBe(false);

    service.runWithRequest(req, fakeResponse(), () => {
      service.setMetadata('roles', ['admin']);
      expect(service.getMetadata<string[]>('roles')).toEqual(['admin']);
      expect(service.hasMetadata('roles')).toBe(true);
      service.deleteMetadata('roles');
      expect(service.hasMetadata('roles')).toBe(false);
    });
  });

  it('records duration once the response finishes, and only once', () => {
    const service = serviceWith();
    const req: FakeRequest = { headers: {} };
    const res = fakeResponse();

    let context: ReturnType<RequestContextService['getContext']>;
    service.runWithRequest(req, res, () => {
      context = service.getContext();
    });

    const timestamps = context?.timestamps;
    expect(timestamps?.end).toBeUndefined();

    res.emit('finish');
    const firstEnd = timestamps?.end;
    expect(timestamps?.durationMs).toBeGreaterThanOrEqual(0);
    expect(firstEnd).toBeDefined();

    // `close` follows `finish` on a real socket; the second call must not rewrite history.
    res.emit('close');
    expect(timestamps?.end).toBe(firstEnd);
  });
});
