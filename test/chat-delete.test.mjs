import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatService } from '../dist/chat/chat.service.js';

const id = '11111111-1111-4111-8111-111111111111';
test('delete validates UUID, scopes deletion to owner, and returns 404 for missing or foreign conversations', async () => {
  const calls = [];
  let rowCount = 1;
  const service = new ChatService({ pool: { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount, rows: [{ id }] }; } } }, {});
  await assert.rejects(() => service.remove('owner', 'invalid'), /UUID/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.remove('owner', id), { id });
  assert.match(calls[0].sql, /DELETE FROM conversations WHERE id = \$1 AND user_id = \$2/);
  assert.deepEqual(calls[0].params, [id, 'owner']);
  rowCount = 0;
  await assert.rejects(() => service.remove('other', id), /会话不存在/);
});
