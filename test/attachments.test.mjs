import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachments } from '../dist/chat/attachments.js';
import { AiService } from '../dist/ai/ai.service.js';
const image = {
  name: 'pixel.png',
  type: 'image',
  mime: 'image/png',
  data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY2kAAAAASUVORK5CYII=',
};
const document = {
  name: 'notes.md',
  type: 'document',
  mime: 'text/plain',
  text: '这是附件内容',
};
test('attachment validation rejects unsupported files, forged images, excess count and oversized documents', () => {
  assert.equal(validateAttachments([image, document]).length, 2);
  assert.throws(() => validateAttachments(Array(5).fill(image)));
  assert.throws(() =>
    validateAttachments([{ ...image, data: 'data:image/png;base64,aGVsbG8=' }]),
  );
  assert.throws(() => validateAttachments([{ ...document, name: 'file.exe' }]));
  assert.equal(
    validateAttachments([{ ...document, name: 'file.pdf' }])[0].mime,
    'application/pdf',
  );
  assert.throws(() =>
    validateAttachments([{ ...document, text: 'a'.repeat(100001) }]),
  );
  assert.throws(() => validateAttachments([{ ...document, text: '\0' }]));
});
test('model receives image_url content and document text in current and historical user turns', () => {
  const ai = new AiService();
  ai.configuration = () => ({
    systemPrompt: 'assistant',
    contextMaxBytes: 24000,
  });
  const messages = ai.buildMessages(
    [{ user: '之前', assistant: '答复', attachments: [image, document] }],
    '分析附件',
    [],
    [image, document],
  );
  const last = messages.at(-1);
  assert.equal(last.content[1].type, 'image_url');
  assert.equal(last.content[1].image_url.url, image.data);
  assert.match(last.content[0].text, /这是附件内容/);
  assert.match(messages[1].content[0].text, /notes.md/);
  assert.equal(messages[1].content[1].image_url.url, image.data);
  assert.equal(ai.buildMessages([], '纯文本').at(-1).content, '纯文本');
});
