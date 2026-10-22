import { HealthIndicator } from '@auth/platform/health';
import type { PrismaClientLike, PrismaService } from './prisma.service';

/**
 * Probes the service's own database.
 *
 * @remarks `SELECT 1` against the service database only — the check is about this service's
 * ability to serve, not about the platform's.
 */
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService<PrismaClientLike>) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();
    try {
      await this.prisma.tx.$queryRaw`SELECT 1`;
      return this.withStatus('prisma', true, { latencyMs: Date.now() - started });
    } catch (error) {
      return this.withStatus('prisma', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}