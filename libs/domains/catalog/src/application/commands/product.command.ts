/**
 * @fileoverview Commands for the product lifecycle, and the results they return.
 *
 * @remarks A command is an intent, not a DTO: it carries the caller's *decision*, while the
 * transport shape stays in the presentation layer. Keeping them apart means renaming a REST
 * field never reaches the domain.
 *
 * @remarks Classes, not interfaces. `CommandBus.execute` resolves a handler from
 * `command.constructor`, and `@CommandHandler` reads its metadata off the class it is given. A
 * plain object literal or a `@CommandHandler('Name')` string therefore cannot dispatch at
 * all — the latter throws at import, because `Reflect.hasOwnMetadata` rejects a non-object.
 */
import { Command } from '@nestjs/cqrs';
import type { Product } from '../../domain/product.aggregate';

/** The document as the caller will read it back, in integer minor units. */
export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly categoryPath: readonly string[];
  readonly variants: readonly {
    readonly sku: string;
    readonly priceMinor: number;
    readonly attrs: Record<string, string>;
    readonly active: boolean;
  }[];
  readonly mediaKeys: readonly string[];
  readonly currency: string;
  readonly active: boolean;
  readonly version: number;
  /** Lowest variant price, or `null` when the product somehow has no variants. */
  readonly priceRangeMin: number | null;
  readonly priceRangeMax: number | null;
}

/** One sku's price as the catalogue holds it right now. */
export interface PricedSkuView {
  readonly sku: string;
  readonly productId: string;
  readonly priceMinor: number;
  readonly currency: string;
  /** `false` when either the product or the variant has been withdrawn from sale. */
  readonly active: boolean;
}

export class CreateProductCommand extends Command<ProductView> {
  readonly commandId: string = globalThis.crypto.randomUUID();

  constructor(
    readonly name: string,
    readonly description: string,
    readonly categoryPath: readonly string[],
    readonly variants: readonly {
      readonly sku: string;
      readonly priceMinor: number;
      readonly attrs?: Record<string, string>;
    }[],
    readonly mediaKeys: readonly string[] = [],
    /** Falls back to `CATALOG_DEFAULT_CURRENCY` when absent. */
    readonly currency?: string,
  ) {
    super();
  }
}

export class SetVariantPriceCommand extends Command<ProductView> {
  readonly commandId: string = globalThis.crypto.randomUUID();

  constructor(
    readonly productId: string,
    readonly sku: string,
    /** Integer minor units. The gRPC wire carries a string; the presentation layer parses it. */
    readonly priceMinor: number,
  ) {
    super();
  }
}

export class ArchiveProductCommand extends Command<ProductView> {
  readonly commandId: string = globalThis.crypto.randomUUID();

  constructor(
    readonly productId: string,
    readonly reason = 'archived_by_operator',
  ) {
    super();
  }
}

/** Thin constructor, so the facade and the transports cannot disagree about the shape. */
export const toCreateProductCommand = (input: {
  name: string;
  description?: string;
  categoryPath?: readonly string[];
  variants: readonly {
    readonly sku: string;
    readonly priceMinor: number;
    readonly attrs?: Record<string, string>;
  }[];
  mediaKeys?: readonly string[];
  currency?: string;
}): CreateProductCommand =>
  new CreateProductCommand(
    input.name,
    input.description ?? '',
    input.categoryPath ?? [],
    input.variants,
    input.mediaKeys ?? [],
    input.currency,
  );

/**
 * Projects the aggregate onto the read model every command returns.
 *
 * @remarks One mapper rather than a hand-built literal per handler: the three write paths
 * answer with the same document, and a handler that assembled it itself would be the place
 * a field quietly goes missing from one of them.
 *
 * @remarks The price range is computed here rather than stored: it is a fact about the
 * variants as they stand, and a persisted range would be one more column to keep in step
 * with every reprice.
 */
export const toProductView = (product: Product): ProductView => {
  const range = product.priceRange;

  return {
    id: product.id,
    name: product.name,
    description: product.description,
    categoryPath: [...product.categoryPath],
    variants: product.variants.map((variant) => ({
      sku: variant.sku,
      priceMinor: variant.priceMinor,
      attrs: { ...variant.attrs },
      active: variant.active,
    })),
    mediaKeys: [...product.mediaKeys],
    currency: product.currency,
    active: product.isActive,
    version: product.version,
    priceRangeMin: range?.min ?? null,
    priceRangeMax: range?.max ?? null,
  };
};
