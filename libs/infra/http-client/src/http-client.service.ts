import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HTTP_CLIENT_CONFIG, type HttpClientConfig } from './http-client.config';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class CircuitOpenError extends Error {
  constructor(url: string, resetMs: number) {
    super(`Circuit open for ${new URL(url).origin}; retrying in ${resetMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

export interface HttpRequestOptions {
  headers?: Record<string, string>;
  /** JSON body; mutually exclusive with `body`. */
  json?: unknown;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  /**
   * Opt-in for non-GET verbs. A retry is only safe when the server may have never seen
   * the request (a timeout) or explicitly refused it (429/503); anything else risks
   * charging a card twice.
   */
  idempotent?: boolean;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** Explicit "not processed" refusals: safe to retry even for a non-idempotent verb. */
const REFUSED_STATUSES = new Set([429, 503]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ERROR_BODY_SNIPPET_LENGTH = 512;

interface Breaker {
  failures: number;
  openedAt: number | null;
}

/**
 * The per-origin circuit breaker.
 *
 * @remarks The state lives in the process, not in Redis: a breaker that spans replicas
 * would need a consensus protocol to be worth the round-trips, while a local breaker still
 * stops a replica from burning its worker pool on a host that just went down — which is
 * the failure this component exists for. A half-open probe lets one request through after
 * the reset window; its outcome either re-closes the circuit or re-opens it.
 */
class OriginBreaker {
  private readonly states = new Map<string, Breaker>();

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  private state(origin: string): Breaker {
    let s = this.states.get(origin);
    if (!s) {
      s = { failures: 0, openedAt: null };
      this.states.set(origin, s);
    }
    return s;
  }

  check(origin: string): void {
    const s = this.state(origin);
    if (s.openedAt === null) return;
    if (Date.now() - s.openedAt >= this.resetMs) {
      // Half-open: allow a single probe by resetting the counter, keep the marker
      // cleared so a successful call below fully closes it.
      s.openedAt = null;
      s.failures = this.threshold - 1;
      return;
    }
    throw new CircuitOpenError(origin, this.resetMs - (Date.now() - s.openedAt));
  }

  success(origin: string): void {
    const s = this.state(origin);
    s.failures = 0;
    s.openedAt = null;
  }

  failure(origin: string): void {
    const s = this.state(origin);
    s.failures += 1;
    if (s.failures >= this.threshold) {
      s.openedAt = Date.now();
    }
  }
}

/** Outbound HTTP with timeouts, bounded retries, and a per-origin breaker. */
@Injectable()
export class HttpClientService {
  private readonly breaker: OriginBreaker;

  constructor(
    @Inject(HTTP_CLIENT_CONFIG) private readonly config: HttpClientConfig,
  ) {
    this.breaker = new OriginBreaker(config.breakerThreshold, config.breakerResetMs);
  }

  private async sendOnce<T>(method: string, url: string, options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.config.timeoutMs,
    );

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'x-request-id': randomUUID(),
          ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new HttpError(
          `HTTP ${response.status} from ${url}`,
          response.status,
          url,
          text.slice(0, ERROR_BODY_SNIPPET_LENGTH),
        );
      }

      const data = (text ? JSON.parse(text) : undefined) as T;
      return { status: response.status, data, headers: response.headers };
    } finally {
      clearTimeout(timeout);
    }
  }

  private sleep(ms: number): Promise<void> {
    // Full jitter: without it every replica that failed together retries together.
    return new Promise((resolve) => setTimeout(resolve, Math.random() * ms));
  }

  private mayRetry(method: string, error: unknown, options: HttpRequestOptions): boolean {
    const idempotent = SAFE_METHODS.has(method) || options.idempotent === true;
    if (error instanceof HttpError) {
      if (idempotent) return RETRYABLE_STATUS.has(error.status);
      // Non-idempotent verbs only on explicit "not processed" refusals. 502/504 mean an
      // upstream may already have acted, and re-acting is exactly the harm to avoid.
      return REFUSED_STATUSES.has(error.status);
    }
    // Network error or our own timeout: idempotent calls may re-send, others may not.
    return idempotent;
  }

  async request<T>(method: string, url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> {
    const origin = new URL(url).origin;
    this.breaker.check(origin);

    const retries = options.retries ?? this.config.retries;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        await this.sleep(this.config.retryBaseMs * 2 ** (attempt - 1));
      }
      try {
        const response = await this.sendOnce<T>(method, url, options);
        this.breaker.success(origin);
        return response;
      } catch (error) {
        lastError = error;
        if (!this.mayRetry(method, error, options) || attempt === retries) break;
      }
    }

    this.breaker.failure(origin);
    throw lastError;
  }

  get<T>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', url, options);
  }

  post<T>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('POST', url, options);
  }

  /** POST with a JSON body and an explicit retry opt-in. */
  postJson<T>(url: string, json: unknown, options: Omit<HttpRequestOptions, 'json'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>('POST', url, { ...options, json, idempotent: options.idempotent ?? false });
  }
}
