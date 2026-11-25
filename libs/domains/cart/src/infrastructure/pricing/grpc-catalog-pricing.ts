/**
 * @fileoverview The catalogue as the cart sees it, over gRPC.
 *
 * @remarks Two calls with two different jobs. `GetPricing` answers both questions — it is
 * the only catalogue RPC that speaks in SKUs, which is the only thing a cart line has —
 * and `GetProduct` is asked once per *new* line for the name the basket is labelled with.
 * A name is not a price, and fetching it on every read would be a second round trip to
 * change nothing: the line already carries the name it was added with.
 *
 * @remarks A failure is translated here rather than left for the caller, and only into the
 * two shapes a caller can act on: "the peer did not answer in time" and "the peer is not
 * there". Anything else — a wiring bug, a rejected request — is rethrown untouched, because
 * a missing proto address that surfaced as an outage would be retried forever by callers
 * doing exactly the right thing.
 */
import type {
  CatalogProduct,
  GetPricingRequest,
  GetPricingResponse,
} from '@auth/contracts';
import { translatePeerError, type GrpcChannel } from '@auth/infra/grpc';
import { parseShopMoney } from '../../money';
import type { CartConfig } from '../../cart.config';
import type {
  CurrentPrice,
  ProductPricingPort,
  SellableSku,
} from '../../domain/ports/product-pricing.port';

/** Full method paths, so a mistyped service name fails here rather than at the broker. */
const METHOD = {
  GET_PRICING: '/catalog.v1.CatalogService/GetPricing',
  GET_PRODUCT: '/catalog.v1.CatalogService/GetProduct',
} as const;

export class GrpcCatalogPricing implements ProductPricingPort {
  constructor(
    private readonly channel: GrpcChannel,
    private readonly config: CartConfig,
  ) {}

  async findSellable(sku: string): Promise<SellableSku | null> {
    const wanted = sku?.trim() ?? '';
    if (wanted.length === 0) return null;

    const pricing = await this.call<GetPricingRequest, GetPricingResponse>(
      METHOD.GET_PRICING,
      { skus: [wanted] },
    );

    const hit = pricing.prices.find((price) => price.sku === wanted);
    // Absent from the reply, or listed but withdrawn: either way it cannot be added, and
    // that is a real answer rather than a failure.
    if (!hit || !hit.active) return null;

    const product = await this.call<{ id: string }, CatalogProduct>(METHOD.GET_PRODUCT, {
      id: hit.productId,
    });

    return {
      sku: hit.sku,
      productId: hit.productId,
      name: product.name,
      price: parseShopMoney(hit.price, 'price'),
    };
  }

  async findPrices(skus: readonly string[]): Promise<CurrentPrice[]> {
    const wanted = [
      ...new Set(
        skus
          .map((sku) => sku?.trim() ?? '')
          .filter((sku) => sku.length > 0),
      ),
    ];
    if (wanted.length === 0) return [];

    const pricing = await this.call<GetPricingRequest, GetPricingResponse>(
      METHOD.GET_PRICING,
      { skus: wanted },
    );

    return pricing.prices.map((price) => ({
      sku: price.sku,
      price: parseShopMoney(price.price, 'price'),
      active: price.active,
    }));
  }

  private call<TRequest extends object, TResponse>(
    method: string,
    request: TRequest,
  ): Promise<TResponse> {
    // The deadline is computed per call rather than captured once: it is an absolute
    // instant, so a value captured at construction would already have expired by the time
    // a request arrived.
    return this.channel
      .unary<TRequest, TResponse>(method, request, {
        deadline: Date.now() + this.config.grpcDeadlineMs,
      })
      .catch((error: unknown) => {
        throw translatePeerError(error, method, 'catalog');
      });
  }
}
