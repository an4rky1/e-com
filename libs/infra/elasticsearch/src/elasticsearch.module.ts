import { Client } from '@elastic/elasticsearch';
import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import {
  ELASTICSEARCH,
  ELASTICSEARCH_CONFIG,
  resolveElasticsearchConfig,
} from './elasticsearch.config';
import { ElasticsearchService } from './elasticsearch.service';
import { ElasticsearchHealthIndicator } from './elasticsearch.health';

/**
 * The process-wide Elasticsearch client.
 *
 * @remarks Like {@link RedisModule}, this is a shared engine behind many concerns rather
 * than per-domain clients: two of them would double connections, double indices and double
 * the thing to keep in sync with a rotation of the endpoint. Search being the first
 * consumer does not change the rule.
 */
@Global()
@Module({})
export class ElasticsearchModule {
  private static readonly logger = new Logger(ElasticsearchModule.name);

  static forRoot(): DynamicModule {
    const config = resolveElasticsearchConfig();

    return {
      module: ElasticsearchModule,
      providers: [
        { provide: ELASTICSEARCH_CONFIG, useValue: config },
        {
          provide: ELASTICSEARCH,
          useFactory: (): Client =>
            new Client({
              node: config.url,
              requestTimeout: config.requestTimeoutMs,
              // The platform's engine, like its database, is expected to be up; a search
              // call failing loudly is the honest answer for it.
              maxRetries: 2,
            }),
        },
        ElasticsearchService,
        ElasticsearchHealthIndicator,
      ],
      exports: [ELASTICSEARCH, ELASTICSEARCH_CONFIG, ElasticsearchService, ElasticsearchHealthIndicator],
    };
  }
}
