import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../dist/auth/auth.service.js';

test('registration hashes passwords, login rejects bad credentials, logout revokes sessions', async () => {
  let stored;
  let session;
  const database = {
    pool: {
      async query(sql, values) {
        if (sql.startsWith('INSERT INTO users')) {
          stored = {
            id: values[0],
            name: values[1],
            email: values[2],
            username: values[3],
            password_hash: values[4],
          };
          const { password_hash: _passwordHash, ...publicUser } = stored;
          return { rows: [publicUser] };
        }
        if (sql.includes('LOWER(username)'))
          return {
            rows:
              stored &&
              values[0].toLowerCase() === stored.username.toLowerCase()
                ? [{ ...stored }]
                : [],
          };
        if (sql.startsWith('INSERT INTO user_sessions')) {
          session = { hash: values[0], id: values[1] };
          return { rows: [] };
        }
        if (sql.startsWith('SELECT user_id'))
          return {
            rows: session?.hash === values[0] ? [{ user_id: session.id }] : [],
          };
        if (sql.startsWith('DELETE FROM user_sessions WHERE token_hash')) {
          if (session?.hash === values[0]) session = null;
          return { rows: [] };
        }
        if (sql.includes('FROM users WHERE id')) {
          const { password_hash: _passwordHash, ...publicUser } = stored;
          return { rows: [publicUser] };
        }
        return { rows: [] };
      },
    },
  };
  const auth = new AuthService(database);
  await assert.rejects(
    auth.register({ username: 'ab', email: 'bad', password: 'short' }),
    /用户名/,
  );
  await assert.rejects(
    auth.register({
      username: 'reader',
      email: 'a@example.com',
      password: 'abcdefgh',
    }),
    /密码/,
  );
  const registered = await auth.register({
    username: 'reader',
    email: 'A@EXAMPLE.COM',
    password: 'Secure123!',
  });
  assert.equal(registered.email, 'a@example.com');
  assert.equal(registered.password_hash, undefined);
  assert.notEqual(stored.password_hash, 'Secure123!');
  assert.match(stored.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  await assert.rejects(
    auth.login({ username: 'reader', password: 'wrong' }),
    /用户名或密码/,
  );
  await assert.rejects(
    auth.login({ username: 'missing', password: 'Secure123!' }),
    /用户名或密码/,
  );
  const { user, token } = await auth.login({
    username: 'READER',
    password: 'Secure123!',
  });
  assert.equal(user.password_hash, undefined);
  assert.notEqual(session.hash, token);
  assert.equal((await auth.me(token)).id, registered.id);
  await assert.rejects(auth.me('invalid'), /请先登录/);
  await auth.logout(token);
  await assert.rejects(auth.me(token), /请先登录/);
});
