import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { ArticleModule } from '../dist/article/article.module.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { AuthService } from '../dist/auth/auth.service.js';

test(
  'article REST lifecycle, administrator authorization, publication, search, pagination, sanitization and version conflicts',
  { skip: !process.env.ARTICLE_TEST_DATABASE },
  async () => {
    // All test data uses one connection and is rolled back, leaving existing records untouched.
    const pool = new Pool();
    const db = await pool.connect();
    let app;
    try {
      await db.query('BEGIN');
      const owner = randomUUID();
      const stranger = randomUUID();
      await db.query(
        'INSERT INTO users(id,name,email,username) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)',
        [
          owner,
          'Author',
          `${owner}@example.com`,
          `t_${owner.slice(0, 8)}`,
          stranger,
          'Other',
          `${stranger}@example.com`,
          `t_${stranger.slice(0, 8)}`,
        ],
      );
      const module = await Test.createTestingModule({
        imports: [ArticleModule],
      })
        .overrideProvider(DatabaseService)
        .useValue({ pool: { query: (...args) => db.query(...args) } })
        .overrideProvider(AuthService)
        .useValue({
          me: async (token) => {
            if (!['a'.repeat(64), 'b'.repeat(64)].includes(token)) {
              const { UnauthorizedException } = await import('@nestjs/common');
              throw new UnauthorizedException();
            }
            return {
              id: token === 'a'.repeat(64) ? owner : stranger,
              isAdmin: token === 'a'.repeat(64),
            };
          },
        })
        .compile();
      app = module.createNestApplication({ logger: false });
      app.setGlobalPrefix('api');
      await app.init();
      const api = request(app.getHttpServer());
      const asOwner = (req) =>
        req.set('Authorization', 'Bearer ' + 'a'.repeat(64));
      const asOther = (req) =>
        req.set('Authorization', 'Bearer ' + 'b'.repeat(64));
      const payload = {
        title: 'Lifecycle Article',
        category: '前端',
        tags: ['Vue'],
        content:
          '<h2>标题</h2><p><strong>正文</strong><script>alert(1)</script></p>',
        status: 'draft',
      };
      await api.post('/api/articles').send(payload).expect(401);
      const created = await asOwner(api.post('/api/articles'))
        .send(payload)
        .expect(201);
      const id = created.body.id;
      assert.equal(created.body.version, 1);
      assert.doesNotMatch(created.body.content, /script/);
      await api.get(`/api/articles/${id}`).expect(404);
      await asOther(api.get(`/api/articles/manage/${id}`)).expect(403);
      await asOther(api.delete(`/api/articles/${id}`)).expect(403);
      await asOther(api.patch(`/api/articles/${id}`))
        .send({ ...payload, version: 1 })
        .expect(403);
      const drafts = await asOwner(
        api.get('/api/articles/manage?status=draft&q=Lifecycle'),
      ).expect(200);
      assert.equal(drafts.body.total, 1);
      assert.equal(drafts.body.items[0].content, undefined);
      const published = await asOwner(api.patch(`/api/articles/${id}`))
        .send({ ...payload, status: 'published', version: 1 })
        .expect(200);
      assert.equal(published.body.version, 2);
      assert.ok(published.body.publishedAt);
      await api.get(`/api/articles/${id}`).expect(200);
      const reading = await api
        .get('/api/articles?q=Lifecycle&category=%E5%89%8D%E7%AB%AF&limit=1')
        .expect(200);
      assert.equal(reading.body.total, 1);
      assert.equal(reading.body.items[0].id, id);
      const emptyPage = await api
        .get('/api/articles?q=Lifecycle&page=2&limit=1')
        .expect(200);
      assert.equal(emptyPage.body.total, 1);
      assert.deepEqual(emptyPage.body.items, []);
      await asOwner(api.patch(`/api/articles/${id}`))
        .send({ ...payload, version: 1 })
        .expect(409);
      await asOwner(api.patch(`/api/articles/${id}`))
        .send({ ...payload, version: 2 })
        .expect(200);
      await api.get(`/api/articles/${id}`).expect(404);
      await asOwner(api.delete(`/api/articles/${id}`)).expect(204);
      await asOwner(api.get(`/api/articles/manage/${id}`)).expect(404);
    } finally {
      if (app) await app.close();
      await db.query('ROLLBACK');
      db.release();
      await pool.end();
    }
  },
);
