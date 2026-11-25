import { resolveElasticsearchConfig } from '../src/elasticsearch.config';

describe('resolveElasticsearchConfig', () => {
  it('defaults to the single-node address, the products index and a 10s request timeout', () => {
    const config = resolveElasticsearchConfig({});

    expect(config.url).toBe('http://localhost:9200');
    expect(config.index).toBe('products');
    expect(config.requestTimeoutMs).toBe(10_000);
  });

  it('reads the ELASTICSEARCH_* variables from the platform namespace', () => {
    const config = resolveElasticsearchConfig({
      ELASTICSEARCH_URL: 'http://es.internal:9200',
      ELASTICSEARCH_INDEX: 'shop',
      ELASTICSEARCH_REQUEST_TIMEOUT_MS: '2000',
    });

    expect(config.url).toBe('http://es.internal:9200');
    expect(config.index).toBe('shop');
    expect(config.requestTimeoutMs).toBe(2_000);
  });

  it('ignores similarly named variables from other namespaces', () => {
    const config = resolveElasticsearchConfig({
      ELASTICSEARCH_URL: 'http://es.internal:9200',
      OTHER_ELASTICSEARCH_URL: 'http://somewhere.else',
    });

    expect(config.url).toBe('http://es.internal:9200');
  });
});
