import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { EmbeddingService } from './embedding.service.js';

export interface KnowledgeSource {
  documentName: string;
  position: number;
  content: string;
  score: number;
}

@Injectable()
export class RagService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(EmbeddingService) private readonly embedding: EmbeddingService,
  ) {}

  async retrieve(
    userId: string,
    question: string,
    signal: AbortSignal,
  ): Promise<KnowledgeSource[]> {
    if (!process.env.EMBEDDING_MODEL) return [];
    signal.throwIfAborted();
    const { model } = this.embedding.configuration();
    const available = await this.database.pool.query(
      `SELECT 1 FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
       JOIN knowledge_bases k ON k.id=d.base_id
       WHERE k.user_id=$1 AND c.embedding IS NOT NULL AND c.embedding_model=$2 LIMIT 1`,
      [userId, model],
    );
    if (!available.rowCount) return [];
    const { vectors } = await this.embedding.embed([question], signal);
    signal.throwIfAborted();
    const result = await this.database.pool.query<KnowledgeSource>(
      `SELECT d.name AS "documentName", c.position, c.content, 1-(c.embedding <=> $1::vector) AS score
       FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
       JOIN knowledge_bases k ON k.id=d.base_id
       WHERE k.user_id=$2 AND c.embedding IS NOT NULL AND c.embedding_model=$3
         AND 1-(c.embedding <=> $1::vector) >= 0.35
       ORDER BY c.embedding <=> $1::vector LIMIT 5`,
      [JSON.stringify(vectors[0]), userId, model],
    );
    return result.rows;
  }
}
