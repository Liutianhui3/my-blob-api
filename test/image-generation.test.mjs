import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AiService } from '../dist/ai/ai.service.js';
import { safeImageUrl } from '../dist/ai/image-generation.js';

const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=';
test('image tool arguments stream in fragments, call image API, and return displayable image content', async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ url: req.url, body });
    if (req.url === '/v1/images/generations') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: pixel }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call1',
              type: 'function',
              function: { name: 'generate_image', arguments: '{"prompt":' },
            },
          ],
        },
      },
      {
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"a cat"}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ])
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const ai = new AiService();
    ai.configuration = () => ({
      apiKey: 'test',
      url: new URL(
        `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      ),
      maxTokens: 1000,
      model: 'test',
      contextMaxBytes: 24000,
    });
    const stream = await ai.openStream(
      [{ role: 'user', content: 'draw a cat' }],
      new AbortController().signal,
      { model: 'test', reasoningEffort: 'auto', tokenParameter: 'max_tokens' },
    );
    const deltas = [];
    for await (const delta of stream) deltas.push(delta);
    assert.match(
      deltas.map((d) => d.text ?? '').join(''),
      /!\[AI 生成的图片\]\(<data:image\/png;base64,/,
    );
    assert.equal(deltas.at(-1).finishReason, 'stop');
    assert.equal(deltas[0].imageGeneration, 'generating');
    assert.equal(calls[0].body.tools[0].function.name, 'generate_image');
    assert.equal(calls[1].url, '/v1/images/generations');
    assert.equal(calls[1].body.prompt, 'a cat');
    assert.equal(calls[1].body.n, 1);
    assert.equal(calls[1].body.size, '1024x1024');
    assert.equal(calls[1].body.quality, 'auto');
    assert.equal(calls[1].body.output_format, 'png');
    assert.equal(calls[1].body.response_format, 'url');
    assert.equal(calls[1].body.stream, undefined);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('native multimodal image deltas render once and unsafe image addresses are rejected', async () => {
  const ai = new AiService();
  const url = `data:image/png;base64,${pixel}`;
  const body = new ReadableStream({
    start(controller) {
      const choices = [
        {
          delta: {
            content: [
              { type: 'text', text: 'Here is an image' },
              { type: 'image_url', image_url: { url } },
            ],
          },
        },
        { delta: { images: [{ image_url: { url } }] }, finish_reason: 'stop' },
      ];
      controller.enqueue(
        new TextEncoder().encode(
          choices
            .map(
              (choice) =>
                `data: ${JSON.stringify({ choices: [{ index: 0, ...choice }] })}\n\n`,
            )
            .join('') + 'data: [DONE]\n\n',
        ),
      );
      controller.close();
    },
  });
  const deltas = [];
  for await (const delta of ai.readCompletion(
    body,
    new AbortController().signal,
    'test',
  ))
    deltas.push(delta);
  const content = deltas.map((d) => d.text ?? '').join('');
  assert.match(content, /Here is an image/);
  assert.equal(content.split('![AI 生成的图片]').length - 1, 1);
  for (const value of [
    'javascript:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'file:///test',
    'https://name:secret@example.com/a.png',
  ])
    assert.equal(safeImageUrl(value), null);
});
