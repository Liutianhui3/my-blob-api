import type {} from 'multer';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { splitText } from './split-text.js';
import { EmbeddingService } from './embedding.service.js';
import { decodeFilename } from './filename.js';

const documentFields =
  'id, name, size, chunk_size AS "chunkSize", chunk_overlap AS "chunkOverlap", chunk_count AS "chunkCount", created_at AS "createdAt"';

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmbeddingService) private readonly embedding: EmbeddingService,
  ) {}

  async list(userId: string) {
    const result = await this.database.pool.query(
      `SELECT k.id, k.name, k.description,
      k.created_at AS "createdAt", COUNT(d.id)::int AS "documentCount",
      COALESCE(SUM(d.chunk_count), 0)::int AS "chunkCount"
      FROM knowledge_bases k LEFT JOIN knowledge_documents d ON d.base_id = k.id
      WHERE k.user_id = $1 GROUP BY k.id ORDER BY k.created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  async create(
    userId: string,
    body: { name?: unknown; description?: unknown },
  ) {
    if (
      !body ||
      typeof body.name !== 'string' ||
      !body.name.trim() ||
      body.name.trim().length > 80
    )
      throw new BadRequestException('知识库名称需为 1–80 个字符');
    if (
      body.description !== undefined &&
      (typeof body.description !== 'string' || body.description.length > 300)
    )
      throw new BadRequestException('描述最多 300 个字符');
    const result = await this.database.pool.query(
      `INSERT INTO knowledge_bases (id, user_id, name, description)
      VALUES ($1, $2, $3, $4) RETURNING id, name, description, created_at AS "createdAt"`,
      [randomUUID(), userId, body.name.trim(), body.description || ''],
    );
    return { ...result.rows[0], documentCount: 0, chunkCount: 0 };
  }

  private async owned(userId: string, id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new BadRequestException('知识库 ID 无效');
    const result = await this.database.pool.query(
      'SELECT id FROM knowledge_bases WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (!result.rowCount) throw new NotFoundException('知识库不存在');
  }

  async documents(userId: string, id: string) {
    await this.owned(userId, id);
    const result = await this.database.pool.query(
      `SELECT ${documentFields} FROM knowledge_documents WHERE base_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    return result.rows;
  }

  async upload(
    userId: string,
    id: string,
    file: Express.Multer.File | undefined,
    body: { chunkSize?: string; chunkOverlap?: string },
  ) {
    await this.owned(userId, id);
    if (!file || !/\.(txt|md)$/i.test(file.originalname))
      throw new BadRequestException('请选择 TXT 或 Markdown 文件');
    if (!file.size || file.size > 1024 * 1024)
      throw new BadRequestException('文件需为 1 B–1 MB');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw new BadRequestException('请上传 UTF-8 编码的文本文件');
    }
    if (text.includes('\0'))
      throw new BadRequestException('文件包含二进制内容');
    const chunkSize = Number(body.chunkSize ?? 500);
    const chunkOverlap = Number(body.chunkOverlap ?? 50);
    const chunks = splitText(text, chunkSize, chunkOverlap);
    // 一次事务保存文档和所有切片：任何一步失败都会回滚，不会留下半份文档。
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const documentId = randomUUID();
      const result = await client.query(
        `INSERT INTO knowledge_documents
        (id, base_id, name, size, content, chunk_size, chunk_overlap, chunk_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${documentFields}`,
        [
          documentId,
          id,
          Array.from(decodeFilename(file.originalname)).slice(0, 255).join(''),
          file.size,
          text,
          chunkSize,
          chunkOverlap,
          chunks.length,
        ],
      );
      // 批量写入，避免每个切片都单独发一次 SQL。
      await client.query(
        `INSERT INTO knowledge_chunks (id, document_id, position, content, char_count)
        SELECT gen_random_uuid(), $1, x.position, x.content, x."charCount"
        FROM jsonb_to_recordset($2::jsonb) AS x(position int, content text, "charCount" int)`,
        [documentId, JSON.stringify(chunks)],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async chunks(
    userId: string,
    baseId: string,
    documentId: string,
    pageValue?: string,
  ) {
    await this.owned(userId, baseId);
    if (!/^[0-9a-f-]{36}$/i.test(documentId))
      throw new BadRequestException('文档 ID 无效');
    const page = Number(pageValue ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000)
      throw new BadRequestException('页码无效');
    const document = await this.database.pool.query(
      'SELECT chunk_count FROM knowledge_documents WHERE id=$1 AND base_id=$2',
      [documentId, baseId],
    );
    if (!document.rowCount) throw new NotFoundException('文档不存在');
    const result = await this.database.pool.query(
      `SELECT id, position, content, char_count AS "charCount"
      FROM knowledge_chunks WHERE document_id=$1 ORDER BY position LIMIT 20 OFFSET $2`,
      [documentId, (page - 1) * 20],
    );
    return { items: result.rows, total: document.rows[0].chunk_count, page };
  }

  async embedDocument(userId: string, baseId: string, documentId: string) {
    await this.owned(userId, baseId);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        documentId,
      )
    )
      throw new BadRequestException('文档 ID 无效');
    const result = await this.database.pool.query(
      `SELECT c.id, c.content FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
       WHERE d.id=$1 AND d.base_id=$2 ORDER BY c.position`,
      [documentId, baseId],
    );
    if (!result.rowCount) throw new NotFoundException('文档不存在');
    const { model, vectors } = await this.embedding.embed(
      result.rows.map((row) => row.content),
    );
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const document = await client.query(
        'SELECT id FROM knowledge_documents WHERE id=$1 AND base_id=$2 FOR UPDATE',
        [documentId, baseId],
      );
      if (!document.rowCount) throw new NotFoundException('文档不存在');
      for (let i = 0; i < result.rows.length; i++) {
        await client.query(
          'UPDATE knowledge_chunks SET embedding=$1::vector, embedding_model=$2 WHERE id=$3',
          [JSON.stringify(vectors[i]), model, result.rows[i].id],
        );
      }
      await client.query('COMMIT');
      return {
        documentId,
        model,
        dimensions: 1024,
        embeddedChunks: vectors.length,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async search(
    userId: string,
    baseId: string,
    body: { query?: unknown; limit?: unknown },
  ) {
    await this.owned(userId, baseId);
    if (
      !body ||
      typeof body.query !== 'string' ||
      !body.query.trim() ||
      Array.from(body.query).length > 2000
    )
      throw new BadRequestException('搜索问题需为 1–2000 个字符');
    const limit = body.limit ?? 5;
    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new BadRequestException('limit 需为 1–20 的整数');
    const { model, vectors } = await this.embedding.embed([body.query.trim()]);
    const result = await this.database.pool.query(
      `SELECT c.id, c.document_id AS "documentId", d.name AS "documentName", c.position, c.content,
       1 - (c.embedding <=> $1::vector) AS score
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
       JOIN knowledge_bases k ON k.id=d.base_id
       WHERE k.id=$2 AND k.user_id=$3 AND c.embedding IS NOT NULL AND c.embedding_model=$4
       ORDER BY c.embedding <=> $1::vector LIMIT $5`,
      [JSON.stringify(vectors[0]), baseId, userId, model, limit],
    );
    return { items: result.rows, model };
  }

  async removeDocument(userId: string, baseId: string, documentId: string) {
    await this.owned(userId, baseId);
    if (!/^[0-9a-f-]{36}$/i.test(documentId))
      throw new BadRequestException('文档 ID 无效');
    const result = await this.database.pool.query(
      'DELETE FROM knowledge_documents WHERE id=$1 AND base_id=$2 RETURNING id',
      [documentId, baseId],
    );
    if (!result.rowCount) throw new NotFoundException('文档不存在');
    return { id: documentId };
  }
}
