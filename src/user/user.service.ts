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
import type {
  ProfileUpdate,
  UserUpdate,
  WorkExperience,
} from './user.model.js';

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

  async updateProfile(id: string, body: unknown) {
    this.validateId(id);
    const input = this.validateProfile(body);
    try {
      const result = await this.database.pool.query(
        `UPDATE users SET name = COALESCE($2, name), email = COALESCE($3, email),
         location = COALESCE($4, location), website = COALESCE($5, website),
         bio = COALESCE($6, bio), avatar = COALESCE($7, avatar),
         phone = COALESCE($8, phone), about = COALESCE($9, about),
         skills = COALESCE($10::jsonb, skills),
         work_experiences = COALESCE($11::jsonb, work_experiences), updated_at = NOW()
         WHERE id = $1 RETURNING ${fields}`,
        [
          id,
          input.name,
          input.email,
          input.location,
          input.website,
          input.bio,
          input.avatar,
          input.phone,
          input.about,
          input.skills === undefined ? undefined : JSON.stringify(input.skills),
          input.workExperiences === undefined
            ? undefined
            : JSON.stringify(input.workExperiences),
        ],
      );
      if (!result.rows.length) throw new NotFoundException('用户不存在');
      return result.rows[0];
    } catch (error) {
      this.handleDatabaseError(error);
    }
  }

  private validateProfile(body: unknown): ProfileUpdate {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('请求体必须是 JSON 对象');
    }
    const value = body as Record<string, unknown>;
    const limits = {
      name: 40,
      email: 254,
      location: 60,
      website: 240,
      bio: 200,
      avatar: 409630,
      phone: 30,
      about: 2000,
    };
    const keys = Object.keys(value);
    if (!keys.length) throw new BadRequestException('请提供需要更新的资料字段');
    if (
      keys.some(
        (key) =>
          !Object.hasOwn(limits, key) &&
          key !== 'skills' &&
          key !== 'workExperiences',
      )
    ) {
      throw new BadRequestException(
        '仅允许 name、email、location、website、bio、avatar、phone、about、skills 和 workExperiences 字段',
      );
    }
    const input: ProfileUpdate = {};
    for (const key of keys.filter((key) =>
      Object.hasOwn(limits, key),
    ) as (keyof typeof limits)[]) {
      if (typeof value[key] !== 'string')
        throw new BadRequestException(`${key} 必须为字符串`);
      const text = value[key].trim();
      if (text.length > limits[key])
        throw new BadRequestException(`${key} 最多 ${limits[key]} 个字符`);
      if ((key === 'name' || key === 'email') && !text)
        throw new BadRequestException(`${key} 不能为空`);
      input[key] = text;
    }
    if (
      input.phone &&
      (!/^\+?[\d\s()-]{6,30}$/.test(input.phone) ||
        input.phone.replace(/\D/g, '').length < 6)
    ) {
      throw new BadRequestException('请填写有效的手机号码，可包含国际区号');
    }
    if (Object.hasOwn(value, 'skills')) {
      if (!Array.isArray(value.skills) || value.skills.length > 30) {
        throw new BadRequestException('skills 必须为数组，最多 30 项');
      }
      input.skills = [
        ...new Set(
          value.skills.map((skill) => {
            if (
              typeof skill !== 'string' ||
              !skill.trim() ||
              skill.trim().length > 40
            ) {
              throw new BadRequestException('每项技术栈必须为 1–40 个字符');
            }
            return skill.trim();
          }),
        ),
      ];
    }
    if (Object.hasOwn(value, 'workExperiences')) {
      input.workExperiences = this.validateWorkExperiences(
        value.workExperiences,
      );
    }
    if (input.email !== undefined) {
      input.email = input.email.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
        throw new BadRequestException('email 格式不正确');
    }
    if (input.website) {
      try {
        const url = new URL(input.website);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
          throw new Error('Invalid URL');
      } catch {
        throw new BadRequestException(
          '个人网站必须是有效的 http:// 或 https:// 地址',
        );
      }
    }
    if (input.avatar) {
      const match =
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
          input.avatar,
        );
      if (!match || match[2].length % 4 !== 0)
        throw new BadRequestException('头像必须是 PNG、JPG 或 WebP 图片');
      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.length > 300 * 1024)
        throw new BadRequestException('处理后的头像不能超过 300 KB');
      const signatures: Record<string, boolean> = {
        png: bytes
          .subarray(0, 8)
          .equals(Buffer.from('89504e470d0a1a0a', 'hex')),
        jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
        webp:
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP',
      };
      if (!signatures[match[1]])
        throw new BadRequestException('头像内容与图片格式不匹配');
    }
    return input;
  }

  private validateWorkExperiences(value: unknown): WorkExperience[] {
    if (!Array.isArray(value) || value.length > 20) {
      throw new BadRequestException('workExperiences 必须为数组，最多 20 段');
    }
    const limits = {
      id: 80,
      company: 100,
      position: 100,
      startDate: 7,
      endDate: 7,
      description: 2000,
    };
    const ids = new Set<string>();
    const month = /^(?:19|[2-9]\d)\d{2}-(?:0[1-9]|1[0-2])$/;
    return value.map((item, index) => {
      const invalid = (reason: string): never => {
        throw new BadRequestException(`第 ${index + 1} 段工作经历：${reason}`);
      };
      if (!item || typeof item !== 'object' || Array.isArray(item))
        invalid('必须为对象');
      if (Object.keys(item).some((key) => !Object.hasOwn(limits, key)))
        invalid('包含不支持的字段');
      const result = {} as WorkExperience;
      for (const key of Object.keys(limits) as (keyof WorkExperience)[]) {
        if (typeof item[key] !== 'string') invalid(`${key} 必须为字符串`);
        const text = item[key].trim();
        if (text.length > limits[key])
          invalid(`${key} 最多 ${limits[key]} 个字符`);
        result[key] = text;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(result.id) || ids.has(result.id))
        invalid('id 无效或重复');
      ids.add(result.id);
      if (!result.company || !result.position)
        invalid('公司名称与职位不能为空');
      if (
        !month.test(result.startDate) ||
        (result.endDate && !month.test(result.endDate))
      )
        invalid('任职时间必须是有效的 YYYY-MM 格式');
      if (result.endDate && result.endDate < result.startDate)
        invalid('结束时间不能早于开始时间');
      return result;
    });
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
