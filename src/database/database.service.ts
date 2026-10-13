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
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
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
        CREATE TABLE IF NOT EXISTS articles (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title VARCHAR(160) NOT NULL,
          summary VARCHAR(300) NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          category VARCHAR(40) NOT NULL DEFAULT '随笔',
          tags JSONB NOT NULL DEFAULT '[]'::jsonb,
          cover_url VARCHAR(2000) NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
          version INTEGER NOT NULL DEFAULT 1,
          published_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS articles_owner_updated ON articles(user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS articles_published ON articles(published_at DESC) WHERE status = 'published';
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
        CREATE TABLE IF NOT EXISTS knowledge_bases (
          id UUID PRIMARY KEY,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name VARCHAR(80) NOT NULL,
          description VARCHAR(300) NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS knowledge_bases_user ON knowledge_bases(user_id);
        CREATE TABLE IF NOT EXISTS knowledge_documents (
          id UUID PRIMARY KEY,
          base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          size INTEGER NOT NULL,
          content TEXT NOT NULL,
          chunk_size INTEGER NOT NULL,
          chunk_overlap INTEGER NOT NULL,
          chunk_count INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS knowledge_documents_base ON knowledge_documents(base_id);
        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          id UUID PRIMARY KEY,
          document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          content TEXT NOT NULL,
          char_count INTEGER NOT NULL,
          UNIQUE(document_id, position)
        );
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS model TEXT;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR(16);
        `);
        if (process.env.EMBEDDING_MODEL) {
          await client.query(`CREATE EXTENSION IF NOT EXISTS vector;
            ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1024);
            ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;`);
        }
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
