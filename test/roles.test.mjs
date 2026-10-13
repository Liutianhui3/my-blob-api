import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RolesService } from '../dist/roles/roles.service.js';
import { AdminGuard } from '../dist/auth/guards/admin.guard.js';
const id = '00000000-0000-4000-8000-000000000001';
function fixture({ actor = true, target = false, count = 2 } = {}) {
  const calls = [];
  const client = {
    release() {
      calls.push('release');
    },
    async query(sql, values) {
      calls.push(sql);
      if (sql.includes('FOR UPDATE')) return { rows: [{ is_admin: target }] };
      if (sql.startsWith('SELECT is_admin'))
        return { rows: [{ is_admin: actor }] };
      if (sql.includes('COUNT')) return { rows: [{ count }] };
      if (sql.startsWith('UPDATE'))
        return { rows: [{ id, isAdmin: values[1] }] };
      return { rows: [] };
    },
  };
  return {
    calls,
    service: new RolesService({ pool: { connect: async () => client } }),
  };
}
test('admin guard rejects guests and ordinary users', () => {
  const guard = new AdminGuard();
  for (const user of [undefined, { isAdmin: false }])
    assert.throws(
      () =>
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => ({ user }) }),
        }),
      (e) => e.getStatus() === 403,
    );
  assert.equal(
    guard.canActivate({
      switchToHttp: () => ({ getRequest: () => ({ user: { isAdmin: true } }) }),
    }),
    true,
  );
});
test('role grants and revocations commit and release connection', async () => {
  for (const isAdmin of [true, false]) {
    const { service, calls } = fixture({ target: !isAdmin });
    assert.equal((await service.update(id, id, { isAdmin })).isAdmin, isAdmin);
    assert.ok(calls.includes('COMMIT'));
    assert.equal(calls.at(-1), 'release');
  }
});
test('revoked caller and last administrator changes roll back without update', async () => {
  for (const [options, status] of [
    [{ actor: false }, 403],
    [{ target: true, count: 1 }, 409],
  ]) {
    const { service, calls } = fixture(options);
    await assert.rejects(
      service.update(id, id, { isAdmin: false }),
      (e) => e.getStatus() === status,
    );
    assert.ok(calls.includes('ROLLBACK'));
    assert.ok(!calls.some((sql) => sql.startsWith('UPDATE')));
  }
});
test('role body cannot accept strings or extra fields', async () => {
  for (const body of [
    { isAdmin: 'true' },
    { isAdmin: true, password: 'x' },
    {},
    null,
  ]) {
    const { service, calls } = fixture();
    await assert.rejects(
      service.update(id, id, body),
      (e) => e.getStatus() === 400,
    );
    assert.deepEqual(calls, []);
  }
});
