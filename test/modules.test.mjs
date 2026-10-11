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

test('feature modules preserve self-service routes and do not expose user management', async () => {
  const token = 'a'.repeat(64);
  const hash = createHash('sha256').update(token).digest('hex');
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Reader',
    username: 'reader',
    email: 'reader@example.com',
  };
  let revoked = false;
  let queries = 0;
  const database = {
    pool: {
      async query(sql, values) {
        queries++;
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
    const otherId = '22222222-2222-4222-8222-222222222222';
    const routes = [
      ['get', '/api/users'],
      ['post', '/api/users', { name: user.name, email: user.email }],
      ...[user.id, otherId].flatMap((id) => [
        ['get', `/api/users/${id}`],
        ['patch', `/api/users/${id}`, { name: 'Updated' }],
        ['delete', `/api/users/${id}`],
      ]),
    ];
    for (const [method, path, body] of routes) {
      const before = queries;
      await client[method](path).send(body).expect(404);
      await client[method](path)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(404);
      assert.equal(
        queries,
        before,
        `${method} ${path} must not access the database`,
      );
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
        .get('/api/users/me')
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
      .expect(404);
  } finally {
    await app.close();
  }
});
