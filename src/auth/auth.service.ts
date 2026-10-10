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
import { userFields as fields } from '../user/user.model.js';

@Injectable()
export class AuthService {
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
    const user = await this.database.pool.query(
      `SELECT ${fields} FROM users WHERE id = $1`,
      [session.rows[0].user_id],
    );
    if (!user.rows.length) throw new NotFoundException('用户不存在');
    return user.rows[0];
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
}
