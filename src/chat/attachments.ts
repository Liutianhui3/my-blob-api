import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';
export const documentMimes: Record<string, string> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export interface Attachment {
  name: string;
  type: 'image' | 'document';
  mime: string;
  data?: string;
  text?: string;
}
export function validateAttachments(value: unknown): Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4)
    throw new BadRequestException('每条消息最多 4 个附件');
  let total = 0;
  return value.map((item) => {
    if (
      !item ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 255
    )
      throw new BadRequestException('附件名称无效');
    if (item.type === 'document') {
      if (
        !/\.(txt|md|docx|xlsx|pdf|pptx)$/i.test(item.name) ||
        typeof item.text !== 'string' ||
        !item.text.trim() ||
        item.text.includes('\0') ||
        Buffer.byteLength(item.text) > 100000
      )
        throw new BadRequestException(
          '文档支持 TXT、Markdown、DOCX、XLSX、PDF、PPTX，提取文字最大 100 KB',
        );
      total += Buffer.byteLength(item.text);
      return {
        name: item.name,
        type: 'document',
        mime: documentMimes[extname(item.name).toLowerCase()] ?? 'text/plain',
        text: item.text,
      };
    }
    if (
      item.type !== 'image' ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(item.mime) ||
      typeof item.data !== 'string'
    )
      throw new BadRequestException('图片仅支持 PNG / JPEG / WebP');
    const prefix = `data:${item.mime};base64,`;
    const encoded = item.data.slice(prefix.length);
    if (
      !item.data.startsWith(prefix) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw new BadRequestException('图片数据无效');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== encoded)
      throw new BadRequestException('图片最大 2 MB');
    const valid =
      item.mime === 'image/png'
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : item.mime === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' &&
            bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new BadRequestException('图片内容与格式不符');
    total += bytes.length;
    if (total > 6 * 1024 * 1024)
      throw new BadRequestException('附件总大小不能超过 6 MB');
    return { name: item.name, type: 'image', mime: item.mime, data: item.data };
  });
}
