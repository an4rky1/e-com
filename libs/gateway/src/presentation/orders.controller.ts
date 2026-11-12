/**
 * @fileoverview HTTP transport for a shopper's orders.
 *
 * @remarks Ownership is never a path or body field: `userId` comes from the principal, so
 * `/orders/:id` answers only for the caller the token names. A path that carried the owner
 * would be a second authority, and the forgotten check is the one that ships.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { OrderListQuery, OrderView } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { CurrentPrincipal } from './decorators/current-principal.decorator';
import type { GatewayPrincipal } from '../application/ports/gateway-principal';
// Values on purpose — see the note in `auth.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CancelOrderDto } from './dto/storefront.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { StorefrontService } from '../application/facade/storefront.service';

@Controller('orders')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class OrdersController {
  constructor(private readonly storefront: StorefrontService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Query() query: OrderListQuery,
  ) {
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 20);
    return this.storefront.listOrders(principal, {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
    });
  }

  @Get(':id')
  get(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Param('id') id: string,
  ): Promise<OrderView> {
    return this.storefront.getOrder(principal, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @CurrentPrincipal() principal: GatewayPrincipal,
    @Param('id') id: string,
    @Body() body: CancelOrderDto,
  ): Promise<OrderView> {
    return this.storefront.cancelOrder(principal, {
      orderId: id,
      reason: body.reason ?? 'cancelled by customer',
    });
  }
}
