import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { modelCatalog, resolveGeneration } from '../dist/ai/model-catalog.js';
import { AiService } from '../dist/ai/ai.service.js';
import { ChatService } from '../dist/chat/chat.service.js';

const catalog = [
  {
    id: 'model-a',
    label: 'A',
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
  {
    id: 'model-b',
    label: 'B',
    reasoningEfforts: ['low', 'high', 'max'],
    tokenParameter: 'max_completion_tokens',
  },
  { id: 'plain-model', label: 'Plain' },
];
function environment(t, values) {
  const original = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('model catalog validates capabilities, defaults, allowlist and rejects arbitrary fields before database writes', async (t) => {
  environment(t, {
    AI_MODELS: JSON.stringify(catalog),
    AI_MODEL: 'model-a',
    AI_API_KEY: 'test-key',
    AI_BASE_URL: 'http://localhost/v1',
  });
  assert.equal(resolveGeneration('model-a').reasoningEffort, 'medium');
  assert.equal(
    resolveGeneration('model-a', { model: 'model-b', reasoningEffort: 'max' })
      .tokenParameter,
    'max_completion_tokens',
  );
  assert.equal(
    resolveGeneration('model-a', {
      model: 'plain-model',
      reasoningEffort: 'auto',
    }).reasoningEffort,
    'auto',
  );
  for (const selection of [
    { model: 'unlisted' },
    { model: 'https://untrusted.example' },
    { model: null },
    { reasoningEffort: null },
    { reasoningEffort: 'max' },
    { model: 'plain-model', reasoningEffort: 'high' },
  ]) {
    assert.throws(
      () => resolveGeneration('model-a', selection),
      (error) => error.getStatus() === 400,
    );
  }
  let connected = false;
  const chats = new ChatService(
    {
      pool: {
        connect() {
          connected = true;
          throw new Error('Unexpected database write');
        },
      },
    },
    new AiService(),
  );
  await assert.rejects(
    chats.prepare(
      'owner',
      '11111111-1111-4111-8111-111111111111',
      { content: 'hello', model: 'unlisted' },
      new AbortController().signal,
    ),
    (error) => error.getStatus() === 400,
  );
  assert.equal(connected, false);
  const publicCatalog = new AiService().models();
  assert.equal(publicCatalog.models.length, 3);
  assert.ok(!JSON.stringify(publicCatalog).includes('test-key'));
  assert.equal(publicCatalog.models[1].tokenParameter, undefined);
  for (const value of [
    '{}',
    '[]',
    JSON.stringify([...catalog, catalog[0]]),
    JSON.stringify([{ id: 'model-a', reasoningEfforts: ['unknown'] }]),
    JSON.stringify([{ id: 'model-b' }]),
  ]) {
    process.env.AI_MODELS = value;
    assert.throws(
      () => modelCatalog('model-a'),
      (error) => error.getStatus() === 503,
    );
  }
  process.env.AI_MODELS = '';
  assert.deepEqual(modelCatalog('legacy')[0].reasoningEfforts, []);
});

test('selected models, reasoning effort and model-specific token parameter reach upstream; auto omits effort', async (t) => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => {
    upstream.closeAllConnections();
    return new Promise((resolve) => upstream.close(resolve));
  });
  environment(t, {
    AI_API_KEY: 'test-key',
    AI_MODEL: 'model-a',
    AI_MODELS: JSON.stringify(catalog),
    AI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
    AI_MAX_TOKENS: '256',
  });
  const ai = new AiService();
  const history = [{ role: 'user', content: 'context' }];
  for (const selection of [
    { model: 'model-a', reasoningEffort: 'high' },
    { model: 'model-b', reasoningEffort: 'max' },
    { model: 'model-b', reasoningEffort: 'auto' },
  ]) {
    const stream = await ai.openStream(
      history,
      new AbortController().signal,
      ai.resolveGeneration(selection),
    );
    const chunks = [];
    for await (const item of stream) chunks.push(item);
    assert.equal(chunks[0].text, 'ok');
  }
  assert.equal(received[0].model, 'model-a');
  assert.equal(received[0].reasoning_effort, 'high');
  assert.equal(received[0].max_tokens, 256);
  assert.equal(received[1].model, 'model-b');
  assert.equal(received[1].reasoning_effort, 'max');
  assert.equal(received[1].max_completion_tokens, 256);
  assert.equal(received[1].max_tokens, undefined);
  assert.equal(received[2].reasoning_effort, undefined);
  assert.deepEqual(received[2].messages, history);
});
