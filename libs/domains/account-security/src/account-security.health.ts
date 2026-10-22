import { HealthIndicator } from '@auth/platform/health';
import type { SecurityRepositoryPort } from './domain/ports/security-repository.port';
import type { FailureTrackerPort } from './domain/ports/failure-tracker.port';

/**
 * Reports whether account-security can answer a login.
 *
 * @remarks Probes the two stores a request actually needs — the login history and the rate
 * counters — rather than the database socket. "Can I read a user's history" is the question a
 * readiness check cares about, and a probe that skips the counters would call this service
 * ready while every sign-in silently lost its lockout.
 */
export class AccountSecurityHealthIndicator extends HealthIndicator {
  constructor(
    private readonly repository: SecurityRepositoryPort,
    private readonly tracker: FailureTrackerPort,
  ) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();
    try {
      // Any user id works: this asks "is the query path alive", not "does this account exist",
      // and a probe that depended on real data would flap every time the table was empty.
      const history = await this.repository.listLoginHistory(PROBE_USER_ID, { limit: 1 });
      const counters = await this.tracker.load({ ipAddress: PROBE_IP });

      return this.withStatus('account-security', true, {
        latencyMs: Date.now() - started,
        historyReadable: true,
        countersReadable: counters.ipFailures >= 0,
        sampleSize: history.length,
      });
    } catch (error) {
      return this.withStatus('account-security', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** A well-formed uuid that no account will own; the probe only needs a valid `where` clause. */
const PROBE_USER_ID = '00000000-0000-4000-8000-000000000000';
const PROBE_IP = '203.0.113.1';