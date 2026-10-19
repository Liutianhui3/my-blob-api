import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';
import { XMLParser } from 'fast-xml-parser';
import type { Attachment } from './attachments.js';
import { documentMimes } from './attachments.js';

export async function extractDocument(
  file?: Express.Multer.File,
): Promise<Attachment> {
  if (!file?.buffer?.length || file.buffer.length > 10 * 1024 * 1024)
    throw new BadRequestException('请选择非空文件，单个文件最大 10 MB');
  // Multer decodes multipart header names as latin1; browsers send UTF-8 bytes.
  let filename = file.originalname;
  if (/^[\u0000-\u00ff]*$/.test(filename)) {
    const decoded = Buffer.from(filename, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd')) filename = decoded;
  }
  const extension = extname(filename).toLowerCase();
  const mime = documentMimes[extension];
  if (!mime || filename.length > 255)
    throw new BadRequestException(
      '文档支持 DOCX、XLSX、PDF、PPTX；旧版 DOC/XLS/PPT 请另存为新版格式',
    );
  try {
    let text = '';
    if (extension === '.pdf') {
      if (file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error();
      const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
      try {
        text = (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    } else {
      // Check declared uncompressed sizes before invoking Office parsers.
      const zip = await JSZip.loadAsync(file.buffer);
      let expanded = 0;
      for (const entry of Object.values(zip.files)) {
        expanded +=
          (entry as unknown as { _data?: { uncompressedSize?: number } })._data
            ?.uncompressedSize ?? 0;
        if (expanded > 30 * 1024 * 1024)
          throw new BadRequestException('文档解压后过大，请拆分后上传');
      }
      if (extension === '.docx') {
        if (!zip.file('word/document.xml')) throw new Error();
        text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
      } else if (extension === '.xlsx') {
        if (!zip.file('xl/workbook.xml')) throw new Error();
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(
          new Uint8Array(file.buffer) as unknown as Parameters<
            typeof workbook.xlsx.load
          >[0],
        );
        const chunks: string[] = [];
        let cells = 0;
        workbook.eachSheet((sheet) => {
          chunks.push(`工作表：${sheet.name}`);
          sheet.eachRow((row) => {
            const values: string[] = [];
            row.eachCell({ includeEmpty: true }, (cell) => {
              if (++cells > 100000)
                throw new BadRequestException('表格过大，请拆分后上传');
              values.push(cell.text.replace(/[\t\r\n]+/g, ' '));
            });
            chunks.push(values.join('\t'));
          });
        });
        text = chunks.join('\n');
      } else {
        const parser = new XMLParser({
          ignoreAttributes: true,
          parseTagValue: false,
        });
        const slides = Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort(
            (a, b) =>
              Number(a.match(/slide(\d+)/)![1]) -
              Number(b.match(/slide(\d+)/)![1]),
          );
        if (!slides.length) throw new Error();
        const chunks: string[] = [];
        function collect(value: unknown): string[] {
          if (Array.isArray(value)) return value.flatMap(collect);
          if (!value || typeof value !== 'object') return [];
          return Object.entries(value).flatMap(([key, item]) =>
            key === 'a:t'
              ? (Array.isArray(item) ? item : [item]).map(String)
              : collect(item),
          );
        }
        for (const [index, slide] of slides.entries())
          chunks.push(
            `幻灯片 ${index + 1}\n${collect(parser.parse(await zip.file(slide)!.async('string'))).join('\n')}`,
          );
        text = chunks.join('\n\n');
      }
    }
    text = text.replace(/\0/g, '').trim();
    if (!text)
      throw new BadRequestException(
        '未能提取文字；扫描版 PDF 或纯图片文档请改为上传截图',
      );
    if (Buffer.byteLength(text) > 100000)
      throw new BadRequestException('提取文字超过 100 KB，请拆分文件后上传');
    return { name: filename, type: 'document', mime, text };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      '文件解析失败，请检查格式是否正确、是否损坏或加密',
    );
  }
}
