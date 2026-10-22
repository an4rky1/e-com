import { HealthIndicator } from '@auth/platform/health';
import type { UserRepositoryPort } from './domain/ports/user-repository.port';
import { NotDeleted } from './domain/ports/user-repository.port';

/**
 * Reports whether identity can serve reads.
 *
 * @remarks Probes the repository rather than the database socket: "can I list users" is the
 * question a readiness check actually cares about, and it exercises the same path the
 * gateway depends on.
 */
export class IdentityHealthIndicator extends HealthIndicator {
  constructor(private readonly users: UserRepositoryPort) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();
    try {
      const total = await this.users.count(new NotDeleted());
      return this.withStatus('identity', true, {
        latencyMs: Date.now() - started,
        users: total,
      });
    } catch (error) {
      return this.withStatus('identity', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}