/**
 * @fileoverview HTTP transport for checkout.
 *
 * @remarks `POST /checkout/preview` is composed at the edge (cart lines + billing totals);
 * `POST /checkout` is a single `CreateOrder` — the order service's saga already sequences
 * cart → inventory → billing, so a second composition here would be a second owner of the
 * same walk.
 *
 * @remarks Idempotency belongs to order, not to this edge: the `Idempotency-Key` header is
 * copied into the RPC and never intercepted by `@Idempotent()`, because a gateway-level dedup
 * would answer 409 on a retry that order is designed to replay as the same order.
 */
import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { OrderView } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { CurrentPrincipal } from './decorators/current-principal.decorator';
import type { GatewayPrincipal } from '../application/ports/gateway-principal';
// Values on purpose — see the note in `auth.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CheckoutCreateDto, CheckoutPreviewDto } from './dto/storefront.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { StorefrontService } from '../application/facade/storefront.service';

@Controller('checkout')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class CheckoutController {
  constructor(private readonly storefront: StorefrontService) {}

  /**
   * What this basket would cost, and whether every line is still buyable.
   *
   * @remarks Invalid baskets still answer 200 with `validation.valid: false`: a shopper who
   * has to re-open the cart to learn *why* checkout failed is a shopper the UI cannot help.
   * The refusal is data, not an HTTP error.
   */
  @Post('preview')
  @HttpCode(200)
  preview(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Body() body: CheckoutPreviewDto,
  ) {
    return this.storefront.previewCheckout(principal, {
      customerCountry: body.customerCountry,
      couponCode: body.couponCode,
      currency: body.currency,
    });
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Body() body: CheckoutCreateDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderView> {
    return this.storefront.createCheckout(principal, {
      currency: body.currency,
      paymentMethodToken: body.paymentMethodToken,
      idempotencyKey,
    });
  }
}
