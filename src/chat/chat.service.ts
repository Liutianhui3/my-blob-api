import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { AiService } from '../ai/ai.service.js';
import type { AiMessage, HistoryTurn } from '../ai/ai.service.js';
import type { GenerationSettings } from '../ai/model-catalog.js';
import { RagService } from '../knowledge/rag.service.js';
import type { KnowledgeSource } from '../knowledge/rag.service.js';

const conversationFields =
  'id, title, created_at AS "createdAt", updated_at AS "updatedAt"';
const messageFields =
  'id, turn_id AS "turnId", sequence::text AS sequence, role, content, status, model, reasoning_effort AS "reasoningEffort", created_at AS "createdAt"';

export interface ChatTurn {
  conversationId: string;
  generationId: string;
  userMessageId: string;
  messageId: string;
  messages: AiMessage[];
  generation: GenerationSettings;
}

@Injectable()
export class ChatService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(RagService) private readonly rag?: RagService,
  ) {}

  async create(userId: string, body: unknown) {
    const input = this.input(body, ['title']);
    const title =
      input.title === undefined
        ? '新对话'
        : this.text(input.title, 'title', 100);
    const result = await this.database.pool.query(
      `INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, $3) RETURNING ${conversationFields}`,
      [randomUUID(), userId, title],
    );
    return result.rows[0];
  }

  async list(userId: string) {
    const result = await this.database.pool.query(
      `SELECT ${conversationFields} FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT 100`,
      [userId],
    );
    return result.rows;
  }

  async history(
    userId: string,
    id: string,
    before?: string,
    limitValue?: string,
  ) {
    await this.owned(userId, id);
    if (
      before !== undefined &&
      (typeof before !== 'string' ||
        !/^[1-9][0-9]{0,18}$/.test(before) ||
        BigInt(before) > 9223372036854775807n)
    )
      throw new BadRequestException('before 必须是有效消息顺序号');
    const limit = limitValue === undefined ? 100 : Number(limitValue);
    if (
      (limitValue !== undefined && typeof limitValue !== 'string') ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('limit 必须为 1–100 的整数');
    const result = await this.database.pool.query(
      `SELECT ${messageFields} FROM messages
       WHERE conversation_id = $1 AND ($2::bigint IS NULL OR sequence < $2::bigint)
       ORDER BY sequence DESC LIMIT $3`,
      [id, before ?? null, limit],
    );
    return result.rows.reverse();
  }

  async prepare(
    userId: string,
    id: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<ChatTurn> {
    this.validateId(id);
    const input = this.input(body, ['content', 'model', 'reasoningEffort']);
    const content = this.text(input.content, 'content', 16_000);
    const generation = this.ai.resolveGeneration({
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });
    const { timeoutMs } = this.ai.configuration();
    // Validate the current prompt budget before inserting any messages.
    this.ai.buildMessages([], content);
    // Check conversation ownership before remote calls; do not hold SQL locks during embedding.
    let sources: KnowledgeSource[] = [];
    if (this.rag) {
      await this.owned(userId, id);
      sources = await this.rag.retrieve(userId, content, signal);
    }
    signal.throwIfAborted();
    const generationId = randomUUID();
    const userMessageId = randomUUID();
    const messageId = randomUUID();
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id, generation_id, generation_expires_at > NOW() AS active
         FROM conversations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, userId],
      );
      const conversation = found.rows[0];
      if (!conversation) throw new NotFoundException('会话不存在');
      if (conversation.generation_id && conversation.active)
        throw new ConflictException('该会话正在生成回复，请稍后再试');
      // An expired lease may belong to a process that stopped unexpectedly.
      await client.query(
        `UPDATE messages SET status = 'failed' WHERE conversation_id = $1 AND status = 'generating'`,
        [id],
      );
      const history = await client.query<HistoryTurn>(
        `SELECT u.content AS "user", a.content AS assistant
         FROM messages u JOIN messages a ON a.conversation_id = u.conversation_id
           AND a.turn_id = u.turn_id AND a.role = 'assistant' AND a.status = 'completed'
         WHERE u.conversation_id = $1 AND u.role = 'user' AND u.status = 'completed'
         ORDER BY u.sequence DESC LIMIT 50`,
        [id],
      );
      const messages = this.ai.buildMessages(
        history.rows.reverse(),
        content,
        sources,
      );
      await client.query(
        `UPDATE conversations SET generation_id = $2,
         generation_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'), updated_at = NOW()
         WHERE id = $1`,
        [id, generationId, timeoutMs + 30_000],
      );
      await client.query(
        `INSERT INTO messages (id, conversation_id, turn_id, role, content, status, model, reasoning_effort)
         VALUES ($1, $2, $3, 'user', $4, 'completed', NULL, NULL), ($5, $2, $3, 'assistant', '', 'generating', $6, $7)`,
        [
          userMessageId,
          id,
          generationId,
          content,
          messageId,
          generation.model,
          generation.reasoningEffort,
        ],
      );
      signal.throwIfAborted();
      await client.query('COMMIT');
      return {
        conversationId: id,
        generationId,
        userMessageId,
        messageId,
        messages,
        generation,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(
    turn: ChatTurn,
    content: string,
    status: 'completed' | 'failed' | 'cancelled',
  ) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const lease = await client.query(
        `UPDATE conversations SET generation_id = NULL, generation_expires_at = NULL,
         updated_at = NOW() WHERE id = $1 AND generation_id = $2 RETURNING id`,
        [turn.conversationId, turn.generationId],
      );
      if (!lease.rows.length) throw new ConflictException('回复生成租约已失效');
      const saved = await client.query(
        `UPDATE messages SET content = $2, status = $3 WHERE id = $1 AND status = 'generating' RETURNING id`,
        [turn.messageId, content, status],
      );
      if (!saved.rows.length) throw new ConflictException('回复状态已失效');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async remove(userId: string, id: string) {
    this.validateId(id);
    // 同一条 SQL 校验归属并删除；messages 通过外键 ON DELETE CASCADE 一起清理。
    const result = await this.database.pool.query(
      'DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId],
    );
    if (!result.rowCount) throw new NotFoundException('会话不存在');
    return { id };
  }

  private async owned(userId: string, id: string) {
    this.validateId(id);
    const result = await this.database.pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (!result.rows.length) throw new NotFoundException('会话不存在');
  }

  private validateId(id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new BadRequestException('id 必须是 UUID');
  }

  private input(body: unknown, allowed: string[]) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('请求体必须是 JSON 对象');
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some((key) => !allowed.includes(key)))
      throw new BadRequestException(`仅允许 ${allowed.join('、')} 字段`);
    return value;
  }

  private text(value: unknown, name: string, max: number) {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > max ||
      value.includes('\0')
    )
      throw new BadRequestException(
        `${name} 必须是 1–${max} 字符的非空字符串，不能包含空字符`,
      );
    return value.trim();
  }
}
