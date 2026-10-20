import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../dist/app.module.js';
import { DatabaseService } from '../dist/database/database.service.js';

test('knowledge multipart upload, SQL persistence, ownership, pagination and cascading deletion', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const database = new DatabaseService();
  await database.pool.end();
  database.pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DatabaseService).useValue(database).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  const users = [];
  try {
    await app.init();
    const client = request(app.getHttpServer());
    async function account() {
      const username = `kb_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
      const body = { username, password: 'Secure123!', email: `${username}@example.com` };
      const user = await client.post('/api/users/register').send(body).expect(201);
      users.push(user.body.id);
      const login = await client.post('/api/users/login').send({ username: body.username, password: body.password }).expect(200);
      return `Bearer ${login.body.token}`;
    }
    const token = await account();
    const other = await account();
    await client.get('/api/knowledge-bases').expect(401);
    const base = await client.post('/api/knowledge-bases').set('Authorization', token).send({ name: '学习资料', description: '测试' }).expect(201);
    const path = `/api/knowledge-bases/${base.body.id}/documents`;
    await client.get(path).set('Authorization', other).expect(404);
    await client.post(path).set('Authorization', token).attach('file', Buffer.from('x'), 'test.pdf').expect(400);
    await client.post(path).set('Authorization', token).field('chunkSize', '100').field('chunkOverlap', '100').attach('file', Buffer.from('内容'), 'test.txt').expect(400);
    await client.post(path).set('Authorization', token).attach('file', Buffer.alloc(1024 * 1024 + 1, 65), 'big.txt').expect(413);
    const upload = await client.post(path).set('Authorization', token).field('chunkSize', '100').field('chunkOverlap', '20').attach('file', Buffer.from('知识'.repeat(950)), 'notes.md').expect(201);
    assert.equal(upload.body.chunkCount, 24);
    const documentId = upload.body.id;
    const listing = await client.get(path).set('Authorization', token).expect(200);
    assert.equal(listing.body.length, 1);
    const first = await client.get(`${path}/${documentId}/chunks`).set('Authorization', token).expect(200);
    assert.equal(first.body.items.length, 20);
    assert.equal(first.body.total, 24);
    const second = await client.get(`${path}/${documentId}/chunks?page=2`).set('Authorization', token).expect(200);
    assert.equal(second.body.items.length, 4);
    await client.get(`${path}/${documentId}/chunks`).set('Authorization', other).expect(404);
    const stats = await client.get('/api/knowledge-bases').set('Authorization', token).expect(200);
    assert.equal(stats.body.find(x => x.id === base.body.id).chunkCount, 24);
    await client.delete(`${path}/${documentId}`).set('Authorization', token).expect(200);
    const remaining = await database.pool.query('SELECT id FROM knowledge_chunks WHERE document_id=$1', [documentId]);
    assert.equal(remaining.rowCount, 0);
  } finally {
    for (const id of users) await database.pool.query('DELETE FROM users WHERE id=$1', [id]);
    await app.close();
  }
});
