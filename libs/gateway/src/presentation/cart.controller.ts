/**
 * @fileoverview HTTP transport for the shopper's cart.
 *
 * @remarks Every handler takes the principal and never a body identity: `userId` and
 * `sessionId` are claims on the bearer — or, for an anonymous browser, the validated
 * `X-Guest-Id` that `GuestIdentityGuard` turned into a session-only principal — and a body
 * field that could choose them would be a second authority next to the transport.
 *
 * @remarks The basket itself is reachable two ways on purpose: with a bearer (the ordinary
 * signed-in shopper) or with a guest id (the browser that has not signed in yet). The merge
 * route is the one moment both exist at once and is therefore bearer-only — folding *into*
 * an account is not something an anonymous caller may ask for.
 *
 * @remarks Mutations are POST (contract verb set), and the path carries the intent —
 * `/cart/items/update` rather than a PATCH, so the front's single `fetch` helper stays
 * honest without inventing a verb the contract does not have.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { GUEST_ID_HEADER, type CartView, type MergeCartResponse } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GuestIdentityGuard } from './guards/guest-identity.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { CurrentPrincipal } from './decorators/current-principal.decorator';
import { AllowGuest, Public } from './decorators/route-metadata';
import type { GatewayPrincipal } from '../application/ports/gateway-principal';
// Values on purpose — see the note in `auth.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AddCartItemDto,
  RemoveCartItemDto,
  UpdateCartItemDto,
} from './dto/storefront.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { StorefrontService } from '../application/facade/storefront.service';

@Controller('cart')
@UseGuards(RateLimitGuard, JwtAuthGuard, GuestIdentityGuard, PermissionsGuard)
export class CartController {
  constructor(private readonly storefront: StorefrontService) {}

  @Public()
  @AllowGuest()
  @Get()
  getCart(@CurrentPrincipal() principal: GatewayPrincipal): Promise<CartView> {
    return this.storefront.getCart(principal);
  }

  @Public()
  @AllowGuest()
  @Post('items')
  @HttpCode(200)
  addItem(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Body() body: AddCartItemDto,
  ): Promise<CartView> {
    return this.storefront.addItem(principal, {
      sku: body.sku,
      quantity: body.quantity,
    });
  }

  @Public()
  @AllowGuest()
  @Post('items/update')
  @HttpCode(200)
  updateItem(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Body() body: UpdateCartItemDto,
  ): Promise<CartView> {
    return this.storefront.updateItem(principal, {
      sku: body.sku,
      quantity: body.quantity,
    });
  }

  @Public()
  @AllowGuest()
  @Post('items/remove')
  @HttpCode(200)
  removeItem(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Body() body: RemoveCartItemDto,
  ): Promise<CartView> {
    return this.storefront.removeItem(principal, { sku: body.sku });
  }

  @Public()
  @AllowGuest()
  @Post('clear')
  @HttpCode(200)
  clearCart(@CurrentPrincipal() principal: GatewayPrincipal): Promise<CartView> {
    return this.storefront.clearCart(principal);
  }

  /**
   * Folds the guest basket this browser presented while anonymous into the caller's cart.
   *
   * @remarks Bearer-only, deliberately: the guest id names the *source*, the bearer names
   * the destination, and letting an anonymous caller pick the destination would make this
   * an import tool for somebody else's basket. The source comes from `X-Guest-Id` — the
   * header the whole guest surface already speaks — and an absent one is a 400 from the
   * cart service rather than a merge from nowhere.
   */
  @Post('merge')
  @HttpCode(200)
  mergeGuest(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Headers(GUEST_ID_HEADER) guestId?: string,
  ): Promise<MergeCartResponse> {
    return this.storefront.mergeGuestCart(principal, guestId ?? '');
  }
}
