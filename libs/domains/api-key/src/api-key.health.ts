import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import { API_KEY_REPOSITORY } from './domain/ports/api-key-repository.port';
import type {
  ApiKeyRepositoryPort,
  ApiKeySpecification,
} from './domain/ports/api-key-repository.port';
import { ByUser, UsableKeys } from './domain/ports/api-key-repository.port';

/**
 * Reports whether api-key can serve reads.
 *
 * @remarks Probes the repository rather than the database socket: "can I load and rehydrate a
 * key" is the question a readiness check actually cares about, and it exercises the same path
 * authentication depends on. A probe that only opened a socket would report green on a schema
 * whose `api_keys` columns no longer line up with the aggregate.
 */
@Injectable()
export class ApiKeyHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepositoryPort,
  ) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    const started = Date.now();

    try {
      const probe: ApiKeySpecification = new UsableKeys();
      const total = await this.keys.count(new ByUser(PROBE_USER_ID));
      const usable = await this.keys.count(probe);

      return this.withStatus('api-key', true, {
        latencyMs: Date.now() - started,
        // Two queries rather than one, deliberately: a non-zero `usable` proves the status and
        // deadline predicates ran, which a bare `count` would not.
        probeUserKeys: total,
        usableKeys: usable,
      });
    } catch (error) {
      return this.withStatus('api-key', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** No user by this id exists; the repository answers `0` without a lookup failing. */
const PROBE_USER_ID = '00000000-0000-0000-0000-000000000000';