import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ArticleService,
  cleanArticleHtml,
} from '../dist/article/article.service.js';

test('rich text removes executable content but preserves supported formatting', () => {
  const html = cleanArticleHtml(
    '<h2>标题</h2><p><strong>加粗</strong><a href="javascript:alert(1)" onclick="alert(1)">链接</a></p><img src="https://example.com/image.png" onerror="alert(1)"><img src="data:image/svg+xml,x"><script>alert(1)</script><iframe src="https://example.com"></iframe>',
  );
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /noopener noreferrer/);
  assert.doesNotMatch(
    html,
    /javascript:|onclick|onerror|<script|<iframe|data:image/,
  );
});

test('validation rejects bad queries, publication without content, forged ownership and unsafe covers before SQL', async () => {
  const service = new ArticleService({
    pool: {
      query() {
        throw new Error('SQL must not execute');
      },
    },
  });
  for (const query of [
    { page: -1 },
    { limit: 100 },
    { page: 1.5 },
    { status: 'admin' },
    { q: 'a'.repeat(101) },
  ])
    await assert.rejects(service.list(query), /查询参数/);
  for (const body of [
    { title: '' },
    {
      title: 'Title',
      status: 'published',
      content: '<script>alert(1)</script>',
    },
    { title: 'Title', user_id: 'forged' },
    { title: 'Title', coverUrl: 'javascript:alert(1)' },
    { title: 'Title', tags: Array(9).fill('tag') },
  ])
    await assert.rejects(service.create('owner', body));
  await assert.rejects(service.get('invalid'), /ID 无效/);
  await assert.rejects(
    service.update('00000000-0000-4000-8000-000000000001', {
      title: 'Title',
    }),
    /版本无效/,
  );
});

test('public reads exclude drafts and management reads cover all authors', async () => {
  const calls = [];
  const service = new ArticleService({
    pool: {
      query: async (sql, params) => {
        calls.push([sql, params]);
        return { rows: [] };
      },
    },
  });
  const id = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(service.get(id, true), /不存在/);
  assert.match(calls[0][0], /AND TRUE/);
  assert.deepEqual(calls[0][1], [id]);
  await assert.rejects(service.get(id), /不存在/);
  assert.match(calls[1][0], /a.status = 'published'/);
  await assert.rejects(service.remove(id), /不存在/);
  assert.match(calls[2][0], /DELETE FROM articles WHERE id=\$1/);
});
