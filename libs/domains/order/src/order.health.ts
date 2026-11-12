import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import { ORDER_REPOSITORY, type OrderRepositoryPort } from './domain/ports/order-repository.port';

/**
 * Reports whether order can serve reads.
 *
 * @remarks Probes the repository rather than the database socket: "can I load and count
 * orders" is the question a readiness check actually cares about, and it exercises the
 * same path every GetOrder depends on. A probe that only opened a socket would report
 * green on a schema whose `orders` columns no longer line up with the aggregate.
 */
@Injectable()
export class OrderHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
  ) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();

    try {
      const probeCount = await this.orders.probe();

      return this.withStatus('order', true, {
        latencyMs: Date.now() - started,
        // A count of a non-existent user: exercises the list path without loading rows.
        probeOrders: probeCount,
      });
    } catch (error) {
      return this.withStatus('order', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
