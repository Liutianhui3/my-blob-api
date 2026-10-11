import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../dist/app.module.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { DatabaseService } from '../dist/database/database.service.js';
import { UserService } from '../dist/user/user.service.js';

const id = '11111111-1111-4111-8111-111111111111';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY2kAAAAASUVORK5CYII=';

test('profile endpoint requires authentication, targets current account and validates all editable fields', async () => {
  const row = {
    id,
    username: 'reader',
    name: 'Reader',
    email: 'reader@example.com',
    location: '',
    website: '',
    bio: '',
    avatar: '',
    phone: '',
    about: '',
    skills: [],
    workExperiences: [],
  };
  const updates = [];
  const database = {
    pool: {
      async query(sql, values) {
        assert.match(sql, /^UPDATE users/);
        updates.push({ sql, values });
        if (values[2] === 'taken@example.com') throw { code: '23505' };
        for (const [index, field] of [
          'name',
          'email',
          'location',
          'website',
          'bio',
          'avatar',
          'phone',
          'about',
          'skills',
          'workExperiences',
        ].entries()) {
          if (values[index + 1] !== undefined)
            row[field] =
              index >= 8 ? JSON.parse(values[index + 1]) : values[index + 1];
        }
        return { rows: [{ ...row }] };
      },
    },
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue(database)
    .overrideProvider(AuthService)
    .useValue({
      me: async (token) => {
        if (token !== 'a'.repeat(64)) {
          const { UnauthorizedException } = await import('@nestjs/common');
          throw new UnauthorizedException();
        }
        return { ...row };
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  app.useBodyParser('json', { limit: '512kb' });
  app.setGlobalPrefix('api');
  try {
    await app.init();
    const client = request(app.getHttpServer());
    const patch = (body) =>
      client
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${'a'.repeat(64)}`)
        .send(body);
    await client
      .patch('/api/users/me')
      .send({ name: 'Unauthorized' })
      .expect(401);
    const response = await patch({
      name: ' 新昵称 ',
      email: 'NEW@EXAMPLE.COM',
      location: ' 上海 ',
      website: 'https://example.com',
      bio: 'Hello',
      avatar: png,
      phone: ' +86 13800138000 ',
      about: ' 关于我的故事 ',
      skills: [' Vue ', 'TypeScript', 'Vue'],
      workExperiences: [
        {
          id: 'work-1',
          company: ' 公司 ',
          position: '前端工程师',
          startDate: '2023-05',
          endDate: '',
          description: '<script>alert(1)</script>',
        },
      ],
    }).expect(200);
    assert.equal(response.body.name, '新昵称');
    assert.equal(response.body.email, 'new@example.com');
    assert.equal(response.body.avatar, png);
    assert.equal(response.body.phone, '+86 13800138000');
    assert.equal(response.body.about, '关于我的故事');
    assert.deepEqual(response.body.skills, ['Vue', 'TypeScript']);
    assert.equal(response.body.workExperiences[0].company, '公司');
    assert.equal(
      response.body.workExperiences[0].description,
      '<script>alert(1)</script>',
    );
    assert.equal(response.body.username, 'reader');
    assert.equal(updates[0].values[0], id);
    assert.match(updates[0].sql, /WHERE id = \$1 RETURNING/);
    assert.ok(!updates[0].sql.includes('新昵称'));
    await patch({
      bio: '',
      avatar: '',
      location: '',
      website: '',
      phone: '',
      about: '',
      skills: [],
      workExperiences: [],
    }).expect(200);
    assert.equal(row.bio, '');
    assert.equal(row.avatar, '');
    assert.equal(row.phone, '');
    assert.deepEqual(row.skills, []);
    assert.deepEqual(row.workExperiences, []);
    assert.equal(row.name, '新昵称');
    for (const body of [
      {},
      [],
      { id: 'other' },
      { username: 'other' },
      { password_hash: 'fake' },
      { name: ' ' },
      { name: 'x'.repeat(41) },
      { email: '' },
      { email: 'invalid' },
      { location: 'x'.repeat(61) },
      { website: 'javascript:alert(1)' },
      { website: 'https://' },
      { bio: 'x'.repeat(201) },
      { avatar: 'https://example.com/pic.png' },
      { avatar: 'data:image/svg+xml;base64,PHN2Zy8+' },
      { avatar: 'data:image/png;base64,ZmFrZQ==' },
      { avatar: null },
      { phone: 'abc123' },
      { phone: '------' },
      { phone: '1'.repeat(31) },
      { about: 'x'.repeat(2001) },
      { skills: null },
      { skills: 'Vue' },
      { skills: [123] },
      { skills: [' '] },
      { skills: ['x'.repeat(41)] },
      { skills: Array(31).fill('Vue') },
      { workExperiences: {} },
      { workExperiences: [null] },
      { workExperiences: Array(21).fill({}) },
      { workExperiences: [{ id: 'test' }] },
    ]) {
      await patch(body).expect(400);
    }
    const experience = {
      id: 'work-1',
      company: 'Company',
      position: 'Developer',
      startDate: '2023-05',
      endDate: '2024-01',
      description: '',
    };
    for (const fields of [
      { company: ' ' },
      { position: '' },
      { startDate: '2023-13' },
      { startDate: '0000-01' },
      { endDate: '2022-12' },
      { endDate: '2024-00' },
      { id: 'a b' },
      { company: 'x'.repeat(101) },
      { description: 'x'.repeat(2001) },
      { ownerId: 'other' },
      { description: null },
    ])
      await patch({ workExperiences: [{ ...experience, ...fields }] }).expect(
        400,
      );
    await patch({ workExperiences: [experience, experience] }).expect(400);
    await patch({ workExperiences: [experience] }).expect(200);
    await patch({ about: '更新关于' }).expect(200);
    assert.equal(row.workExperiences[0].endDate, '2024-01');
    await patch({ email: 'taken@example.com' }).expect(409);
    // A resized 256px PNG can exceed Express's default 100 KB request limit.
    const bytes = Buffer.alloc(120 * 1024);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    await patch({
      avatar: `data:image/png;base64,${bytes.toString('base64')}`,
    }).expect(200);
    const oversized = Buffer.alloc(301 * 1024);
    await patch({
      avatar: `data:image/png;base64,${oversized.toString('base64')}`,
    }).expect(400);
  } finally {
    await app.close();
  }
});

test('missing profile user returns 404 and partial updates preserve omitted columns', async () => {
  let parameters;
  const users = new UserService({
    pool: {
      query: async (_sql, values) => {
        parameters = values;
        return { rows: [] };
      },
    },
  });
  await assert.rejects(
    users.updateProfile(id, { bio: '' }),
    (error) => error.getStatus() === 404,
  );
  assert.equal(parameters[1], undefined);
  assert.equal(parameters[5], '');
});
