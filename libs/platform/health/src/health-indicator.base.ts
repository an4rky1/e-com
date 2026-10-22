import { Injectable } from '@nestjs/common';
import type { HealthCheckResult } from './health.types';

/**
 * Base class for module health indicators.
 *
 * @remarks `check()` must never throw and must never be slow. A health endpoint that
 * blocks on a downstream timeout turns one slow dependency into every replica being pulled
 * out of the load balancer — the outage amplifier.
 */
@Injectable()
export abstract class HealthIndicator {
  protected withStatus(
    key: string,
    healthy: boolean,
    details: Record<string, unknown> = {},
  ): HealthCheckResult {
    return { [key]: { status: healthy ? 'up' : 'down', ...details } };
  }
}