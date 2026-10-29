import { Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import { RedisService } from './redis.service';

/**
 * Readiness probe for the shared Redis connection.
 *
 * @remarks Pings rather than reading a key: the question is "is the server reachable from
 * this process", and any command answers it. Whether a specific consumer's keys still exist
 * is that consumer's concern, not the connection's.
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    try {
      await this.redis.ping();
      return this.withStatus('redis', true);
    } catch (error) {
      return this.withStatus('redis', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
