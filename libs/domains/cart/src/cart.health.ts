/**
 * @fileoverview Cart's own readiness probe.
 *
 * @remarks Probes the store rather than the socket: "can this service still answer a
 * GetCart?" is the question a readiness check actually cares about, and it is the store —
 * not the connection behind it — that would refuse first. A probe that only opened a
 * Redis connection would report green on a deployment with no `REDIS_URL` at all, which is
 * precisely the state in which every cart request fails.
 *
 * @remarks Never throws. A health check that raises turns one sick dependency into an
 * error on the health endpoint itself, and the two become indistinguishable.
 */
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import { CART_STORE, type CartStorePort } from './domain/ports/cart-store.port';

@Injectable()
export class CartHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(CART_STORE) private readonly store: CartStorePort,
  ) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();

    try {
      await this.store.ping();

      return this.withStatus('cart', true, {
        latencyMs: Date.now() - started,
      });
    } catch (error) {
      return this.withStatus('cart', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
