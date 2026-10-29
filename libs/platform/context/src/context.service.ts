/**
 * @fileoverview AsyncLocalStorage-backed request context: one correlation id and one request
 * id per request, available anywhere below the middleware that opened the context.
 *
 * @remarks The context is opened by {@link RequestContextMiddleware} before any guard runs and
 * closed by the response, not by the handler — a handler that answers in 5ms still owns its
 * connection for the whole round trip, and a guard that rejects is exactly the case whose
 * logs most need an id. Nothing heavyweight is stored: no body, no socket, no user object.
 * A context that outlives its request (background jobs resuming it through
 * {@link RequestContextService.runWithCurrentContext}) must not pin one.
 *
 * @remarks The correlation id the caller sent is echoed, not trusted: it is validated as
 * printable ASCII of a sane length before it is written to a response header or a log line,
 * because an id is a value that ends up in both.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { CONTEXT_CONFIG, type ContextConfig } from './context.config';
import type {
  ContextRequestLike,
  ContextResponseLike,
  RequestContext,
} from './context.types';

/**
 * An incoming id is replayed only if it is printable ASCII without spaces and short enough
 * to be a log line rather than a paragraph. Everything else — control characters, newlines,
 * kilobytes of padding — is replaced by a freshly minted uuid.
 */
const SAFE_ID = /^[\x21-\x7e]{1,128}$/;

/** Headers read as `string | string[] | undefined`; only the first value of a repeated header counts. */
function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

@Injectable()
export class RequestContextService {
  private readonly logger = new Logger(RequestContextService.name);
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  constructor(
    @Inject(CONTEXT_CONFIG) private readonly config: ContextConfig,
  ) {}

  /**
   * Runs `callback` inside a fresh context and wires that context to the response.
   *
   * @remarks This is the entry point, called by the middleware with `next` as the callback so
   * that everything the framework does afterwards — guards, pipes, interceptors, the handler,
   * the exception filter — happens inside `storage.run()`. Wrapping anything narrower loses
   * the context for precisely the layers that log the most.
   */
  runWithRequest<T>(
    req: ContextRequestLike,
    res: ContextResponseLike,
    callback: () => T,
  ): T {
    if (!this.config.enabled) {
      return callback();
    }

    const context = this.buildContext(req);

    // The param decorators read these off the request object: a `createParamDecorator` cannot
    // inject, and a static service locator would be a second source of truth for the same id.
    req.correlationId = context.correlationId;
    req.requestId = context.requestId;

    res.setHeader(this.config.correlationIdHeader, context.correlationId);
    res.setHeader(this.config.requestIdHeader, context.requestId);

    // `finish` for the normal path, `close` for a client that hung up: both mean the request
    // is over, and the guard makes the second a no-op rather than a race. Subscribing here
    // instead of in an interceptor keeps the module to two providers — the interceptor would
    // only re-enter this class to call the same finalizer.
    const finalize = (): void => this.finalize(context);
    res.on('finish', finalize);
    res.on('close', finalize);

    return this.storage.run(context, callback);
  }

  /**
   * Runs `callback` in the context that is already active, or reports that there is none.
   *
   * @remarks The honest `undefined` rather than a synthetic context: a job resumed without a
   * request is a job that genuinely has no correlation id, and inventing one would make two
   * unrelated jobs look like the same trace.
   */
  runWithCurrentContext<T>(callback: () => T): T | undefined {
    const context = this.storage.getStore();
    if (!context) {
      this.logger.warn(
        'runWithCurrentContext called outside a request; the callback runs without a context',
      );
      return undefined;
    }
    return this.storage.run(context, callback);
  }

  /** The whole context, or `undefined` outside a request. */
  getContext(): RequestContext | undefined {
    return this.storage.getStore();
  }

  getCorrelationId(): string | undefined {
    return this.storage.getStore()?.correlationId;
  }

  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }

  /** Stores a guard-owned value on the context. A no-op outside a request. */
  setMetadata(key: string, value: unknown): void {
    const context = this.storage.getStore();
    if (!context) return;
    context.metadata[key] = value;
  }

  getMetadata<T = unknown>(key: string): T | undefined {
    return this.storage.getStore()?.metadata[key] as T | undefined;
  }

  hasMetadata(key: string): boolean {
    const context = this.storage.getStore();
    if (!context) return false;
    return key in context.metadata;
  }

  deleteMetadata(key: string): void {
    const context = this.storage.getStore();
    if (!context) return;
    delete context.metadata[key];
  }

  private buildContext(req: ContextRequestLike): RequestContext {
    const inbound = readHeader(req.headers, this.config.correlationIdHeader);
    const safe = inbound !== undefined && SAFE_ID.test(inbound) ? inbound : undefined;

    const correlationId =
      safe ??
      (this.config.generateCorrelationId ? randomUUID() : 'unknown');
    const requestId = randomUUID();

    return {
      correlationId,
      requestId,
      timestamps: { start: Date.now() },
      metadata: {},
    };
  }

  private finalize(context: RequestContext): void {
    if (context.timestamps.end !== undefined) return;

    const now = Date.now();
    context.timestamps.end = now;
    context.timestamps.durationMs = now - context.timestamps.start;

    this.logger.debug(
      `[${context.correlationId}] completed in ${context.timestamps.durationMs}ms`,
    );
  }
}
