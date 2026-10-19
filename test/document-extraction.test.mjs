import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { extractDocument } from '../dist/chat/document-extraction.js';
import { validateAttachments } from '../dist/chat/attachments.js';
import { AiService } from '../dist/ai/ai.service.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { UnauthorizedException } from '@nestjs/common';
import { ChatController } from '../dist/chat/chat.controller.js';
import { ChatService } from '../dist/chat/chat.service.js';
import { AuthGuard } from '../dist/auth/guards/auth.guard.js';

test('multipart extraction route enforces authentication and handles Chinese filenames', async () => {
  const module = await Test.createTestingModule({
    controllers: [ChatController],
    providers: [
      { provide: ChatService, useValue: {} },
      { provide: AiService, useValue: {} },
    ],
  })
    .overrideGuard(AuthGuard)
    .useValue({
      canActivate(context) {
        if (
          context.switchToHttp().getRequest().headers.authorization !==
          'Bearer test'
        )
          throw new UnauthorizedException();
        return true;
      },
    })
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  try {
    const endpoint = '/api/conversations/attachments/extract';
    await request(app.getHttpServer()).post(endpoint).expect(401);
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1').addRow(['中文内容', 123]);
    const response = await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer test')
      .attach(
        'file',
        Buffer.from(await workbook.xlsx.writeBuffer()),
        '中文报表.xlsx',
      )
      .expect(201);
    assert.equal(response.body.name, '中文报表.xlsx');
    assert.match(response.body.text, /中文内容\t123/);
    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', 'Bearer test')
      .expect(400);
  } finally {
    await app.close();
  }
});

async function zipFile(name, entries) {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(entries)) zip.file(path, text);
  return {
    originalname: name,
    buffer: await zip.generateAsync({ type: 'nodebuffer' }),
  };
}

test('DOCX extracts text and restores UTF-8 multipart filename', async () => {
  const name = '中文文档.docx';
  const file = await zipFile(Buffer.from(name).toString('latin1'), {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml':
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>你好，Word 文档</w:t></w:r></w:p></w:body></w:document>',
  });
  const attachment = await extractDocument(file);
  assert.equal(attachment.name, name);
  assert.match(attachment.text, /你好，Word 文档/);
  const ai = new AiService();
  ai.configuration = () => ({ systemPrompt: 'test', contextMaxBytes: 24000 });
  assert.match(
    ai.buildMessages([], '总结', [], validateAttachments([attachment])).at(-1)
      .content,
    /你好，Word/,
  );
});

test('XLSX preserves sheet boundaries, blank columns and values', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('销售').addRows([
    ['产品', null, '金额'],
    ['苹果', null, 123],
  ]);
  const attachment = await extractDocument({
    originalname: '数据.xlsx',
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  });
  assert.equal(attachment.name, '数据.xlsx');
  assert.match(attachment.text, /工作表：销售/);
  assert.match(attachment.text, /苹果\t\t123/);
});

test('PPTX sorts slides numerically and extracts text only', async () => {
  const file = await zipFile('演示.pptx', {
    'ppt/slides/slide2.xml':
      '<p:sld><a:p><a:t>第二页 &amp; 内容</a:t></a:p></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:t>第一页</a:t></a:p></p:sld>',
  });
  const attachment = await extractDocument(file);
  assert.match(attachment.text, /幻灯片 1\n第一页/);
  assert.match(attachment.text, /幻灯片 2\n第二页 & 内容/);
});

test('PDF extracts text from a real PDF byte stream', async () => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 12 Tf 72 720 Td (Hello PDF document) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => String(offset).padStart(10, '0') + ' 00000 n ')
    .join(
      '\n',
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const attachment = await extractDocument({
    originalname: 'sample.pdf',
    buffer: Buffer.from(pdf),
  });
  assert.match(attachment.text, /Hello PDF document/);
});

test('rejects damaged, empty, oversized and unsupported files', async () => {
  for (const file of [
    undefined,
    { originalname: 'a.doc', buffer: Buffer.from('x') },
    { originalname: 'a.pdf', buffer: Buffer.from('invalid') },
    { originalname: 'a.xlsx', buffer: Buffer.from('invalid') },
    { originalname: 'a.pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
  ])
    await assert.rejects(() => extractDocument(file));
});
