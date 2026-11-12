import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  WEBHOOKS_CONFIG,
  type IncomingWebhooksConfig,
} from './incoming-webhooks.config';

export class WebhookRejectedError extends Error {
  constructor(reason: string) {
    super(`Webhook rejected: ${reason}`);
    this.name = 'WebhookRejectedError';
  }
}

export class UnknownWebhookError extends Error {
  constructor(route: string) {
    super(`No handler registered for webhook route "${route}"`);
    this.name = 'UnknownWebhookError';
  }
}

export interface WebhookHandler {
  /**
   * Verifies authenticity and returns the sender's event id used for deduplication.
   *
   * @remarks The id must come from the *verified* payload — deduplicating on an
   * unverified body lets an attacker evict real events from the dedup window.
   */
  verify(rawBody: string, headers: Headers): string | Promise<string>;
  /** Applies the event. Runs at most once per event id while the dedup window holds. */
  handle(rawBody: string, headers: Headers): Promise<void>;
}

export interface DispatchResult {
  status: 'processed' | 'duplicate';
}

/**
 * Stripe-style signature header: `t=<unix-seconds>,v1=<hex-hmac>` (repeat `v1` for
 * rotation). The signed message is `${t}.${rawBody}` so the timestamp itself is covered
 * and replaying an old capture requires the same clock to still be inside tolerance.
 */
export function verifyHmacSignature(
  rawBody: string,
  headerValue: string | null,
  secret: string,
  toleranceSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): void {
  if (!headerValue) throw new WebhookRejectedError('missing signature header');

  const parts = new Map<string, string[]>();
  for (const pair of headerValue.split(',')) {
    const [key, value] = pair.split('=', 2);
    if (!key || !value) continue;
    const list = parts.get(key) ?? [];
    list.push(value);
    parts.set(key, list);
  }

  const timestamp = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!timestamp || signatures.length === 0) {
    throw new WebhookRejectedError('malformed signature header');
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) {
    throw new WebhookRejectedError('timestamp outside tolerance');
  }

  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  const matched = signatures.some((candidate) => {
    const provided = Buffer.from(candidate, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!matched) throw new WebhookRejectedError('signature mismatch');
}

/**
 * Inbound HTTP callbacks: verify, deduplicate, dispatch.
 *
 * @remarks Duplicate delivery is a protocol property, not an accident — every sender
 * retries until it sees a 2xx, so handlers must be idempotent *and* the framework must
 * short-circuit redeliveries before they reach business logic.
 */
@Injectable()
export class IncomingWebhooksService {
  private static readonly logger = new Logger(IncomingWebhooksService.name);
  private readonly handlers = new Map<string, WebhookHandler>();
  private readonly seen = new Map<string, number>();

  constructor(
    @Inject(WEBHOOKS_CONFIG) private readonly config: IncomingWebhooksConfig,
  ) {}

  register(route: string, handler: WebhookHandler): void {
    if (this.handlers.has(route)) {
      throw new Error(`Webhook route "${route}" is already registered`);
    }
    this.handlers.set(route, handler);
  }

  /**
   * A Stripe-shaped timestamp+HMAC check against `secret`, for handlers that sign with a
   * shared secret. Handlers with their own scheme (asymmetric, provider-specific) verify
   * inside `WebhookHandler.verify` instead.
   */
  verifySignature(rawBody: string, headers: Headers, secret: string, headerName = 'stripe-signature'): void {
    verifyHmacSignature(
      rawBody,
      headers.get(headerName),
      secret,
      this.config.toleranceSec,
    );
  }

  async dispatch(route: string, rawBody: string, headers: Headers): Promise<DispatchResult> {
    const handler = this.handlers.get(route);
    if (!handler) throw new UnknownWebhookError(route);

    const eventId = await handler.verify(rawBody, headers);

    if (this.isDuplicate(eventId)) {
      IncomingWebhooksService.logger.debug(`duplicate webhook ${eventId} on "${route}"`);
      return { status: 'duplicate' };
    }
    this.markSeen(eventId);

    await handler.handle(rawBody, headers);
    return { status: 'processed' };
  }

  private isDuplicate(eventId: string): boolean {
    this.sweep();
    const seenAt = this.seen.get(eventId);
    return seenAt !== undefined && Date.now() - seenAt < this.config.dedupTtlMs;
  }

  private markSeen(eventId: string): void {
    this.seen.set(eventId, Date.now());
    // Map preserves insertion order, so the oldest id is the first to evict.
    while (this.seen.size > this.config.dedupMax) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, seenAt] of this.seen) {
      if (now - seenAt >= this.config.dedupTtlMs) this.seen.delete(id);
    }
  }
}
