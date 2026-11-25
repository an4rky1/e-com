import type { Client } from '@elastic/elasticsearch';
import { ElasticsearchService } from '../src/elasticsearch.service';

const CONFIG = {
  url: 'http://localhost:9200',
  index: 'products',
  requestTimeoutMs: 10_000,
};

const fakeClient = () =>
  ({
    search: jest.fn(),
    index: jest.fn(),
    delete: jest.fn(),
    ping: jest.fn(),
    close: jest.fn(),
  }) as unknown as Client;

describe('ElasticsearchService', () => {
  it('maps engine hits to ids and the total match count', async () => {
    const client = fakeClient();
    (client.search as jest.Mock).mockResolvedValue({
      hits: {
        total: { value: 7 },
        hits: [
          { _id: 'a', _score: 1.5 },
          { _id: 'b', _score: 1 },
        ],
      },
    });
    const service = new ElasticsearchService(CONFIG, client);

    const result = await service.search({
      index: 'shop',
      query: { term: { active: true } },
      from: 5,
      size: 10,
    });

    expect(result).toEqual({ hits: [{ id: 'a', score: 1.5 }, { id: 'b', score: 1 }], total: 7 });
    expect(client.search).toHaveBeenCalledWith({
      index: 'shop',
      query: { term: { active: true } },
      from: 5,
      size: 10,
    });
  });

  it('answers an empty result set as zero hits, not as an error', async () => {
    const client = fakeClient();
    (client.search as jest.Mock).mockResolvedValue({ hits: { total: { value: 0 }, hits: [] } });

    const result = await new ElasticsearchService(CONFIG, client).search({
      query: { match_all: {} },
      from: 0,
      size: 20,
    });

    expect(result).toEqual({ hits: [], total: 0 });
  });

  it('writes a document with its id, and deletes one by id', async () => {
    const client = fakeClient();
    const service = new ElasticsearchService(CONFIG, client);

    await service.indexDocument({
      doc: { id: 'p1', name: 'Trail Runner', description: 'Fast', categoryPath: [], active: true },
    });
    await service.deleteDocument({ id: 'p1' });

    expect(client.index).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', index: 'products' }),
    );
    expect(client.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', index: 'products' }));
  });

  it('treats a 404 on delete as already-removed, not as a failure', async () => {
    const client = fakeClient();
    (client.delete as jest.Mock).mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));

    await expect(
      new ElasticsearchService(CONFIG, client).deleteDocument({ id: 'gone' }),
    ).resolves.toBeUndefined();
  });
});
