/**
 * @fileoverview The PSP webhook: the one unauthenticated write outside auth itself.
 *
 * @remarks The body is handed to billing as raw bytes together with the signature
 * header — this edge never parses it, never re-serialises it, and never decides whether
 * it is authentic. The signature is over the exact bytes the provider sent, so buffering
 * and re-emitting JSON would invalidate every legitimate delivery; and "is this a real
 * payment event" is a money question that belongs to the service that owns money.
 *
 * @remarks `@Public()` is load-bearing for the same reason it is on login: the guard
 * denies by default, and a signature — not a session — is what proves authenticity. There
 * is no principal to inject, and `PermissionsGuard` has nothing to ask access-control.
 *
 * @remarks The ack stays 202 whenever billing accepted the delivery (applied or
 * duplicate): a redelivery that changed nothing is still a delivery the provider should
 * stop retrying. A verification failure surfaces as the translated peer error, so the
 * provider sees 4xx and retries with backoff rather than believing the event landed.
 */
import { Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { PaymentWebhookAck } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Public } from './decorators/route-metadata';
// Value import on purpose — see the note in `auth.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { StorefrontService } from '../application/facade/storefront.service';

/** Header the provider signs under; forwarded to billing unread. */
const SIGNATURE_HEADER = 'x-psp-signature';

@Controller('webhooks')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class WebhooksController {
  constructor(private readonly storefront: StorefrontService) {}

  /**
   * Accepts a payment event and confirms receipt.
   *
   * @remarks `rawBody` is present because the host boots with `{ rawBody: true }`;
   * without it Nest's body parser has already consumed the stream and there would be
   * nothing left to verify a signature over. The empty-string fallback keeps a misconfigured
   * host from throwing a TypeError — billing then rejects the empty body on the HMAC.
   */
  @Public()
  @Post('payment')
  @HttpCode(202)
  async receivePayment(
    @Req() req: RawBodyRequest<Request>,
    @Headers(SIGNATURE_HEADER) signature?: string,
  ): Promise<PaymentWebhookAck> {
    const rawBody = req.rawBody?.toString('utf8') ?? '';

    await this.storefront.handlePaymentWebhook({
      rawBody,
      signature: signature ?? '',
    });

    return { received: true };
  }
}
