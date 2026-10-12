import { BadRequestException } from '@nestjs/common';

// 入门版按 Unicode 字符切片；overlap 是相邻两片重复的字符数，不是 token 数。
export function splitText(
  text: string,
  chunkSize: number,
  chunkOverlap: number,
) {
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < 100 ||
    chunkSize > 2000 ||
    !Number.isInteger(chunkOverlap) ||
    chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  )
    throw new BadRequestException(
      '切片长度需为 100–2000，重叠长度需小于切片长度',
    );
  const characters = Array.from(
    text
      .replace(/\r\n?/g, '\n')
      .replace(/^\uFEFF/, '')
      .trim(),
  );
  if (!characters.length) throw new BadRequestException('文件内容不能为空');
  const chunks: { position: number; content: string; charCount: number }[] = [];
  for (
    let start = 0;
    start < characters.length;
    start += chunkSize - chunkOverlap
  ) {
    const content = characters.slice(start, start + chunkSize).join('');
    chunks.push({
      position: chunks.length + 1,
      content,
      charCount: Array.from(content).length,
    });
    if (start + chunkSize >= characters.length) break;
  }
  return chunks;
}
