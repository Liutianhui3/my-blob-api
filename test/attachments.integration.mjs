import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../dist/app.module.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { AiService } from '../dist/ai/ai.service.js';
import { RagService } from '../dist/knowledge/rag.service.js';

test('attachments survive SQL history and reach the model on later turns', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const database = new DatabaseService();
  await database.pool.end();
  database.pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const ai = new AiService();
  ai.configuration = () => ({ systemPrompt: '助手', contextMaxBytes: 24000, timeoutMs: 10000 });
  ai.resolveGeneration = () => ({ model: 'test', reasoningEffort: 'auto', tokenParameter: 'max_tokens' });
  const upstream = [];
  ai.openStream = async messages => { upstream.push(messages); return (async function* () { yield { text: '已读取附件', finishReason: 'stop' }; })(); };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService).useValue(database)
    .overrideProvider(AiService).useValue(ai)
    .overrideProvider(RagService).useValue({ retrieve: async () => [] }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '12mb' });
  let userId;
  try {
    await app.init();
    const client = request(app.getHttpServer());
    const username = `att_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
    const credentials = { username, password: 'Secure123!' };
    const user = await client.post('/api/users/register').send({ ...credentials, email: `${username}@example.com` }).expect(201);
    userId = user.body.id;
    const login = await client.post('/api/users/login').send(credentials).expect(200);
    const auth = `Bearer ${login.body.token}`;
    const conversation = await client.post('/api/conversations').set('Authorization', auth).send({ title: '附件测试' }).expect(201);
    const path = `/api/conversations/${conversation.body.id}/messages`;
    const attachments = [{ name: 'test.md', type: 'document', text: '测试文档内容' }, { name: 'pixel.png', type: 'image', mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY2kAAAAASUVORK5CYII=' }];
    await client.post(`${path}/stream`).set('Authorization', auth).send({ content: '分析', attachments }).expect(200);
    const history = await client.get(path).set('Authorization', auth).expect(200);
    assert.equal(history.body[0].attachments.length, 2);
    assert.equal(history.body[0].attachments[1].data, attachments[1].data);
    await client.post(`${path}/stream`).set('Authorization', auth).send({ content: '继续' }).expect(200);
    assert.match(upstream[1][1].content[0].text, /测试文档内容/);
    assert.equal(upstream[1][1].content[1].image_url.url, attachments[1].data);
    await client.post(`${path}/stream`).set('Authorization', auth).send({ content: '分析', attachments: [{ type: 'document', name: 'x.pdf', text: 'x' }] }).expect(400);
  } finally {
    if (userId) await database.pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await app.close();
  }
});
