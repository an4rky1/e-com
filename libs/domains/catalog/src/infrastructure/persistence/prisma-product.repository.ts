import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import type { Prisma, PrismaClient, products, product_variants } from '../../generated/prisma/client';
import { Product, toAttrs } from '../../domain/product.aggregate';
import type { ProductRow, ProductVariantRow } from '../../domain/product.aggregate';
import {
  PRODUCT_REPOSITORY,
  type ProductRepositoryPort,
  type ProductSpecification,
} from '../../domain/ports/product-repository.port';
import { CATALOG_PRISMA } from '../../catalog.config';
import { enqueueEvents } from './outbox-enqueue';

/**
 * The `product.*` -> `platform.product.*.v1` mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one place means adding an event cannot invent a topic
 * name no consumer subscribes to.
 *
 * @remarks `product.created` carries the skus and never a price: a price is already wrong by
 * the time a consumer reads it, and every consumer that needs one asks the cart, which is the
 * only party that knows what it actually charged.
 */
const PRODUCT_TOPICS: Readonly<Record<string, string>> = {
  'product.created': Topics.PRODUCT_CREATED,
  'product.price_changed': Topics.PRODUCT_PRICE_CHANGED,
  'product.archived': Topics.PRODUCT_ARCHIVED,
};

/** A product row with the variants the `include` brings back alongside it. */
type ProductWithVariants = products & { product_variants: product_variants[] };

@Injectable()
export class PrismaProductRepository implements ProductRepositoryPort {
  private readonly logger = new Logger(PrismaProductRepository.name);

  constructor(
    @Inject(CATALOG_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  /**
   * Writes the product, every variant and its events atomically.
   *
   * @remarks The whole document is written, not the columns that moved. The aggregate knows
   * its own variants but not which of them a previous read already saw, so a partial update
   * would have to diff against the database — one extra read per save to save a handful of
   * row writes, and a stale diff would silently drop a variant.
   */
  async save(product: Product): Promise<void> {
    await this.saveMany([product]);
  }

  /**
   * Writes several products and their events in one transaction.
   *
   * @remarks Drained *before* the transaction opens: an event buffer that survived a rollback
   * would be written by the next save and attributed to a different product.
   */
  async saveMany(productsToSave: readonly Product[]): Promise<void> {
    if (productsToSave.length === 0) return;

    const drained = productsToSave.map((product) => ({
      product,
      events: product.clearDomainEvents(),
    }));

    await this.prisma.runInTransaction(async (client) => {
      for (const { product } of drained) {
        const rows = product.toRow();

        await client.products.upsert({
          where: { id: rows.product.id },
          create: toProductCreate(rows.product),
          update: toProductUpdate(rows.product),
        });

        for (const variant of rows.variants) {
          await client.product_variants.upsert({
            where: { id: variant.id },
            create: toVariantCreate(variant, product.createdAt),
            update: toVariantUpdate(variant, product.updatedAt),
          });
        }
      }

      for (const { events } of drained) {
        await enqueueEvents(events, {
          client,
          logger: this.logger,
          topics: PRODUCT_TOPICS,
        });
      }
    });
  }

  async findById(id: string): Promise<Product | null> {
    const row = await this.prisma.tx.products.findUnique({
      where: { id },
      include: { product_variants: true },
    });
    return row ? hydrate(row) : null;
  }

  async existsBySku(sku: string): Promise<boolean> {
    // A `COUNT` over the unique index rather than a full row read: this is the probe every
    // create and every import runs before it is allowed to fail with a 409.
    const count = await this.prisma.tx.product_variants.count({ where: { sku } });
    return count > 0;
  }

  async findManyBySkus(skus: readonly string[]): Promise<Product[]> {
    if (skus.length === 0) return [];

    const rows = await this.prisma.tx.products.findMany({
      where: { product_variants: { some: { sku: { in: [...skus] } } } },
      include: { product_variants: true },
    });
    return rows.map(hydrate);
  }

  async findManyByCategory(categoryPath: readonly string[]): Promise<Product[]> {
    const rows = await this.prisma.tx.products.findMany({
      // An empty path means "every category". `hasEvery: []` happens to be true in Postgres
      // too, but spelling it as no filter keeps the generated query free of an `ARRAY[]`
      // constant whose semantics would then be part of this code's contract.
      where:
        categoryPath.length > 0
          ? { category_path: { hasEvery: [...categoryPath] } }
          : undefined,
      include: { product_variants: true },
    });
    return rows.map(hydrate);
  }

  async find(spec: ProductSpecification): Promise<Product[]> {
    const rows = await this.prisma.tx.products.findMany({
      include: { product_variants: true },
    });
    return rows.map(hydrate).filter((product) => spec.isSatisfiedBy(product));
  }

  async count(spec: ProductSpecification): Promise<number> {
    // Evaluated against the aggregate so the domain's predicate stays the single definition
    // of "matches" — a second, SQL-side implementation would drift from it.
    return (await this.find(spec)).length;
  }
}

/** Rehydrates the document and its variants, coercing the JSON column on the way in. */
function hydrate(row: ProductWithVariants): Product {
  return Product.fromRow(row, row.product_variants.map(toVariantRow));
}

/**
 * Prisma's `attrs` is `Prisma.JsonValue`; the aggregate's is `Record<string, string>`.
 *
 * @remarks The coercion lives in the aggregate (`toAttrs`) because it is the aggregate's
 * promise about what an attribute *is*. This mapping only carries the promise across the
 * column boundary — and it is why `Product.fromRow` never receives a raw Prisma row.
 */
function toVariantRow(variant: product_variants): ProductVariantRow {
  return {
    id: variant.id,
    product_id: variant.product_id,
    sku: variant.sku,
    price_minor: variant.price_minor,
    attrs: toAttrs(variant.attrs),
    active: variant.active,
  };
}

function toProductCreate(row: ProductRow): Prisma.productsUncheckedCreateInput {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category_path: [...row.category_path],
    media_keys: [...row.media_keys],
    currency: row.currency,
    active: row.active,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The same row minus the columns an update may not touch.
 *
 * @remarks `id` and `created_at` are immutable: a product does not get a new identity, and
 * rewriting its creation time would break the `(category_path, created_at)` ordering the
 * storefront browses. `version` *does* move — it is the aggregate's event counter mirrored
 * into a column, so a reader can order a product's history without reading the outbox.
 */
function toProductUpdate(row: ProductRow): Prisma.productsUncheckedUpdateInput {
  return {
    name: row.name,
    description: row.description,
    category_path: [...row.category_path],
    media_keys: [...row.media_keys],
    currency: row.currency,
    active: row.active,
    version: row.version,
    updated_at: row.updated_at,
  };
}

/**
 * @remarks `created_at`/`updated_at` are stamped from the product rather than defaulted by
 * the database: a document is one thing, and every row in it should say when the document
 * was minted instead of when each variant happened to be inserted.
 */
function toVariantCreate(
  row: ProductVariantRow,
  stamped: Date,
): Prisma.product_variantsUncheckedCreateInput {
  return {
    id: row.id,
    product_id: row.product_id,
    sku: row.sku,
    price_minor: row.price_minor,
    attrs: row.attrs,
    active: row.active,
    created_at: stamped,
    updated_at: stamped,
  };
}

/**
 * @remarks Stamped with the *product's* `updated_at` rather than a fresh clock: the aggregate
 * does not model per-variant history, so pretending each variant changed on its own schedule
 * would put timestamps on rows that nothing touched.
 */
function toVariantUpdate(
  row: ProductVariantRow,
  stamped: Date,
): Prisma.product_variantsUncheckedUpdateInput {
  return {
    sku: row.sku,
    price_minor: row.price_minor,
    attrs: row.attrs,
    active: row.active,
    updated_at: stamped,
  };
}

export { PRODUCT_REPOSITORY };
