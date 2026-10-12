import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitText } from '../dist/knowledge/split-text.js';
import { KnowledgeService } from '../dist/knowledge/knowledge.service.js';
import { decodeFilename } from '../dist/knowledge/filename.js';

test('multipart filenames recover UTF-8 while preserving decoded Unicode and Latin-1', () => {
  for (const name of ['笔记产品说明.md', '文档😀.txt', 'café.md']) {
    assert.equal(
      decodeFilename(Buffer.from(name, 'utf8').toString('latin1')),
      name,
    );
    assert.equal(decodeFilename(name), name);
  }
  assert.equal(decodeFilename('notes.md'), 'notes.md');
  assert.equal(decodeFilename('über.md'), 'über.md');
  assert.equal(decodeFilename('invalid\xff.md'), 'invalid\xff.md');
});

test('character chunks preserve Unicode, overlap, and do not add a redundant tail', () => {
  const text = '😀'.repeat(240);
  const chunks = splitText(text, 100, 20);
  assert.deepEqual(
    chunks.map((x) => x.charCount),
    [100, 100, 80],
  );
  assert.equal(chunks[0].content.slice(-40), chunks[1].content.slice(0, 40));
  assert.equal(splitText('a'.repeat(180), 100, 20).length, 2);
  for (const [size, overlap] of [
    [0, 0],
    [100, 100],
    [100, -1],
    [100.5, 0],
  ])
    assert.throws(() => splitText(text, size, overlap));
  assert.throws(() => splitText(' \n ', 100, 0));
});

test('ownership is checked before reading, uploading or deleting documents', async () => {
  const service = new KnowledgeService({
    pool: { query: async () => ({ rowCount: 0, rows: [] }) },
  });
  const id = '11111111-1111-4111-8111-111111111111';
  for (const operation of [
    () => service.documents('other', id),
    () => service.upload('other', id, undefined, {}),
    () => service.chunks('other', id, id),
    () => service.removeDocument('other', id, id),
  ])
    await assert.rejects(operation, /知识库不存在/);
});

test('upload rejects binary files, invalid encoding and oversized files before writing', async () => {
  const service = new KnowledgeService({
    pool: { query: async () => ({ rowCount: 1, rows: [{}] }) },
  });
  const id = '11111111-1111-4111-8111-111111111111';
  const file = {
    originalname: 'notes.txt',
    buffer: Buffer.from('hello'),
    size: 5,
  };
  await assert.rejects(
    () => service.upload('user', id, { ...file, originalname: 'file.pdf' }, {}),
    /TXT/,
  );
  await assert.rejects(
    () => service.upload('user', id, { ...file, size: 1024 * 1024 + 1 }, {}),
    /1 MB/,
  );
  await assert.rejects(
    () =>
      service.upload('user', id, { ...file, buffer: Buffer.from([0xff]) }, {}),
    /UTF-8/,
  );
  await assert.rejects(
    () =>
      service.upload('user', id, { ...file, buffer: Buffer.from('x\0') }, {}),
    /二进制/,
  );
});
