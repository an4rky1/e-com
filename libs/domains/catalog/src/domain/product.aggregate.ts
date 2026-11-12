/**
 * @fileoverview The product aggregate: create, reprice, archive.
 *
 * @remarks Catalog answers one question — "what is this thing, what does it cost and may it
 * still be sold?" — so the aggregate owns the product *document* (name, category path,
 * media keys) together with its variants, and nothing else. Stock is inventory's fact and a
 * cart is the shopper's selection: neither belongs here, and holding either would make
 * "is this product sellable" depend on a service this one does not own.
 *
 * @remarks Price lives on the variant, never on the product: two sizes of the same shoe
 * routinely differ in price, and a single product-level price would have to be a range that
 * no order could ever charge. Money is integer minor units all the way down — a float in a
 * price diverges from the database the first time a sum is computed in a different order.
 *
 * @remarks The aggregate is also the only place `fromRow`/`toRow` live. Declaring the row
 * shape here rather than in the repository keeps the read and the write in agreement by
 * construction, and lets a test double be built without importing Prisma: the domain must
 * not know the transport, but it can know the shape of its own storage.
 */
import { AggregateRoot, DomainEvent, Ensure, type IDomainEvent } from '@auth/core';
import type {
  ProductCatalogPayload,
  ProductPriceChangedPayload,
} from '@auth/contracts';

/** Aggregate/event identity constants — the prefix that scopes every product event. */
export const PRODUCT_AGGREGATE = 'Product';

/** Name bounds. Kept here so the aggregate and the command handler state one rule. */
export const PRODUCT_NAME_MIN_LENGTH = 2;
export const PRODUCT_NAME_MAX_LENGTH = 200;

/**
 * Carried on `product.created`.
 *
 * @remarks The skus rather than the variant rows: a consumer indexing a catalogue wants to
 * know which identifiers now exist, and a price on a *created* event would be stale the
 * moment `product.price_changed` fires — an event that is right once and wrong forever
 * after is worse than one that never carried it.
 */
export interface ProductCreatedPayload {
  readonly productId: string;
  readonly name: string;
  readonly categoryPath: readonly string[];
  readonly mediaKeys: readonly string[];
  readonly currency: string;
  readonly skus: readonly string[];
}

export class ProductCreated extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: ProductCreatedPayload,
    version = 1,
  ) {
    super(aggregateId, PRODUCT_AGGREGATE, 'product.created', version);
  }
}

export class ProductPriceChanged extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: ProductPriceChangedPayload,
    version = 1,
  ) {
    super(aggregateId, PRODUCT_AGGREGATE, 'product.price_changed', version);
  }
}

export class ProductArchived extends DomainEvent {
  constructor(
    aggregateId: string,
    readonly payload: ProductCatalogPayload,
    version = 1,
  ) {
    super(aggregateId, PRODUCT_AGGREGATE, 'product.archived', version);
  }
}

/** One sellable configuration of a product. Identity is the row id, not the sku. */
export interface ProductVariant {
  /** Row id. Stable for the life of the variant, so a reprice is an update, not a re-insert. */
  id: string;
  /** Stock-keeping unit: unique across the whole catalogue, non-empty, case-sensitive. */
  sku: string;
  /** Integer minor units. */
  priceMinor: number;
  /** Free-form display attributes (`size`, `colour`). Never queried by value. */
  attrs: Record<string, string>;
  active: boolean;
}

export interface ProductProps {
  name: string;
  description: string;
  /** Full path of the node in the category tree, e.g. `["shoes", "running"]`. */
  categoryPath: string[];
  variants: ProductVariant[];
  /** Object-storage keys only. The bytes live in the file store; a URL would go stale. */
  mediaKeys: string[];
  currency: string;
  active: boolean;
  /** Position in the event stream, mirrored to `products.version`. */
  version: number;
}

/**
 * One `products` row, exactly as the column names spell it.
 *
 * @remarks Declared here rather than in the repository so `fromRow` and `toRow` agree by
 * construction, and so an in-memory double in a test can be built without importing Prisma.
 */
export interface ProductRow {
  id: string;
  name: string;
  description: string;
  category_path: string[];
  media_keys: string[];
  currency: string;
  active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * One `product_variants` row.
 *
 * @remarks Deliberately without `created_at`/`updated_at`: the aggregate does not model
 * variant history, so those two columns are the database's to default and the repository's
 * to touch. Carrying them here would mean inventing a timestamp on every rehydration.
 */
export interface ProductVariantRow {
  id: string;
  product_id: string;
  sku: string;
  price_minor: number;
  attrs: Record<string, string>;
  active: boolean;
}

/** The pair a save writes: the document and every variant that hangs off it. */
export interface ProductWriteRows {
  readonly product: ProductRow;
  readonly variants: ProductVariantRow[];
}

/**
 * One product document and its variants.
 *
 * @remarks The consistency boundary for the document *and* its events: a price change and
 * the `product.price_changed` that announces it must commit together, which is exactly what
 * the outbox pattern needs from an aggregate. Persisting them separately leaves a window in
 * which a price moved and no consumer ever heard about it.
 */
export class Product extends AggregateRoot<string> {
  private constructor(
    id: string,
    private readonly props: ProductProps,
    createdAt: Date,
  ) {
    super(id, createdAt, createdAt, null);
  }

  /**
   * Issues a product from freshly supplied document data.
   *
   * @remarks The currency is an argument rather than configuration read here: the domain
   * decides what a product is denominated in from what the caller supplies, so a test can
   * mint a `EUR` product without touching the environment.
   *
   * @remarks Every rule that can reject a *new* product is asserted here, so a second entry
   * point (a seeding script, an import) cannot mint a document this one would refuse.
   */
  static create(input: {
    id?: string;
    name: string;
    description?: string;
    categoryPath?: readonly string[];
    variants: readonly {
      sku: string;
      priceMinor: number;
      attrs?: Record<string, string>;
    }[];
    mediaKeys?: readonly string[];
    currency: string;
    now?: Date;
  }): Product {
    const now = input.now ?? new Date();
    const id = input.id ?? globalThis.crypto.randomUUID();
    const name = input.name.trim();

    Ensure.minLength(name, PRODUCT_NAME_MIN_LENGTH, 'name');
    Ensure.maxLength(name, PRODUCT_NAME_MAX_LENGTH, 'name');
    Ensure.notEmpty(input.currency, 'currency');
    Ensure.isTrue(
      input.variants.length > 0,
      'a product needs at least one variant to be sellable',
      'INVARIANT_VIOLATION',
    );

    const seen = new Set<string>();
    const variants: ProductVariant[] = input.variants.map((variant) => {
      const sku = variant.sku.trim();
      Ensure.notEmpty(sku, 'variant.sku');
      Ensure.isTrue(
        !seen.has(sku),
        `duplicate sku "${sku}" in the same product`,
        'INVARIANT_VIOLATION',
      );
      seen.add(sku);
      assertPrice(variant.priceMinor);

      return {
        id: globalThis.crypto.randomUUID(),
        sku,
        priceMinor: variant.priceMinor,
        attrs: { ...(variant.attrs ?? {}) },
        active: true,
      };
    });

    // Trimmed here rather than at the transport: a path is a list of segments, and
    // `" shoes "` and `"shoes"` are the same path. A segment that trims to nothing is not a
    // path at all, so it is refused here, where every caller of `create` passes through.
    const categoryPath = (input.categoryPath ?? []).map((segment) => segment.trim());
    Ensure.isTrue(
      categoryPath.every((segment) => segment.length > 0),
      'category path segments must be non-empty',
      'INVARIANT_VIOLATION',
    );

    const product = new Product(
      id,
      {
        name,
        description: input.description ?? '',
        categoryPath,
        variants,
        mediaKeys: [...(input.mediaKeys ?? [])],
        currency: input.currency.trim(),
        active: true,
        version: 1,
      },
      now,
    );

    product.addDomainEvent(
      new ProductCreated(
        id,
        {
          productId: id,
          name: product.props.name,
          categoryPath: [...product.props.categoryPath],
          mediaKeys: [...product.props.mediaKeys],
          currency: product.props.currency,
          skus: product.props.variants.map((variant) => variant.sku),
        },
        product.props.version,
      ),
    );

    return product;
  }

  /** Rehydration from persistence. Does not emit events — the write already happened. */
  static fromRow(row: ProductRow, variantRows: readonly ProductVariantRow[]): Product {
    const product = new Product(
      row.id,
      {
        name: row.name,
        description: row.description,
        categoryPath: [...row.category_path],
        // Sorted by sku rather than by row order: the document is read as a list by every
        // caller, and a price range computed over a differently-ordered list would still be
        // right — but a diff between two reads would look like a change that never happened.
        variants: variantRows
          .map((variant) => ({
            id: variant.id,
            sku: variant.sku,
            priceMinor: variant.price_minor,
            attrs: toAttrs(variant.attrs),
            active: variant.active,
          }))
          .sort((left, right) => left.sku.localeCompare(right.sku)),
        mediaKeys: [...row.media_keys],
        currency: row.currency,
        active: row.active,
        // Read from the column, unlike api-key where the counter is not persisted: here
        // `version` *is* `products.version`, so a rehydrated product continues from the
        // position its last committed event left it at.
        version: row.version,
      },
      row.created_at,
    );
    product.updatedAt = row.updated_at;
    return product;
  }

  /** The same aggregate, flattened the way persistence hands it back. */
  toRow(): ProductWriteRows {
    return {
      product: {
        id: this.id,
        name: this.props.name,
        description: this.props.description,
        category_path: [...this.props.categoryPath],
        media_keys: [...this.props.mediaKeys],
        currency: this.props.currency,
        active: this.props.active,
        version: this.props.version,
        created_at: this.createdAt,
        updated_at: this.updatedAt,
      },
      variants: this.props.variants.map((variant) => ({
        id: variant.id,
        product_id: this.id,
        sku: variant.sku,
        price_minor: variant.priceMinor,
        attrs: { ...variant.attrs },
        active: variant.active,
      })),
    };
  }

  get name(): string {
    return this.props.name;
  }

  get description(): string {
    return this.props.description;
  }

  get categoryPath(): readonly string[] {
    return this.props.categoryPath;
  }

  get variants(): readonly ProductVariant[] {
    return this.props.variants;
  }

  get mediaKeys(): readonly string[] {
    return this.props.mediaKeys;
  }

  get currency(): string {
    return this.props.currency;
  }

  get isActive(): boolean {
    return this.props.active;
  }

  /**
   * Position in this product's event stream.
   *
   * @remarks Shadows `AggregateRoot.version`, which counts *buffered* events and therefore
   * reads `0` immediately after `clearDomainEvents()` — which would make two different
   * events share a `dedup_key` and the second one be silently swallowed as a duplicate.
   */
  override get version(): number {
    return this.props.version;
  }

  variant(sku: string): ProductVariant | undefined {
    return this.props.variants.find((candidate) => candidate.sku === sku);
  }

  /** Lowest and highest variant price, or `null` when there is nothing to range over. */
  get priceRange(): { min: number; max: number } | null {
    if (this.props.variants.length === 0) return null;
    const prices = this.props.variants.map((variant) => variant.priceMinor);
    return { min: Math.min(...prices), max: Math.max(...prices) };
  }

  /**
   * Changes one variant's price.
   *
   * @remarks Emits `product.price_changed` only when the number actually moves. A no-op
   * reprice that announced itself would wake every subscriber — search reindexing, the
   * cart's price watcher, a pricing alert — for a fact that is not true, and would burn the
   * aggregate's version on an event that says nothing changed.
   *
   * @remarks Refuses an archived product rather than silently repricing a document no
   * longer on sale: a price on a dead product is a fact about a product nobody can buy,
   * and accepting it hides a caller bug behind a write that looks like it worked.
   */
  setVariantPrice(sku: string, priceMinor: number, now: Date = new Date()): void {
    Ensure.isTrue(
      this.props.active,
      `product is archived and cannot be repriced`,
      'CONFLICTING_STATE',
    );

    const variant = this.variant(sku);
    Ensure.notNull(variant, `variant "${sku}"`);
    assertPrice(priceMinor);

    if (variant.priceMinor === priceMinor) return;

    const before = variant.priceMinor;
    variant.priceMinor = priceMinor;
    this.bump(now);

    this.addDomainEvent(
      new ProductPriceChanged(
        this.id,
        {
          productId: this.id,
          sku: variant.sku,
          before: { amountMinor: before, currency: this.props.currency },
          after: { amountMinor: priceMinor, currency: this.props.currency },
        },
        this.props.version,
      ),
    );
  }

  /**
   * Withdraws the product from sale.
   *
   * @remarks Idempotent: archiving is retried by every operator tooling that queues a
   * "retire this sku" job, and a second call must not emit a second `product.archived` for
   * a fact already published — the `dedup_key` would collide, but only by accident.
   */
  archive(reason: string, now: Date = new Date()): void {
    if (!this.props.active) return;

    this.props.active = false;
    this.bump(now);

    this.addDomainEvent(
      new ProductArchived(
        this.id,
        {
          productId: this.id,
          name: this.props.name,
          categoryPath: [...this.props.categoryPath],
          reason,
        },
        this.props.version,
      ),
    );
  }

  /** Every mutation goes through here, so `version` can never drift from the event stream. */
  private bump(now: Date): void {
    this.props.version += 1;
    this.updatedAt = now;
  }
}

export type ProductEvent = ProductCreated | ProductPriceChanged | ProductArchived;

export const isProductEvent = (event: IDomainEvent): boolean =>
  event.aggregateType === PRODUCT_AGGREGATE;

/** A price is an integer number of minor units, and never negative. */
function assertPrice(priceMinor: number): void {
  Ensure.isTrue(
    Number.isSafeInteger(priceMinor) && priceMinor >= 0,
    'price must be a non-negative integer in minor units',
    'OUT_OF_RANGE',
  );
}

/**
 * Reads a JSON column as the string map the wire promises.
 *
 * @remarks Coerced rather than trusted: the column accepts any JSON, and a row written by
 * an importer with a number in `size` must still load instead of taking the whole product
 * read down with a type error. Values that are not strings are stringified, never dropped —
 * an attribute a caller set is an attribute they expect to see.
 *
 * @remarks Exported because the repository faces the same column: Prisma hands back
 * `Prisma.JsonValue`, and the only honest way to turn that into `Record<string, string>` is
 * the rule the aggregate already owns.
 */
export function toAttrs(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      key,
      typeof entry === 'string' ? entry : JSON.stringify(entry) ?? String(entry),
    ]),
  );
}
