/**
 * @fileoverview The PSP webhook: the one unauthenticated write outside auth itself.
 *
 * @remarks Acknowledged, not applied. Billing owns money movement and will gain a
 * `HandlePaymentWebhook` RPC that verifies the provider signature; until then this route
 * answers 202 so a test PSP (or a operator curling it) is not told 404 while the contract
 * already claims the path. Silently dropping the body would be worse: a real provider
 * retrying against a 404 has no signal that the endpoint exists and is not ready.
 *
 * @remarks `@Public()` is load-bearing for the same reason it is on login: the guard denies
 * by default, and a signature — not a session — is what will prove authenticity when the
 * receiver lands. There is no principal to inject.
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { PaymentWebhookAck } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Public } from './decorators/route-metadata';

@Controller('webhooks')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class WebhooksController {
  /**
   * Accepts a payment event and confirms receipt.
   *
   * @remarks The body is deliberately untyped beyond "an object": until billing verifies a
   * signature, parsing it into a domain shape would imply a trust this edge has not yet
   * established. An empty body is fine — the ack is about the HTTP contract, not the event.
   */
  @Public()
  @Post('payment')
  @HttpCode(202)
  receivePayment(@Body() body: unknown): PaymentWebhookAck {
    // `body` is accepted and deliberately not parsed — see the method note above.
    void body;
    return { received: true };
  }
}
