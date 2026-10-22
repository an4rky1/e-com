/**
 * @fileoverview Readiness for the MFA service.
 *
 * @remarks Probes the factor table rather than the database socket: "can I load a factor and
 * its spent-step marker" is the question a readiness check actually cares about, and it
 * exercises the same include the verification path depends on. A probe that only opened a
 * socket would report green on a schema that cannot rehydrate a factor.
 */

import { HealthIndicator } from '@auth/platform/health';
import type { MfaFactorRepositoryPort } from './domain/ports/mfa-factor-repository.port';

export class MfaHealthIndicator extends HealthIndicator {
  constructor(private readonly factors: MfaFactorRepositoryPort) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();
    try {
      const factors = await this.factors.count();
      return this.withStatus('mfa', true, {
        latencyMs: Date.now() - started,
        factors,
      });
    } catch (error) {
      return this.withStatus('mfa', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}