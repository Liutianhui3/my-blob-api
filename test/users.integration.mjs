import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// 只针对显式配置的测试数据库执行，避免改动开发数据。
test(
  'PostgreSQL authentication, user isolation, CORS and persistence',
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
    const otherCredentials = {
      username: `other_${Date.now()}`,
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
      await client.get('/api/users').expect(404);
      await client.get('/api/users/me').expect(401);
      const account = await client
        .post('/api/users/register')
        .send({ ...credentials, email: authEmail })
        .expect(201);
      assert.equal(account.body.password_hash, undefined);
      const other = await client
        .post('/api/users/register')
        .send({ ...otherCredentials, email })
        .expect(201);
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
      const me = await client
        .get('/api/users/me')
        .set('Origin', 'http://localhost:5173')
        .expect(200);
      assert.equal(me.headers['access-control-allow-origin'], '*');
      assert.equal(me.body.id, account.body.id);
      await client.get('/api/users').expect(404);
      await client
        .post('/api/users')
        .send({ name: 'Unwanted', email: `unwanted-${email}` })
        .expect(404);
      for (const id of [account.body.id, other.body.id]) {
        await client.get(`/api/users/${id}`).expect(404);
        await client
          .patch(`/api/users/${id}`)
          .send({ name: 'Unauthorized', email: `changed-${email}` })
          .expect(404);
        await client.delete(`/api/users/${id}`).expect(404);
      }
      await client
        .patch('/api/users/me')
        .send({ id: other.body.id, name: 'Unauthorized' })
        .expect(400);
      await client.patch('/api/users/me').send({ email }).expect(409);
      const updated = await client
        .patch('/api/users/me')
        .send({ name: '李四' })
        .expect(200);
      assert.equal(updated.body.name, '李四');
      assert.equal(updated.body.id, account.body.id);
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
      const persisted = await restarted.get('/api/users/me').expect(200);
      assert.equal(persisted.body.name, '李四');
      assert.equal(persisted.body.id, account.body.id);
      const otherLogin = await restarted
        .post('/api/users/login')
        .send(otherCredentials)
        .expect(200);
      assert.equal(otherLogin.body.user.id, other.body.id);
      assert.equal(otherLogin.body.user.name, other.body.name);
      assert.equal(otherLogin.body.user.email, email);
      await restarted.post('/api/users/logout').expect(204);
      await restarted.get('/api/users/me').expect(401);
      await restarted.get('/api/users').expect(404);
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
