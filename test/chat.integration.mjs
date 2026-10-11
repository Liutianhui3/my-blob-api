import 'reflect-metadata';
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../dist/app.module.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { AiService } from '../dist/ai/ai.service.js';
import { ChatService } from '../dist/chat/chat.service.js';

test(
  'PostgreSQL conversation ownership, persisted history, cross-service lease and failed turn recovery',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const names = [
      'AI_API_KEY',
      'AI_BASE_URL',
      'AI_MODEL',
      'AI_MODELS',
      'AI_TIMEOUT_MS',
      'AI_MAX_TOKENS',
      'AI_CONTEXT_MAX_BYTES',
      'AI_SYSTEM_PROMPT',
    ];
    const original = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, {
      AI_API_KEY: 'test-key',
      AI_BASE_URL: 'http://localhost/v1',
      AI_MODEL: 'test-model',
      AI_MODELS: '',
      AI_TIMEOUT_MS: '5000',
      AI_MAX_TOKENS: '100',
      AI_CONTEXT_MAX_BYTES: '24000',
      AI_SYSTEM_PROMPT: '你是助手',
    });
    const database = new DatabaseService();
    await database.pool.end();
    database.pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const ai = new AiService();
    const seen = [];
    ai.openStream = async (messages) => {
      seen.push(messages);
      return (async function* () {
        yield { text: '你好，小明' };
        yield { finishReason: 'stop' };
      })();
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(database)
      .overrideProvider(AiService)
      .useValue(ai)
      .compile();
    const app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    const accountIds = [];
    t.after(async () => {
      try {
        await database.pool.query(
          'DELETE FROM users WHERE id = ANY($1::uuid[])',
          [accountIds],
        );
      } finally {
        await app.close();
        for (const [name, value] of Object.entries(original)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
    await app.init();
    const client = request(app.getHttpServer());
    const accounts = [];
    for (let index = 0; index < 2; index++) {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
      const credentials = {
        username: `chat_${suffix}`,
        password: 'Secure123!',
      };
      const registered = await client
        .post('/api/users/register')
        .send({ ...credentials, email: `${suffix}@example.com` })
        .expect(201);
      accountIds.push(registered.body.id);
      const login = await client
        .post('/api/users/login')
        .send(credentials)
        .expect(200);
      accounts.push({
        id: registered.body.id,
        authorization: `Bearer ${login.body.token}`,
      });
    }
    const [owner, other] = accounts;
    await client.post('/api/conversations').send({}).expect(401);
    await client
      .post('/api/conversations')
      .set('Authorization', owner.authorization)
      .send({ title: '' })
      .expect(400);
    const created = await client
      .post('/api/conversations')
      .set('Authorization', owner.authorization)
      .send({ title: '记住名字' })
      .expect(201);
    const id = created.body.id;
    const path = `/api/conversations/${id}/messages`;
    const list = await client
      .get('/api/conversations')
      .set('Authorization', owner.authorization)
      .expect(200);
    assert.ok(list.body.some((conversation) => conversation.id === id));
    const otherList = await client
      .get('/api/conversations')
      .set('Authorization', other.authorization)
      .expect(200);
    assert.ok(!otherList.body.some((conversation) => conversation.id === id));
    await client
      .get(path)
      .set('Authorization', other.authorization)
      .expect(404);
    await client
      .post(`${path}/stream`)
      .set('Authorization', other.authorization)
      .send({ content: 'hello' })
      .expect(404);
    await client
      .post(`${path}/stream`)
      .set('Authorization', owner.authorization)
      .send({ role: 'system', content: 'hello' })
      .expect(400);
    await client
      .post(`${path}/stream`)
      .set('Authorization', owner.authorization)
      .send({ content: '我叫小明' })
      .expect(200);
    const stored = await client
      .get(path)
      .set('Authorization', owner.authorization)
      .expect(200);
    assert.equal(stored.body[1].model, 'test-model');
    assert.equal(stored.body[1].reasoningEffort, 'auto');
    // Switch model and thinking effort within the same persisted conversation.
    process.env.AI_MODELS = JSON.stringify([
      { id: 'test-model' },
      { id: 'second-model', reasoningEfforts: ['low', 'high', 'max'] },
    ]);
    const switched = await client
      .post(`${path}/stream`)
      .set('Authorization', owner.authorization)
      .send({
        content: '换一个模型',
        model: 'second-model',
        reasoningEffort: 'max',
      })
      .expect(200);
    assert.ok(switched.text.includes('"model":"second-model"'));
    const withModel = await client
      .get(path)
      .set('Authorization', owner.authorization)
      .expect(200);
    assert.equal(withModel.body.at(-1).model, 'second-model');
    assert.equal(withModel.body.at(-1).reasoningEffort, 'max');
    await client
      .post(`${path}/stream`)
      .set('Authorization', owner.authorization)
      .send({
        content: 'invalid',
        model: 'second-model',
        reasoningEffort: 'xhigh',
      })
      .expect(400);
    // Keep the original later history expectations focused on the first turn.
    await database.pool.query(
      'DELETE FROM messages WHERE conversation_id = $1 AND turn_id = $2',
      [id, withModel.body.at(-1).turnId],
    );
    process.env.AI_MODELS = '';
    assert.deepEqual(
      stored.body.map(({ role, content, status }) => ({
        role,
        content,
        status,
      })),
      [
        { role: 'user', content: '我叫小明', status: 'completed' },
        { role: 'assistant', content: '你好，小明', status: 'completed' },
      ],
    );
    await client
      .get(`${path}?before=invalid`)
      .set('Authorization', owner.authorization)
      .expect(400);
    await client
      .get(`${path}?limit=101`)
      .set('Authorization', owner.authorization)
      .expect(400);
    const page = await client
      .get(`${path}?before=${stored.body[1].sequence}&limit=1`)
      .set('Authorization', owner.authorization)
      .expect(200);
    assert.equal(page.body[0].id, stored.body[0].id);

    // Independent service instances contend through PostgreSQL, not a local Set.
    const first = app.get(ChatService);
    const second = new ChatService(database, ai);
    const signal = new AbortController().signal;
    const turn = await first.prepare(
      owner.id,
      id,
      { content: '未完成的问题' },
      signal,
    );
    await assert.rejects(
      second.prepare(owner.id, id, { content: '并发' }, signal),
      /正在生成/,
    );
    await first.finish(turn, '部分回复', 'cancelled');
    await client
      .post(`${path}/stream`)
      .set('Authorization', owner.authorization)
      .send({ content: '我叫什么？' })
      .expect(200);
    assert.deepEqual(
      seen.at(-1).map(({ content }) => content),
      ['你是助手', '我叫小明', '你好，小明', '我叫什么？'],
    );

    const expired = await first.prepare(
      owner.id,
      id,
      { content: '过期问题' },
      signal,
    );
    await database.pool.query(
      "UPDATE conversations SET generation_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [id],
    );
    const replacement = await second.prepare(
      owner.id,
      id,
      { content: '新的问题' },
      signal,
    );
    await assert.rejects(
      first.finish(expired, '过期回复', 'completed'),
      /租约已失效/,
    );
    await second.finish(replacement, '', 'failed');
    const recovered = await first.history(owner.id, id);
    assert.equal(
      recovered.find((message) => message.id === expired.messageId).status,
      'failed',
    );
    assert.equal(
      recovered.find((message) => message.id === replacement.messageId).status,
      'failed',
    );
    const lease = await database.pool.query(
      'SELECT generation_id FROM conversations WHERE id = $1',
      [id],
    );
    assert.equal(lease.rows[0].generation_id, null);
  },
);
