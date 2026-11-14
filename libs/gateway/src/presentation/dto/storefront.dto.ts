/**
 * @fileoverview Request bodies the storefront surface accepts.
 *
 * @remarks Value imports for every `@Body()` DTO — the same `emitDecoratorMetadata` rule as
 * `gateway.dto.ts`: a type-only binding reaches ValidationPipe as `Function` and the body is
 * stripped to `{}` instead of validated.
 */
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CURRENCY_LENGTH,
  PRODUCT_NAME_MAX_LENGTH,
  QUANTITY_MAX,
  REASON_MAX_LENGTH,
  SKU_MAX_LENGTH,
} from '@auth/contracts/http';
import type {
  AddCartItemRequest,
  CancelOrderRequest,
  CatalogCreateProductRequest,
  CatalogSetPriceRequest,
  CheckoutCreateRequest,
  CheckoutPreviewRequest,
  RemoveCartItemRequest,
  UpdateCartItemRequest,
} from '@auth/contracts/http';

/** Minor units as a string; digits only, so a float never enters the wire. */
const MINOR_UNITS = /^\d+$/;

export class ShopMoneyDto {
  @Matches(MINOR_UNITS, { message: 'amountMinor must be an integer of minor units' })
  @MaxLength(24)
  amountMinor!: string;

  @IsString()
  @MaxLength(CURRENCY_LENGTH)
  currency!: string;
}

export class CreateVariantDto {
  @IsString()
  @MaxLength(SKU_MAX_LENGTH)
  sku!: string;

  @ValidateNested()
  @Type(() => ShopMoneyDto)
  price!: ShopMoneyDto;

  @IsOptional()
  @IsObject()
  attrs?: Record<string, string>;
}

export class CatalogCreateProductDto implements CatalogCreateProductRequest {
  @IsString()
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  name!: string;

  @IsString()
  @MaxLength(4_000)
  description!: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  categoryPath!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants!: CreateVariantDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaKeys?: string[];
}

export class CatalogSetPriceDto implements CatalogSetPriceRequest {
  @IsString()
  @MaxLength(SKU_MAX_LENGTH)
  productId!: string;

  @IsString()
  @MaxLength(SKU_MAX_LENGTH)
  sku!: string;

  @ValidateNested()
  @Type(() => ShopMoneyDto)
  price!: ShopMoneyDto;
}

export class AddCartItemDto implements AddCartItemRequest {
  @IsString()
  @MaxLength(SKU_MAX_LENGTH)
  sku!: string;

  @IsInt()
  @Min(1)
  @Max(QUANTITY_MAX)
  quantity!: number;
}

export class UpdateCartItemDto implements UpdateCartItemRequest {
  @IsString()
  @MaxLength(SKU_MAX_LENGTH)
  sku!: string;

  @IsInt()
  @Min(1)
  @Max(QUANTITY_MAX)
  quantity!: number;
}

export class RemoveCartItemDto implements RemoveCartItemRequest {
  @IsString()
  @MaxLength(SKU_MAX_LENGTH)
  sku!: string;
}

export class CheckoutPreviewDto implements CheckoutPreviewRequest {
  @IsOptional()
  @IsString()
  @MaxLength(2)
  customerCountry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  couponCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CURRENCY_LENGTH)
  currency?: string;
}

export class CheckoutCreateDto implements CheckoutCreateRequest {
  @IsOptional()
  @IsString()
  @MaxLength(2)
  customerCountry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  couponCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(CURRENCY_LENGTH)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  paymentMethodToken?: string;
}

export class CancelOrderDto implements CancelOrderRequest {
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX_LENGTH)
  reason?: string;
}
