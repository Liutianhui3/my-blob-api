import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { DatabaseService } from '../database/database.service.js';

const fields = `a.id, a.user_id AS "authorId", a.title, a.summary, a.category, a.tags,
  a.cover_url AS "coverUrl", a.status, a.version,
  a.created_at AS "createdAt", a.updated_at AS "updatedAt", a.published_at AS "publishedAt",
  COALESCE(NULLIF(u.name, ''), u.username) AS "authorName"`;
export function cleanArticleHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'h2',
      'h3',
      'h4',
      'strong',
      'em',
      's',
      'u',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'a',
      'img',
      'hr',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
      code: ['class'],
      ol: ['start'],
    },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
    },
  });
}
const plainText = (html: string) =>
  sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();

@Injectable()
export class ArticleService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private id(id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new BadRequestException('文章 ID 无效');
  }

  async list(query: Record<string, unknown>, manage = false) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 12);
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const category =
      typeof query.category === 'string' ? query.category.trim() : '';
    const status = typeof query.status === 'string' ? query.status : '';
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      q.length > 100 ||
      category.length > 40 ||
      (status && !['draft', 'published'].includes(status))
    )
      throw new BadRequestException('文章查询参数无效');
    const params: unknown[] = [];
    const where = manage ? 'TRUE' : "a.status = 'published'";
    const conditions = [where];
    if (q)
      conditions.push(
        `(a.title ILIKE $${params.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%')} OR a.summary ILIKE $${params.length})`,
      );
    if (category) conditions.push(`a.category = $${params.push(category)}`);
    if (manage && status) conditions.push(`a.status = $${params.push(status)}`);
    // One SQL statement keeps count and items in the same database snapshot, including empty pages.
    const result = await this.database.pool.query(
      `WITH filtered AS (
      SELECT ${fields} FROM articles a JOIN users u ON u.id = a.user_id WHERE ${conditions.join(' AND ')}
    ), paged AS (
      SELECT * FROM filtered ORDER BY ${manage ? '"updatedAt"' : '"publishedAt"'} DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    ) SELECT (SELECT COUNT(*)::int FROM filtered) AS total,
      COALESCE((SELECT json_agg(paged) FROM paged), '[]'::json) AS items`,
      [...params, limit, (page - 1) * limit],
    );
    return { ...result.rows[0], page, limit };
  }

  async get(id: string, manage = false) {
    this.id(id);
    const result = await this.database.pool.query(
      `SELECT ${fields}, a.content FROM articles a JOIN users u ON u.id = a.user_id
      WHERE a.id = $1 AND ${manage ? 'TRUE' : "a.status = 'published'"}`,
      [id],
    );
    if (!result.rows.length) throw new NotFoundException('文章不存在');
    return result.rows[0];
  }

  private input(body: unknown, updating = false) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('请求体必须是 JSON 对象');
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          ![
            'title',
            'summary',
            'content',
            'category',
            'tags',
            'coverUrl',
            'status',
            ...(updating ? ['version'] : []),
          ].includes(key),
      )
    )
      throw new BadRequestException('请求包含不支持的字段');
    const text = (key: string, max: number, fallback = '') => {
      const raw = value[key] ?? fallback;
      if (typeof raw !== 'string' || raw.trim().length > max)
        throw new BadRequestException(`${key} 格式或长度无效`);
      return raw.trim();
    };
    const title = text('title', 160);
    const raw = text('content', 200000);
    const content = cleanArticleHtml(raw);
    const status = value.status ?? 'draft';
    const category = text('category', 40, '随笔') || '随笔';
    const coverUrl = text('coverUrl', 2000);
    if (!title) throw new BadRequestException('请输入文章标题');
    if (!['draft', 'published'].includes(status as string))
      throw new BadRequestException('文章状态无效');
    if (
      status === 'published' &&
      !plainText(content) &&
      !/<img\s[^>]*src=/.test(content)
    )
      throw new BadRequestException('发布前请填写正文');
    if (coverUrl) {
      try {
        const url = new URL(coverUrl);
        if (url.protocol !== 'https:' || url.username || url.password)
          throw new Error();
      } catch {
        throw new BadRequestException('封面请使用有效的 HTTPS 图片地址');
      }
    }
    const tags = value.tags ?? [];
    if (
      !Array.isArray(tags) ||
      tags.length > 8 ||
      tags.some(
        (tag) =>
          typeof tag !== 'string' || !tag.trim() || tag.trim().length > 24,
      )
    )
      throw new BadRequestException('标签最多 8 个，每个 1–24 字');
    const summary = text('summary', 300) || plainText(content).slice(0, 160);
    if (
      updating &&
      (!Number.isSafeInteger(value.version) || Number(value.version) < 1)
    )
      throw new BadRequestException('文章版本无效，请重新加载');
    return {
      title,
      summary,
      content,
      category,
      coverUrl,
      status,
      tags: [...new Set(tags.map((tag) => tag.trim()))],
      version: value.version,
    };
  }

  async create(owner: string, body: unknown) {
    const v = this.input(body);
    const id = randomUUID();
    await this.database.pool.query(
      `INSERT INTO articles (id, user_id, title, summary, content, category, tags, cover_url, status, published_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,CASE WHEN $9 = 'published' THEN NOW() ELSE NULL END)`,
      [
        id,
        owner,
        v.title,
        v.summary,
        v.content,
        v.category,
        JSON.stringify(v.tags),
        v.coverUrl,
        v.status,
      ],
    );
    return this.get(id, true);
  }

  async update(id: string, body: unknown) {
    this.id(id);
    const v = this.input(body, true);
    const result = await this.database.pool.query(
      `UPDATE articles SET title=$2, summary=$3, content=$4, category=$5, tags=$6::jsonb,
      cover_url=$7, status=$8, published_at=CASE WHEN $8='published' THEN COALESCE(published_at,NOW()) ELSE NULL END,
      updated_at=NOW(), version=version+1 WHERE id=$1 AND version=$9 RETURNING id`,
      [
        id,
        v.title,
        v.summary,
        v.content,
        v.category,
        JSON.stringify(v.tags),
        v.coverUrl,
        v.status,
        v.version,
      ],
    );
    if (!result.rows.length) {
      await this.get(id, true);
      throw new ConflictException('文章已在其他页面修改，请重新加载后再编辑');
    }
    return this.get(id, true);
  }

  async remove(id: string) {
    this.id(id);
    const result = await this.database.pool.query(
      'DELETE FROM articles WHERE id=$1 RETURNING id',
      [id],
    );
    if (!result.rows.length) throw new NotFoundException('文章不存在');
  }
}
