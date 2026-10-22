/**
 * @fileoverview Readiness for the audit-log service.
 *
 * @remarks Two probes, because the two failures mean different things to whoever gets paged.
 * A countable table means "the log is readable" — without it an operator's only evidence is
 * unavailable. A verifiable head means "the chain is still intact" — without it the log answers
 * the wrong question, because records nobody can trust are not evidence of anything.
 *
 * @remarks Verification of *every* partition is not what a readiness probe should do: it is
 * O(records), and a health endpoint that blocks turns one slow query into every replica being
 * pulled out of the load balancer. One partition is sampled instead, which catches a broken
 * writer — the usual cause — without making the probe scale with the size of the log.
 */
import { HealthIndicator } from '@auth/platform/health';
import type { AuditRepositoryPort } from './domain/ports/audit-repository.port';

export class AuditLogHealthIndicator extends HealthIndicator {
  constructor(private readonly audit: AuditRepositoryPort) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();

    try {
      const total = await this.audit.count();
      const partitions = await this.audit.partitionKeys(1);
      const verified = partitions.length === 0 ? null : await this.audit.verify(partitions[0], 100);

      return this.withStatus('audit-log', true, {
        latencyMs: Date.now() - started,
        events: total,
        // `unknown` rather than `false`: "no partition has been opened yet" is a healthy
        // fresh deployment, and reporting it as a broken chain would page somebody at 3am
        // about a service that has never been used.
        chainIntact: verified === null ? 'unknown' : verified.ok,
      });
    } catch (error) {
      return this.withStatus('audit-log', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}