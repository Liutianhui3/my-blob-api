import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadRemoteImage } from '../dist/chat/image-download.js';
import { ChatService } from '../dist/chat/chat.service.js';
import { ChatController } from '../dist/chat/chat.controller.js';
import { AiService } from '../dist/ai/ai.service.js';
import { AuthGuard } from '../dist/auth/guards/auth.guard.js';
import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import request from 'supertest';

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=',
  'base64',
);
const imageUrl = 'https://pub-test.r2.dev/image.png';
const id = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';

test('authenticated image download endpoint returns a file and rejects non-owners', async (t) => {
  let downloaded = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    downloaded++;
    return new Response(pixel);
  });
  const service = new ChatService(
    {
      pool: {
        query: async (_sql, params) => ({
          rows:
            params[1] === 'owner'
              ? [{ content: `![AI 生成的图片](<${imageUrl}>)` }]
              : [],
        }),
      },
    },
    {},
  );
  const module = await Test.createTestingModule({
    controllers: [ChatController],
    providers: [
      { provide: ChatService, useValue: service },
      { provide: AiService, useValue: {} },
    ],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate(context) {
        const req = context.switchToHttp().getRequest();
        if (!req.headers.authorization) throw new UnauthorizedException();
        req.user = {
          id: req.headers.authorization === 'Bearer owner' ? 'owner' : 'other',
        };
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  try {
    const endpoint = `/api/conversations/${id}/messages/${messageId}/images/download`;
    await request(app.getHttpServer())
      .post(endpoint)
      .send({ url: imageUrl })
      .expect(401);
    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer other')
      .send({ url: imageUrl })
      .expect(404);
    assert.equal(downloaded, 0);
    const result = await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer owner')
      .send({ url: imageUrl })
      .expect(201);
    assert.equal(result.headers['content-type'], 'image/png');
    assert.match(
      result.headers['content-disposition'],
      /attachment; filename="AI-image.png"/,
    );
    assert.deepEqual(result.body, pixel);
  } finally {
    await app.close();
  }
});

test('image download requires conversation ownership and a matching stored assistant image', async () => {
  const calls = [];
  let rows = [{ content: `![AI 生成的图片](<${imageUrl}>)` }];
  const service = new ChatService(
    {
      pool: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows };
        },
      },
    },
    {},
  );
  assert.equal(
    await service.imageForDownload('owner', id, messageId, { url: imageUrl }),
    imageUrl,
  );
  assert.deepEqual(calls[0].params, [id, 'owner', messageId]);
  assert.match(calls[0].sql, /c.user_id = \$2/);
  await assert.rejects(
    () =>
      service.imageForDownload('owner', id, messageId, {
        url: 'https://pub-test.r2.dev/other.png',
      }),
    /图片不存在/,
  );
  rows = [];
  await assert.rejects(
    () =>
      service.imageForDownload('other-user', id, messageId, { url: imageUrl }),
    /无权下载/,
  );
});

test('backend downloads image bytes without browser CORS or forwarding credentials', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), imageUrl);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'manual');
    return new Response(pixel, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  });
  const image = await downloadRemoteImage(
    imageUrl,
    new AbortController().signal,
  );
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(image.bytes, pixel);
});

test('blocks arbitrary hosts and redirects to local or unapproved addresses', async (t) => {
  let called = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    called++;
    return new Response(null, {
      status: 302,
      headers: { Location: 'http://127.0.0.1/private' },
    });
  });
  for (const url of [
    'http://127.0.0.1/file.png',
    'https://example.com/image.png',
    'https://pub-test.r2.dev:444/a.png',
    'https://user:secret@pub-test.r2.dev/a.png',
  ])
    await assert.rejects(() =>
      downloadRemoteImage(url, new AbortController().signal),
    );
  assert.equal(called, 0);
  await assert.rejects(() =>
    downloadRemoteImage(imageUrl, new AbortController().signal),
  );
  assert.equal(called, 1);
});

test('rejects HTML masquerading as images and expired image links', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('<html>error</html>', {
        headers: { 'Content-Type': 'image/png' },
      }),
  );
  await assert.rejects(
    () => downloadRemoteImage(imageUrl, new AbortController().signal),
    /不是有效/,
  );
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  await assert.rejects(
    () => downloadRemoteImage(imageUrl, new AbortController().signal),
    /已过期/,
  );
});
