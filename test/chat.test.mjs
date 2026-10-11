import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../dist/app.module.js';
import { AuthGuard } from '../dist/auth/guards/auth.guard.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { AiService } from '../dist/ai/ai.service.js';
import { ChatService } from '../dist/chat/chat.service.js';
import { sendMessage } from '../examples/chat-client.js';

const id = '11111111-1111-4111-8111-111111111111';
const encoder = new TextEncoder();
const delta = (text) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\r\n\r\n`;
const finish =
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test('authenticated POST streaming, browser client, upstream failures, timeout and cancellation', async (t) => {
  const keys = [
    'AI_API_KEY',
    'AI_MODEL',
    'AI_MODELS',
    'AI_BASE_URL',
    'AI_TIMEOUT_MS',
    'AI_MAX_TOKENS',
    'AI_CONTEXT_MAX_BYTES',
    'AI_SYSTEM_PROMPT',
  ];
  const originals = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  let mode = 'normal';
  const requests = [];
  let releaseUpstream;
  let upstreamClosed;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      headers: req.headers,
      body: JSON.parse(body),
      url: req.url,
    });
    if (mode === 'reject') {
      res.writeHead(401).end('{"error":"SECRET PROVIDER DETAILS"}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    if (mode === 'malformed') {
      res.end('data: not-json\n\n');
      return;
    }
    if (mode === 'incomplete') {
      res.end(delta('部分回复'));
      return;
    }
    if (mode === 'cancel' || mode === 'timeout') {
      res.once('close', () => upstreamClosed?.());
      res.write(delta('开始'));
      return;
    }
    // Split every UTF-8 byte, including Chinese and the middle of CRLF.
    const bytes = encoder.encode(delta('你好'));
    for (const byte of bytes) res.write(Uint8Array.of(byte));
    if (mode === 'hold') {
      releaseUpstream = () => res.end(delta('，小明') + finish);
      return;
    }
    res.end(delta('，小明') + finish);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  Object.assign(process.env, {
    AI_API_KEY: 'test-key',
    AI_MODEL: 'test-model',
    AI_MODELS: '',
    AI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    AI_TIMEOUT_MS: '5000',
    AI_MAX_TOKENS: '100',
    AI_CONTEXT_MAX_BYTES: '24000',
    AI_SYSTEM_PROMPT: '你是助手',
  });
  const ai = new AiService();
  let active = false;
  let history = [];
  let persisted;
  const chats = {
    async create() {
      return { id, title: '新对话' };
    },
    async list() {
      return [{ id }];
    },
    async history() {
      return [];
    },
    async prepare(userId, conversationId, body) {
      if (conversationId !== id || userId !== 'owner')
        throw new NotFoundException('会话不存在');
      if (active) throw new ConflictException('该会话正在生成回复');
      active = true;
      return {
        conversationId,
        generationId: 'generation',
        messageId: 'reply',
        userMessageId: 'question',
        messages: ai.buildMessages(history, body.content),
      };
    },
    async finish(turn, content, status) {
      persisted = { content, status };
      if (status === 'completed')
        history.push({
          user: turn.messages.at(-1).content,
          assistant: content,
        });
      active = false;
    },
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue({ pool: {} })
    .overrideProvider(ChatService)
    .useValue(chats)
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate(context) {
        const req = context.switchToHttp().getRequest();
        if (req.headers.authorization !== 'Bearer test-token')
          throw new UnauthorizedException();
        req.user = { id: 'owner' };
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api`;
  const client = request(app.getHttpServer());
  const path = `/api/conversations/${id}/messages/stream`;
  const invoke = (options = {}) =>
    sendMessage({
      base,
      token: 'test-token',
      conversationId: id,
      content: '我叫小明',
      ...options,
    });
  t.after(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await t.test(
    'auth and ownership errors occur before SSE headers',
    async () => {
      await client.post(path).send({ content: 'hello' }).expect(401);
      const missing = await client
        .post(
          '/api/conversations/22222222-2222-4222-8222-222222222222/messages/stream',
        )
        .set('Authorization', 'Bearer test-token')
        .send({ content: 'hello' })
        .expect(404);
      assert.match(missing.headers['content-type'], /application\/json/);
      assert.equal(requests.length, 0);
      await client.get('/api/conversations/models').expect(401);
      const models = await client
        .get('/api/conversations/models')
        .set('Authorization', 'Bearer test-token')
        .expect(200);
      assert.equal(models.body.defaultModel, 'test-model');
      assert.equal(models.body.models[0].id, 'test-model');
      assert.ok(!models.text.includes('test-key'));
    },
  );

  await t.test(
    'deltas arrive before upstream completion, save before done, concurrent send rejected',
    async () => {
      mode = 'hold';
      let resolveFirst;
      const first = new Promise((resolve) => {
        resolveFirst = resolve;
      });
      const reply = invoke({
        onDelta: (text) => resolveFirst(text),
        onDone: () => assert.equal(persisted.status, 'completed'),
      });
      assert.equal(await first, '你好');
      assert.equal(persisted, undefined);
      await client
        .post(path)
        .set('Authorization', 'Bearer test-token')
        .send({ content: 'again' })
        .expect(409);
      releaseUpstream();
      assert.equal((await reply).content, '你好，小明');
      assert.deepEqual(persisted, {
        content: '你好，小明',
        status: 'completed',
      });
      assert.equal(requests[0].url, '/v1/chat/completions');
      assert.equal(requests[0].headers.authorization, 'Bearer test-key');
      assert.equal(requests[0].body.stream, true);
      assert.equal(requests[0].body.model, 'test-model');
    },
  );

  await t.test(
    'second request includes successful history and current prompt exactly once',
    async () => {
      mode = 'normal';
      await invoke({ content: '我叫什么？' });
      assert.deepEqual(requests.at(-1).body.messages, [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '我叫小明' },
        { role: 'assistant', content: '你好，小明' },
        { role: 'user', content: '我叫什么？' },
      ]);
    },
  );

  await t.test(
    'upstream rejection is a JSON 502 and provider details stay private',
    async () => {
      mode = 'reject';
      const result = await client
        .post(path)
        .set('Authorization', 'Bearer test-token')
        .send({ content: 'hello' })
        .expect(502);
      assert.match(result.headers['content-type'], /application\/json/);
      assert.ok(!result.text.includes('SECRET'));
      assert.equal(persisted.status, 'failed');
      assert.equal(active, false);
    },
  );

  await t.test(
    'malformed or prematurely ended streams fail and preserve partial output',
    async () => {
      for (const value of ['malformed', 'incomplete']) {
        mode = value;
        await assert.rejects(invoke(), /模型输出中断/);
        assert.equal(persisted.status, 'failed');
        assert.equal(
          persisted.content,
          value === 'incomplete' ? '部分回复' : '',
        );
        assert.equal(active, false);
      }
    },
  );

  await t.test(
    'timeout aborts upstream and releases the conversation',
    async () => {
      mode = 'timeout';
      process.env.AI_TIMEOUT_MS = '1000';
      const closed = new Promise((resolve) => {
        upstreamClosed = resolve;
      });
      await assert.rejects(invoke(), /超时/);
      await closed;
      assert.equal(persisted.status, 'failed');
      assert.equal(active, false);
      process.env.AI_TIMEOUT_MS = '5000';
    },
  );

  await t.test(
    'browser cancellation aborts upstream and saves cancelled partial content',
    async () => {
      mode = 'cancel';
      const controller = new AbortController();
      const closed = new Promise((resolve) => {
        upstreamClosed = resolve;
      });
      await assert.rejects(
        invoke({
          signal: controller.signal,
          onDelta: () => controller.abort(),
        }),
        { name: 'AbortError' },
      );
      await closed;
      // The upstream disconnect can race the short asynchronous persistence step.
      const deadline = Date.now() + 3000;
      while (active && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(persisted.status, 'cancelled');
      assert.equal(persisted.content, '开始');
      assert.equal(active, false);
    },
  );
});
