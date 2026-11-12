import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import { PRODUCT_REPOSITORY } from './domain/ports/product-repository.port';
import type { ProductRepositoryPort } from './domain/ports/product-repository.port';

/**
 * Reports whether catalog can serve reads.
 *
 * @remarks Probes the repository rather than the database socket: "can I answer a product
 * question" is the question a readiness check actually cares about, and it exercises the same
 * path every gRPC method depends on. A probe that only opened a socket would report green on
 * a schema whose `product_variants` columns no longer line up with the aggregate.
 *
 * @remarks Two *bounded* probes on purpose. The natural alternative — `count(new
 * ActiveProducts())` — would load the whole catalogue into memory every few seconds per
 * replica, which turns a readiness check into the service's busiest read. A probe must cost
 * the same whether the catalogue holds ten products or ten million.
 */
@Injectable()
export class CatalogHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepositoryPort,
  ) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();

    try {
      // Two queries rather than one, deliberately: one proves the variant table answers an
      // indexed lookup, the other proves a product row still rehydrates into an aggregate.
      // Either failing on its own is a different thing to go fix.
      const skuKnown = await this.products.existsBySku(PROBE_SKU);
      const productKnown = (await this.products.findById(PROBE_PRODUCT_ID)) !== null;

      return this.withStatus('catalog', true, {
        latencyMs: Date.now() - started,
        probeSkuFound: skuKnown,
        probeProductFound: productKnown,
      });
    } catch (error) {
      return this.withStatus('catalog', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** No product holds this sku; the repository answers `false` without the lookup failing. */
const PROBE_SKU = 'health-probe-sku';

/** No product has this id; the repository answers `null` without the lookup failing. */
const PROBE_PRODUCT_ID = '00000000-0000-0000-0000-000000000000';
