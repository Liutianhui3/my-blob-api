import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import { userFields as fields } from './user.model.js';
import type { UserUpdate } from './user.model.js';

@Injectable()
export class UserService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async list() {
    const result = await this.database.pool.query(
      `SELECT ${fields} FROM users ORDER BY created_at DESC, id`,
    );
    return result.rows;
  }

  async find(id: string) {
    this.validateId(id);
    const result = await this.database.pool.query(
      `SELECT ${fields} FROM users WHERE id = $1`,
      [id],
    );
    if (!result.rows.length) throw new NotFoundException('用户不存在');
    return result.rows[0];
  }

  async create(body: unknown) {
    const input = this.validate(body, false);
    try {
      // 用占位符传入参数，避免把用户输入拼接进 SQL。
      const result = await this.database.pool.query(
        `INSERT INTO users (id, name, email) VALUES ($1, $2, $3) RETURNING ${fields}`,
        [randomUUID(), input.name, input.email],
      );
      return result.rows[0];
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  async update(id: string, body: unknown) {
    this.validateId(id);
    const input = this.validate(body, true);
    try {
      const result = await this.database.pool.query(
        `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email),
         updated_at = NOW() WHERE id = $1 RETURNING ${fields}`,
        [id, input.name, input.email],
      );
      if (!result.rows.length) throw new NotFoundException('用户不存在');
      return result.rows[0];
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  async remove(id: string) {
    this.validateId(id);
    const result = await this.database.pool.query(
      'DELETE FROM users WHERE id = $1',
      [id],
    );
    if (!result.rowCount) throw new NotFoundException('用户不存在');
  }

  private validateId(id: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new BadRequestException('id 必须是 UUID');
    }
  }

  private handleDatabaseError(error: unknown): never {
    // PostgreSQL 的 23505 表示违反唯一约束。
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new ConflictException('用户名或邮箱已被使用');
    }
    throw error;
  }

  private validate(body: unknown, partial: boolean): UserUpdate {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('请求体必须是 JSON 对象');
    }
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== 'name' && key !== 'email')) {
      throw new BadRequestException('仅允许 name 和 email 字段');
    }
    if (!Object.keys(value).length)
      throw new BadRequestException('请提供 name 或 email');
    const input: UserUpdate = {};
    for (const key of ['name', 'email'] as const) {
      if (partial && !(key in value)) continue;
      if (typeof value[key] !== 'string' || !value[key].trim()) {
        throw new BadRequestException(`${key} 必须为非空字符串`);
      }
      input[key] = value[key].trim();
    }
    if (input.name && input.name.length > 100)
      throw new BadRequestException('name 最多 100 个字符');
    if (input.email) {
      input.email = input.email.toLowerCase();
      if (
        input.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
      ) {
        throw new BadRequestException('email 格式不正确');
      }
    }
    return input;
  }
}
