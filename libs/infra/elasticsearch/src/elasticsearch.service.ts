/**
 * The one search client, as a service.
 *
 * @remarks One client per process, shared by every search consumer. The wrapper is thin on
 * purpose: callers talk to it as `search`/`index`/`delete` and get typed answers, while the
 * client underneath handles connections and retries. Search consumers here are read-only
 * paths, so there is nothing to pipeline or multiplex by hand.
 */
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Client } from '@elastic/elasticsearch';
import { ELASTICSEARCH, ELASTICSEARCH_CONFIG, type ElasticsearchConfig } from './elasticsearch.config';

/** One document the platform indexed — the search-facing shape of a product. */
export interface ElasticsearchDocument {
  id: string;
  name: string;
  description: string;
  categoryPath: readonly string[];
  active: boolean;
}

/** What `search` returns: the matching ids with ES's relevance order and the match count. */
export interface ElasticsearchSearchResult {
  hits: readonly { id: string; score: number }[];
  total: number;
}

@Injectable()
export class ElasticsearchService implements OnModuleDestroy {
  private static readonly logger = new Logger(ElasticsearchService.name);

  constructor(
    @Inject(ELASTICSEARCH_CONFIG) private readonly config: ElasticsearchConfig,
    @Inject(ELASTICSEARCH) private readonly client: Client,
  ) {}

  /** The default index, so callers rarely need to name one. */
  get index(): string {
    return this.config.index;
  }

  /**
   * Runs a search on `index`.
   *
   * @remarks `query` is passed through as the ES DSL verbatim: callers are the catalog's
   * search use cases, and the value there is the query object itself, not a typed subset.
   * Only the paging window is decided here, so every consumer pages the same way.
   */
  async search(input: {
    index?: string;
    query: object;
    from: number;
    size: number;
  }): Promise<ElasticsearchSearchResult> {
    const response = await this.client.search({
      index: input.index ?? this.config.index,
      query: input.query as never,
      from: input.from,
      size: input.size,
    });

    const hits = (response.hits?.hits ?? []).map((hit) => ({
      id: hit._id ?? '',
      score: hit._score ?? 0,
    }));

    // `total` arrives as a number or as the object the `track_total_hits` forms allow; the
    // count is the same either way, and an unanswerable shape reads as the page length.
    const total = response.hits?.total;
    const totalValue = typeof total === 'object' ? (total?.value ?? hits.length) : (total ?? hits.length);

    return { hits, total: totalValue };
  }

  /** Writes (creates or updates) one document. */
  async indexDocument(input: { index?: string; doc: ElasticsearchDocument }): Promise<void> {
    await this.client.index({
      index: input.index ?? this.config.index,
      id: input.doc.id,
      document: input.doc as never,
    });
  }

  /** Removes one document; deleting an absent id is not an error. */
  async deleteDocument(input: { index?: string; id: string }): Promise<void> {
    try {
      await this.client.delete({
        index: input.index ?? this.config.index,
        id: input.id,
      });
    } catch (error) {
      // `deleteDocument` for an id that is not there answers 404 — that is the normal case
      // for an archived product whose doc was already dropped — and is not worth a round
      // trip error up the write path.
      if ((error as { statusCode?: number }).statusCode === 404) return;
      throw error;
    }
  }

  /** Answers `PING` on the engine: reachable, as far as this process can tell. */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.close();
    } catch (error) {
      ElasticsearchService.logger.warn(
        `Elasticsearch close failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
