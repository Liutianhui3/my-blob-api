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
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        // IF NOT EXISTS alone cannot prevent concurrent PostgreSQL DDL races.
        // Serialize initialization for this application and schema across instances.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('my-blob-api:schema'))",
        );
        // 只创建不存在的表，不会删除已有数据。数据库本身需要先创建。
        await client.query(`
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
        ALTER TABLE users ADD COLUMN IF NOT EXISTS location VARCHAR(60) NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS website VARCHAR(240) NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(200) NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30) NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS about VARCHAR(2000) NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS work_experiences JSONB NOT NULL DEFAULT '[]'::jsonb;
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (LOWER(username));
        CREATE TABLE IF NOT EXISTS user_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversations (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(100) NOT NULL DEFAULT '新对话',
          generation_id UUID,
          generation_expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS conversations_user_updated
          ON conversations (user_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY,
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          turn_id UUID NOT NULL,
          sequence BIGSERIAL NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('generating', 'completed', 'failed', 'cancelled')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (conversation_id, turn_id, role)
        );
        CREATE INDEX IF NOT EXISTS messages_conversation_sequence
          ON messages (conversation_id, sequence DESC);
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS model TEXT;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR(16);
        `);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await this.pool.end();
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
