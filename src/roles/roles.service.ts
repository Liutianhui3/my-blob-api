import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
const fields =
  'id, username, name, email, is_admin AS "isAdmin", created_at AS "createdAt"';
@Injectable()
export class RolesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  async list(query: Record<string, unknown>) {
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const page = Number(query.page ?? 1);
    const role = query.role ?? '';
    if (
      q.length > 100 ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !['', 'admin', 'user'].includes(role as string)
    )
      throw new BadRequestException('用户查询参数无效');
    const values: unknown[] = [];
    const where = ['TRUE'];
    if (q) {
      values.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
      where.push(`(username ILIKE $1 OR name ILIKE $1 OR email ILIKE $1)`);
    }
    if (role) where.push(`is_admin = $${values.push(role === 'admin')}`);
    const result = await this.database.pool.query(
      `WITH filtered AS (SELECT ${fields} FROM users WHERE ${where.join(' AND ')}),
      paged AS (SELECT * FROM filtered ORDER BY "isAdmin" DESC, "createdAt" DESC, id LIMIT 20 OFFSET $${values.length + 1})
      SELECT (SELECT COUNT(*)::int FROM filtered) AS total, COALESCE((SELECT json_agg(paged) FROM paged),'[]'::json) AS items`,
      [...values, (page - 1) * 20],
    );
    return { ...result.rows[0], page, limit: 20 };
  }
  async update(actor: string, id: string, body: unknown) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new BadRequestException('用户 ID 无效');
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { isAdmin?: unknown }).isAdmin !== 'boolean'
    )
      throw new BadRequestException('仅支持布尔类型的 isAdmin 字段');
    const isAdmin = (body as { isAdmin: boolean }).isAdmin;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize role writes, including rechecking the caller after concurrent demotion.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('my-blob-api:roles'))",
      );
      const caller = await client.query(
        'SELECT is_admin FROM users WHERE id=$1',
        [actor],
      );
      if (caller.rows[0]?.is_admin !== true)
        throw new ForbiddenException('仅管理员可以配置角色');
      const target = await client.query(
        'SELECT is_admin FROM users WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!target.rows.length) throw new NotFoundException('用户不存在');
      if (!isAdmin && target.rows[0].is_admin) {
        const count = await client.query(
          'SELECT COUNT(*)::int AS count FROM users WHERE is_admin=TRUE',
        );
        if (count.rows[0].count <= 1)
          throw new ConflictException('请至少保留一位管理员');
      }
      const result = await client.query(
        `UPDATE users SET is_admin=$2, updated_at=NOW() WHERE id=$1 RETURNING ${fields}`,
        [id, isAdmin],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
