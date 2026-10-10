import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../dist/app.module.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { UserService } from '../dist/user/user.service.js';
import { DatabaseService } from '../dist/database/database.service.js';

test('feature modules share a database and preserve auth routes and CRUD protection', async () => {
  const token = 'a'.repeat(64);
  const hash = createHash('sha256').update(token).digest('hex');
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Reader',
    username: 'reader',
    email: 'reader@example.com',
  };
  let revoked = false;
  const database = {
    pool: {
      async query(sql, values) {
        if (sql.startsWith('SELECT user_id')) {
          return {
            rows: !revoked && values[0] === hash ? [{ user_id: user.id }] : [],
          };
        }
        if (sql.startsWith('DELETE FROM user_sessions WHERE token_hash')) {
          if (values[0] === hash) revoked = true;
          return { rows: [] };
        }
        return { rows: [{ ...user }], rowCount: 1 };
      },
    },
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue(database)
    .compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  try {
    await app.init();
    assert.equal(app.get(UserService).database, database);
    assert.equal(app.get(AuthService).database, database);
    const client = request(app.getHttpServer());
    const routes = [
      ['get', '/api/users', undefined, 200],
      ['get', `/api/users/${user.id}`, undefined, 200],
      ['post', '/api/users', { name: user.name, email: user.email }, 201],
      ['patch', `/api/users/${user.id}`, { name: 'Updated' }, 200],
      ['delete', `/api/users/${user.id}`, undefined, 204],
    ];
    for (const [method, path, body, status] of routes) {
      await client[method](path).send(body).expect(401);
      await client[method](path)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(status);
    }
    await client.get('/api/users/me').expect(401);
    await client
      .get('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => assert.equal(body.id, user.id));
    for (const authorization of [
      'Basic abc',
      'Bearer invalid',
      `Bearer ${'b'.repeat(64)}`,
    ]) {
      await client
        .get('/api/users')
        .set('Authorization', authorization)
        .expect(401);
    }
    // 注册和登录仍是公开接口，请求校验失败应为 400，而不是被 Guard 拒绝。
    await client.post('/api/users/register').send({}).expect(400);
    await client.post('/api/users/login').send({}).expect(400);
    await client
      .post('/api/users/register')
      .send({
        username: user.username,
        email: user.email,
        password: 'Secure123!',
      })
      .expect(201);
    await client.post('/api/users/logout').expect(204);
    await client
      .post('/api/users/logout')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await client
      .get('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    await client
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  } finally {
    await app.close();
  }
});
