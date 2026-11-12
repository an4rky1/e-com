/**
 * @fileoverview HTTP transport for the public catalog.
 *
 * @remarks Reads are `@Public()`: the vitrina has to work before sign-in. The two admin
 * writes sit behind the class guards and declare no extra permission — the contract marks
 * them `authenticated: true`, and which role may create a product is access-control's data
 * to seed when admin tooling lands.
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
import type { CatalogListQuery, ProductList } from '@auth/contracts/http';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { Public } from './decorators/route-metadata';
// Values on purpose — see the note in `auth.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { CatalogCreateProductDto, CatalogSetPriceDto } from './dto/storefront.dto';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { StorefrontService } from '../application/facade/storefront.service';

@Controller('catalog')
@UseGuards(RateLimitGuard, JwtAuthGuard, PermissionsGuard)
export class CatalogController {
  constructor(private readonly storefront: StorefrontService) {}

  /**
   * Lists products, optionally under a category path.
   *
   * @remarks `categoryPath` is a comma-joined segment list (`shoes,boots`), because a
   * query string cannot carry repeated keys through every proxy the same way and the front
   * already joins them for `viaProxy`.
   */
  @Public()
  @Get()
  async list(
    @Query() query: CatalogListQuery,
  ): Promise<ProductList> {
    const categoryPath = (query.categoryPath ?? '')
      .split(',')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    const page = Number(query.page ?? 1);
    const pageSize = Number(query.pageSize ?? 20);

    return this.storefront.listProducts({
      categoryPath,
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
    });
  }

  @Public()
  @Get(':id')
  getProduct(@Param('id') id: string) {
    return this.storefront.getProduct(id);
  }

  @Post('admin/products')
  @HttpCode(201)
  createProduct(@Body() body: CatalogCreateProductDto) {
    return this.storefront.createProduct({
      name: body.name,
      description: body.description,
      categoryPath: body.categoryPath,
      variants: body.variants.map((variant) => ({
        sku: variant.sku,
        price: {
          amountMinor: variant.price.amountMinor,
          currency: variant.price.currency,
        },
        attrs: variant.attrs,
      })),
      mediaKeys: body.mediaKeys,
    });
  }

  @Post('admin/price')
  @HttpCode(200)
  setPrice(@Body() body: CatalogSetPriceDto) {
    return this.storefront.setVariantPrice({
      productId: body.productId,
      sku: body.sku,
      price: {
        amountMinor: body.price.amountMinor,
        currency: body.price.currency,
      },
    });
  }
}
