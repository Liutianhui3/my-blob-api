import 'dotenv/config';
import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  // pg 自动读取 .env 中的 PGHOST、PGPORT、PGUSER 等连接参数。
  readonly pool = new Pool({ connectionTimeoutMillis: 5000 });

  async onModuleInit() {
    try {
      // 只创建不存在的表，不会删除已有数据。数据库本身需要先创建。
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(254) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (LOWER(email));
        ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(32);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (LOWER(username));
        CREATE TABLE IF NOT EXISTS user_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL
        );
      `);
    } catch (error) {
      await this.pool.end();
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
