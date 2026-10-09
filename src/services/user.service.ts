import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { DatabaseService } from '../database/database.service.js';
import type { UserUpdate } from '../models/user.model.js';

// SQL 中给时间字段起别名，让前端继续使用 createdAt、updatedAt。
const fields =
  'id, name, email, username, created_at AS "createdAt", updated_at AS "updatedAt"';

@Injectable()
export class UserService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async register(body: unknown) {
    const value = this.authInput(body, true);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = `${salt}:${scryptSync(value.password, salt, 64).toString('hex')}`;
    try {
      const result = await this.database.pool.query(
        `INSERT INTO users (id, name, email, username, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING ${fields}`,
        [
          randomUUID(),
          value.username,
          value.email,
          value.username,
          passwordHash,
        ],
      );
      return result.rows[0];
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  async login(body: unknown) {
    const value = this.authInput(body, false);
    const result = await this.database.pool.query(
      `SELECT ${fields}, password_hash FROM users WHERE LOWER(username) = LOWER($1)`,
      [value.username],
    );
    const user = result.rows[0];
    // 不存在的用户也执行密码哈希，避免通过明显的时间差探测账号。
    const [salt, hash] = (
      user?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`
    ).split(':');
    const actual = scryptSync(value.password, salt, 64);
    if (!hash || !timingSafeEqual(actual, Buffer.from(hash, 'hex')) || !user) {
      throw new UnauthorizedException('用户名或密码不正确');
    }
    delete user.password_hash;
    const token = randomBytes(32).toString('hex');
    await this.database.pool.query(
      'DELETE FROM user_sessions WHERE expires_at <= NOW()',
    );
    await this.database.pool.query(
      `INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
      [this.tokenHash(token), user.id],
    );
    return { user, token };
  }

  async me(token: string) {
    const session = await this.database.pool.query(
      'SELECT user_id FROM user_sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [this.tokenHash(token)],
    );
    if (!session.rows.length) throw new UnauthorizedException('请先登录');
    return this.find(session.rows[0].user_id);
  }

  async logout(token: string) {
    await this.database.pool.query(
      'DELETE FROM user_sessions WHERE token_hash = $1',
      [this.tokenHash(token)],
    );
  }

  private tokenHash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private authInput(body: unknown, register: boolean) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('请求体必须是 JSON 对象');
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          !['username', 'password', ...(register ? ['email'] : [])].includes(
            key,
          ),
      )
    )
      throw new BadRequestException('请求包含不支持的字段');
    const username =
      typeof value.username === 'string' ? value.username.trim() : '';
    const password = typeof value.password === 'string' ? value.password : '';
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username))
      throw new BadRequestException('用户名为 3–32 位字母、数字或下划线');
    if (!password || password.length > 128)
      throw new BadRequestException('密码长度为 1–128 位');
    if (
      register &&
      (password.length < 8 ||
        !/[a-zA-Z]/.test(password) ||
        !/[0-9]/.test(password))
    )
      throw new BadRequestException('密码需为 8–128 位，且包含字母和数字');
    const email =
      typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
    if (
      register &&
      (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )
      throw new BadRequestException('请输入有效邮箱');
    return { username, password, email };
  }

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
