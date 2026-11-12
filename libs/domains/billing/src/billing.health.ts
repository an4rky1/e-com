/**
 * @fileoverview Billing's own readiness probe.
 *
 * @remarks Probes the repository rather than the database socket: "can this service still
 * answer a charge?" is the question a readiness check actually cares about, and counting
 * payments exercises the same table the charge path writes. A probe that only opened a
 * socket would report green on a schema whose `payments` columns no longer line up with
 * the aggregate.
 */
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import {
  BILLING_REPOSITORY,
  type BillingRepositoryPort,
} from './domain/ports/billing-repository.port';

@Injectable()
export class BillingHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billing: BillingRepositoryPort,
  ) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();

    try {
      const payments = await this.billing.countPayments();

      return this.withStatus('billing', true, {
        latencyMs: Date.now() - started,
        payments,
      });
    } catch (error) {
      return this.withStatus('billing', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
