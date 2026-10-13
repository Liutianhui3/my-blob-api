import { CaptchaService } from '../dist/auth/captcha.service.js';
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../dist/app.module.js';
import { DatabaseService } from '../dist/database/database.service.js';

test(
  'PostgreSQL profile migration, ownership, uniqueness and persistence across restart',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const credentials = {
      username: `profile_${suffix}`,
      password: 'Secure123!',
    };
    const otherCredentials = {
      username: `other_${suffix}`,
      password: 'Secure123!',
    };
    const ids = [];
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY2kAAAAASUVORK5CYII=';
    const databasePool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    let app;
    async function start() {
      const database = new DatabaseService();
      await database.pool.end();
      database.pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CaptchaService).useValue({ verify: async () => {} })
        .overrideProvider(DatabaseService)
        .useValue(database)
        .compile();
      const instance = module.createNestApplication({ logger: false });
      instance.setGlobalPrefix('api');
      instance.useBodyParser('json', { limit: '512kb' });
      await instance.init();
      return instance;
    }
    try {
      app = await start();
      const client = request(app.getHttpServer());
      const account = await client
        .post('/api/users/register')
        .send({ ...credentials, email: `${credentials.username}@example.com` })
        .expect(201);
      ids.push(account.body.id);
      assert.equal(account.body.location, '');
      assert.equal(account.body.website, '');
      assert.equal(account.body.bio, '');
      assert.equal(account.body.avatar, '');
      assert.equal(account.body.phone, '');
      assert.equal(account.body.about, '');
      assert.deepEqual(account.body.skills, []);
      assert.deepEqual(account.body.workExperiences, []);
      const other = await client
        .post('/api/users/register')
        .send({
          ...otherCredentials,
          email: `${otherCredentials.username}@example.com`,
        })
        .expect(201);
      ids.push(other.body.id);
      const login = await client
        .post('/api/users/login')
        .send(credentials)
        .expect(200);
      const token = login.body.token;
      const patch = (body) =>
        client
          .patch('/api/users/me')
          .set('Authorization', `Bearer ${token}`)
          .send(body);
      const fields = {
        name: '新的昵称',
        email: `updated_${suffix}@example.com`,
        location: '上海',
        website: 'https://example.com',
        bio: '数据库保存的简介',
        avatar: png,
        phone: '+86 13800138000',
        about: '数据库保存的关于',
        skills: ['Vue', 'TypeScript'],
        workExperiences: [
          {
            id: 'work-1',
            company: '测试公司',
            position: '前端工程师',
            startDate: '2023-05',
            endDate: '',
            description: '研发工作',
          },
        ],
      };
      const updated = await patch(fields).expect(200);
      for (const [key, value] of Object.entries(fields))
        assert.deepEqual(updated.body[key], value);
      assert.equal(updated.body.id, account.body.id);
      assert.equal(updated.body.password_hash, undefined);
      await patch({ email: other.body.email.toUpperCase() }).expect(409);
      await patch({ id: other.body.id, bio: '不能改他人' }).expect(400);
      const untouched = await databasePool.query(
        'SELECT bio FROM users WHERE id = $1',
        [other.body.id],
      );
      assert.equal(untouched.rows[0].bio, '');
      await app.close();
      app = await start(); // Re-runs the additive schema migration.
      const restarted = request(app.getHttpServer());
      const persisted = await restarted
        .get('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      for (const [key, value] of Object.entries(fields))
        assert.deepEqual(persisted.body[key], value);
      const relogin = await restarted
        .post('/api/users/login')
        .send(credentials)
        .expect(200);
      assert.equal(relogin.body.user.avatar, png);
      assert.equal(relogin.body.user.bio, fields.bio);
      assert.deepEqual(
        relogin.body.user.workExperiences,
        fields.workExperiences,
      );
      assert.deepEqual(relogin.body.user.skills, fields.skills);
      await restarted
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({
          bio: '',
          avatar: '',
          skills: [],
          workExperiences: [],
          about: '',
          phone: '',
        })
        .expect(200);
      const cleared = await databasePool.query(
        'SELECT name, bio, avatar, skills, work_experiences, about, phone FROM users WHERE id = $1',
        [account.body.id],
      );
      assert.equal(cleared.rows[0].name, fields.name);
      assert.equal(cleared.rows[0].bio, '');
      assert.equal(cleared.rows[0].avatar, '');
      assert.deepEqual(cleared.rows[0].skills, []);
      assert.deepEqual(cleared.rows[0].work_experiences, []);
      assert.equal(cleared.rows[0].about, '');
      assert.equal(cleared.rows[0].phone, '');
      await restarted
        .post('/api/users/logout')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      await restarted
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'expired' })
        .expect(401);
    } finally {
      await databasePool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
        ids,
      ]);
      await databasePool.end();
      if (app) await app.close();
    }
  },
);
