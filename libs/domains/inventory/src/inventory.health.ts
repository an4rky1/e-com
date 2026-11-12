/**
 * @fileoverview Inventory's own readiness probe.
 *
 * @remarks Probes the repository rather than the database socket: "can this service still
 * answer a reserve?" is the question a readiness check actually cares about, and counting
 * live holds exercises the same table the reserve path reads. A probe that only opened a
 * socket would report green on a schema whose `reservations` columns no longer line up
 * with the aggregate.
 */
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import {
  INVENTORY_REPOSITORY,
  type InventoryRepositoryPort,
} from './domain/ports/inventory-repository.port';

@Injectable()
export class InventoryHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepositoryPort,
  ) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();

    try {
      const activeReservations = await this.inventory.countActiveReservations();

      return this.withStatus('inventory', true, {
        latencyMs: Date.now() - started,
        activeReservations,
      });
    } catch (error) {
      return this.withStatus('inventory', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
