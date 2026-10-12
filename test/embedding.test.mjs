import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingService } from '../dist/knowledge/embedding.service.js';
import { KnowledgeService } from '../dist/knowledge/knowledge.service.js';

test('embedding reorders indexed batches and rejects malformed, duplicate and zero vectors', async () => {
  const original = globalThis.fetch;
  const service = new EmbeddingService();
  service.configuration = () => ({
    key: 'test-secret',
    model: 'BAAI/bge-m3',
    url: new URL('http://localhost/embeddings'),
  });
  try {
    const first = Array(1024).fill(1),
      second = Array(1024).fill(2);
    globalThis.fetch = async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).input, ['first', 'second']);
      return Response.json({
        data: [
          { index: 1, embedding: second },
          { index: 0, embedding: first },
        ],
      });
    };
    assert.deepEqual((await service.embed(['first', 'second'])).vectors, [
      first,
      second,
    ]);
    for (const data of [
      [
        { index: 0, embedding: first },
        { index: 0, embedding: second },
      ],
      [
        { index: 0, embedding: [1] },
        { index: 1, embedding: second },
      ],
      [
        { index: 0, embedding: Array(1024).fill(0) },
        { index: 1, embedding: second },
      ],
    ]) {
      globalThis.fetch = async () => Response.json({ data });
      await assert.rejects(
        () => service.embed(['first', 'second']),
        /向量服务调用失败/,
      );
    }
    globalThis.fetch = async () => new Response('test-secret', { status: 401 });
    await assert.rejects(
      () => service.embed(['first']),
      (error) =>
        !error.message.includes('test-secret') && error.getStatus() === 502,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('vector operations check ownership before calling remote embeddings', async () => {
  const service = new KnowledgeService(
    { pool: { query: async () => ({ rowCount: 0, rows: [] }) } },
    {
      embed: () => {
        throw new Error('Remote call must not happen');
      },
    },
  );
  const id = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(
    () => service.embedDocument('other', id, id),
    /知识库不存在/,
  );
  await assert.rejects(
    () => service.search('other', id, { query: 'hello' }),
    /知识库不存在/,
  );
});
