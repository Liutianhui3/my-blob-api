import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiService } from '../dist/ai/ai.service.js';
import { sseData } from '../dist/ai/sse.js';

test('SSE decoder handles byte-split Chinese, CRLF, comments and multiline events', async () => {
  const encoded = new TextEncoder().encode(
    ': heartbeat\r\ndata: {"text":"你好"}\r\ndata: second line\r\n\r\ndata: [DONE]\n\n',
  );
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (offset === encoded.length) return controller.close();
      controller.enqueue(encoded.slice(offset, ++offset));
    },
  });
  const events = [];
  for await (const data of sseData(body)) events.push(data);
  assert.deepEqual(events, ['{"text":"你好"}\nsecond line', '[DONE]']);
});

test('context preserves the current input once and drops whole older turns within budget', (t) => {
  const names = [
    'AI_API_KEY',
    'AI_MODEL',
    'AI_MODELS',
    'AI_BASE_URL',
    'AI_CONTEXT_MAX_BYTES',
    'AI_SYSTEM_PROMPT',
    'AI_TIMEOUT_MS',
  ];
  const original = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, {
    AI_API_KEY: 'test-key',
    AI_MODEL: 'test-model',
    AI_MODELS: '',
    AI_BASE_URL: 'http://localhost/v1',
    AI_CONTEXT_MAX_BYTES: '1024',
    AI_SYSTEM_PROMPT: '你是助手',
    AI_TIMEOUT_MS: '5000',
  });
  const ai = new AiService();
  const messages = ai.buildMessages(
    [
      { user: 'old'.repeat(1000), assistant: 'old answer' },
      { user: '我叫小明', assistant: '你好，小明' },
    ],
    '我叫什么？',
  );
  assert.deepEqual(
    messages.map(({ role }) => role),
    ['system', 'user', 'assistant', 'user'],
  );
  assert.equal(messages[1].content, '我叫小明');
  assert.equal(
    messages.filter(({ content }) => content === '我叫什么？').length,
    1,
  );
  assert.throws(() => ai.buildMessages([], '长'.repeat(1000)), /输入预算/);
  process.env.AI_TIMEOUT_MS = 'invalid';
  assert.throws(() => ai.configuration(), /AI_TIMEOUT_MS 配置无效/);
  process.env.AI_TIMEOUT_MS = '5000';
  delete process.env.AI_API_KEY;
  assert.throws(() => ai.configuration(), /请配置/);
});
