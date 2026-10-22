import { HealthIndicator } from '@auth/platform/health';
import type { RoleRepositoryPort } from './domain/ports/role-repository.port';

/**
 * Reports whether access control can serve reads.
 *
 * @remarks Probes the role catalogue rather than the database socket: "can I list roles" is
 * the question a readiness check actually cares about, and it exercises the same path the
 * gateway depends on. A policy count rides along because a missing rule table is the failure
 * that turns every deny into a silent allow.
 */
export class AccessControlHealthIndicator extends HealthIndicator {
  constructor(private readonly roles: RoleRepositoryPort) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();
    try {
      const roles = await this.roles.count();
      return this.withStatus('access-control', true, {
        latencyMs: Date.now() - started,
        roles,
      });
    } catch (error) {
      return this.withStatus('access-control', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}