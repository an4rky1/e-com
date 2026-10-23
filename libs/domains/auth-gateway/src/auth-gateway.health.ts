/**
 * @fileoverview Readiness for the gateway.
 *
 * @remarks Probes the repository rather than the database socket: "can I open a flow" is the
 * question a readiness check actually cares about, and it exercises the same path the api-gateway
 * depends on.
 *
 * @remarks Deliberately does *not* probe identity, credential-vault, mfa or session-token. A
 * readiness check that calls four dependencies on every poll turns one slow dependency into
 * every replica being pulled out of the load balancer. A dependency that is down makes
 * sign-ins fail, which is a different problem from this pod being unable to serve, and the two
 * are reported by different means on purpose.
 */
import { HealthIndicator } from '@auth/platform/health';
import type { IClock } from '@auth/core';
import {
  AUTH_FLOW_REPOSITORY,
  type AuthFlowRepositoryPort,
} from './domain/ports/auth-flow-repository.port';
import { CLOCK } from './domain/ports/clock.port';

export class AuthGatewayHealthIndicator extends HealthIndicator {
  constructor(
    private readonly flows: AuthFlowRepositoryPort,
    private readonly clock: IClock,
  ) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();
    try {
      const active = await this.flows.countActive(this.clock.now());
      return this.withStatus('authGateway', true, {
        latencyMs: Date.now() - started,
        activeFlows: active,
      });
    } catch (error) {
      return this.withStatus('authGateway', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export { AUTH_FLOW_REPOSITORY, CLOCK };