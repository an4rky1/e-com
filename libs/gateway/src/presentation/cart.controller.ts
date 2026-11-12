/**
 * @fileoverview HTTP transport for the shopper's cart.
 *
 * @remarks Every handler takes the principal and never a body identity: `userId` and
 * `sessionId` are claims on the bearer, and a body field that could choose them would be a
 * second authority next to the JWT.
 *
 * @remarks Mutations are POST (contract verb set), and the path carries the intent —
 * `/cart/items/update` rather than a PATCH, so the front's single `fetch` helper stays
 * honest without inventing a verb the contract does not have.
 */
import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { CartView } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { CurrentPrincipal } from './decorators/current-principal.decorator';
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
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class CartController {
  constructor(private readonly storefront: StorefrontService) {}

  @Get()
  getCart(@CurrentPrincipal() principal: GatewayPrincipal): Promise<CartView> {
    return this.storefront.getCart(principal);
  }

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

  @Post('items/remove')
  @HttpCode(200)
  removeItem(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Body() body: RemoveCartItemDto,
  ): Promise<CartView> {
    return this.storefront.removeItem(principal, { sku: body.sku });
  }

  @Post('clear')
  @HttpCode(200)
  clearCart(@CurrentPrincipal() principal: GatewayPrincipal): Promise<CartView> {
    return this.storefront.clearCart(principal);
  }
}
