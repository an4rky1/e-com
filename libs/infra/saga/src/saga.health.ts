import { Injectable, Logger } from '@nestjs/common';
import type { SagaStorePort } from './saga.store.port';

/**
 * Reports in-flight depth.
 *
 * @remarks Plain class rather than a `HealthIndicator` subclass, for the same reason as the
 * outbox's: it is constructed through the module factory, not by Nest's decorator scan, and a
 * single `check()` call site does not need the base class's `withStatus` helper.
 */
export class SagaHealthIndicator {
  private static readonly logger = new Logger(SagaHealthIndicator.name);

  constructor(private readonly store: SagaStorePort) {}

  async check(): Promise<Record<string, { status: string; [key: string]: unknown }>> {
    try {
      const [running, compensating, failed] = await Promise.all([
        this.store.countByStatus('running'),
        this.store.countByStatus('compensating'),
        this.store.countByStatus('failed'),
      ]);

      return {
        saga: {
          // A backlog of running sagas is work in progress, not an outage. A failed saga is
          // a distributed operation that could not finish and needs a human — degraded.
          status: failed > 0 ? 'degraded' : 'up',
          running,
          compensating,
          failed,
        },
      };
    } catch (error) {
      SagaHealthIndicator.logger.warn(
        `saga health check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { saga: { status: 'down' } };
    }
  }
}
