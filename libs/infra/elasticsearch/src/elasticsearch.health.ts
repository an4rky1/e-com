import { Injectable } from '@nestjs/common';
import { HealthIndicator } from '@auth/platform/health';
import { ElasticsearchService } from './elasticsearch.service';

/**
 * Readiness probe for the search engine.
 *
 * @remarks A `ping` rather than an index query: the question is "is the cluster reachable
 * from this process", and any call answers it. A search through this indicator would
 * conflate engine health with data availability the engine is not responsible for.
 */
@Injectable()
export class ElasticsearchHealthIndicator extends HealthIndicator {
  constructor(private readonly search: ElasticsearchService) {
    super();
  }

  async check(): Promise<ReturnType<HealthIndicator['withStatus']>> {
    try {
      await this.search.ping();
      return this.withStatus('elasticsearch', true);
    } catch (error) {
      return this.withStatus('elasticsearch', false, {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
