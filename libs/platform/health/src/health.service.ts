import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { HealthCheckResult, HealthReport, HealthStatus } from './health.types';

type Indicator = () => Promise<HealthCheckResult>;

interface Registration {
  name: string;
  probe: Indicator;
  /** `required: false` indicators degrade the report instead of failing readiness. */
  required: boolean;
}

/**
 * Aggregates every registered indicator into one report.
 *
 * @remarks Probes run concurrently with a hard timeout. Sequential probing means the
 * endpoint's latency is the sum of every dependency, and one hung dependency makes the
 * health endpoint itself hang — which is the failure mode health endpoints exist to avoid.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly registrations = new Map<string, Registration>();
  private readonly startedAt = Date.now();
  private shuttingDown = false;

  constructor(private readonly serviceName: string) {}

  register(
    name: string,
    probe: Indicator,
    options: { required?: boolean } = {},
  ): void {
    this.registrations.set(name, {
      name,
      probe,
      required: options.required ?? true,
    });
  }

  unregister(name: string): void {
    this.registrations.delete(name);
  }

  /** Liveness: is the process running? Deliberately excludes dependencies. */
  liveness(): HealthReport {
    return {
      status: this.shuttingDown ? 'degraded' : 'up',
      service: this.serviceName,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks: {},
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(timeoutMs = 2_000): Promise<HealthReport> {
    const entries = await Promise.all(
      [...this.registrations.values()].map(async (registration) => {
        const started = Date.now();
        try {
          const result = await withTimeout(registration.probe(), timeoutMs);
          return {
            name: registration.name,
            required: registration.required,
            durationMs: Date.now() - started,
            result,
          };
        } catch (error) {
          return {
            name: registration.name,
            required: registration.required,
            durationMs: Date.now() - started,
            result: {
              [registration.name]: {
                status: 'down' as HealthStatus,
                message: error instanceof Error ? error.message : String(error),
              },
            },
          };
        }
      }),
    );

    const checks = entries.reduce<HealthCheckResult>(
      (accumulator, entry) => ({ ...accumulator, ...entry.result }),
      {},
    );

    const anyDown = entries.some(
      (entry) => checks[entry.name]?.status === 'down' && entry.required,
    );
    const anyDegraded = entries.some(
      (entry) => checks[entry.name]?.status !== 'up',
    );

    return {
      status: anyDown ? 'down' : anyDegraded ? 'degraded' : 'up',
      service: this.serviceName,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
      timestamp: new Date().toISOString(),
    };
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }
}

function withTimeout<TResult>(
  promise: Promise<TResult>,
  timeoutMs: number,
): Promise<TResult> {
  return new Promise<TResult>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`probe exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    // Never let the timeout timer hold the process open.
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}