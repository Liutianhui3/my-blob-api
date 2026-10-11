import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// 只针对显式配置的测试数据库执行，避免改动开发数据。
test(
  'PostgreSQL CRUD, validation, CORS and persistence',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { DatabaseService } =
      await import('../dist/database/database.service.js');
    const { Pool } = await import('pg');
    const { Test } = await import('@nestjs/testing');
    const email = `test-${Date.now()}@example.com`;
    const authEmail = `auth-${Date.now()}@example.com`;
    const credentials = {
      username: `test_${Date.now()}`,
      password: 'Secure123!',
    };
    async function createApp(AppModule) {
      const database = new DatabaseService();
      await database.pool.end();
      database.pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DatabaseService)
        .useValue(database)
        .compile();
      return module.createNestApplication({ logger: false });
    }
    const { AppModule } = await import('../dist/app.module.js');
    let app;
    try {
      app = await createApp(AppModule);
      app.setGlobalPrefix('api');
      app.enableCors();
      await app.init();
      const client = request.agent(app.getHttpServer());
      await client.get('/api/users').expect(401);
      const account = await client
        .post('/api/users/register')
        .send({ ...credentials, email: authEmail })
        .expect(201);
      assert.equal(account.body.password_hash, undefined);
      await client
        .post('/api/users/register')
        .send({ ...credentials, email: `duplicate-${authEmail}` })
        .expect(409);
      await client
        .post('/api/users/login')
        .send({ ...credentials, password: 'wrong' })
        .expect(401);
      const login = await client
        .post('/api/users/login')
        .send(credentials)
        .expect(200);
      assert.match(login.body.token, /^[a-f0-9]{64}$/);
      assert.equal(login.body.user.password_hash, undefined);
      client.set('Authorization', `Bearer ${login.body.token}`);
      await client.get('/api/users/me').expect(200);
      await client
        .post('/api/users')
        .send({ name: '', email: 'invalid' })
        .expect(400);
      const created = await client
        .post('/api/users')
        .send({ name: '张三', email: email.toUpperCase() })
        .expect(201);
      const id = created.body.id;
      assert.equal(created.body.email, email);
      await client.post('/api/users').send({ name: '重复', email }).expect(409);
      const list = await client
        .get('/api/users')
        .set('Origin', 'http://localhost:5173')
        .expect(200);
      assert.equal(list.headers['access-control-allow-origin'], '*');
      assert.ok(list.body.some((user) => user.id === id));
      await client.get(`/api/users/${id}`).expect(200);
      const updated = await client
        .patch(`/api/users/${id}`)
        .send({ name: '李四' })
        .expect(200);
      assert.equal(updated.body.name, '李四');
      await client.patch(`/api/users/${id}`).send({ id: 'fake' }).expect(400);
      await app.close();
      app = await createApp(AppModule);
      app.setGlobalPrefix('api');
      await app.init();
      const restarted = request.agent(app.getHttpServer());
      const relogin = await restarted
        .post('/api/users/login')
        .send(credentials)
        .expect(200);
      restarted.set('Authorization', `Bearer ${relogin.body.token}`);
      const persisted = await restarted.get(`/api/users/${id}`).expect(200);
      assert.equal(persisted.body.name, '李四');
      await restarted.delete(`/api/users/${id}`).expect(204);
      await restarted.get(`/api/users/${id}`).expect(404);
      await restarted.post('/api/users/logout').expect(204);
      await restarted.get('/api/users/me').expect(401);
      await restarted.get('/api/users').expect(401);
    } finally {
      // A failed restart can leave `app` pointing at an already-closed pool.
      // Use an independent connection so cleanup does not hide the real error.
      const cleanup = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      try {
        await cleanup.query('DELETE FROM users WHERE email = ANY($1::text[])', [
          [email, authEmail],
        ]);
      } finally {
        await cleanup.end();
        if (app) await app.close();
      }
    }
  },
);
