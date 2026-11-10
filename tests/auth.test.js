const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const express = require('express');
const db = require('../database/database');
const portal = require('../server');
const { loadSession, requireRole } = require('../middleware/auth');

test('session authentication, protected routes, roles and logout', async () => {
  const originalQuery = db.query;
  let client;
  let server;
  try {
    await db.initialize();
    client = await db.connect();
    await client.query('BEGIN');
    db.query = (sql, values) => client.query(sql, values);
    const createSession = async (role, expired = false) => {
      const name = `auth_test_${randomBytes(8).toString('hex')}`;
      const { rows: [user] } = await client.query(
        'INSERT INTO "user" (user_name, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
        [name, 'test-only', role]);
      const token = randomBytes(32).toString('hex');
      await client.query('INSERT INTO "session" (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + (expired ? -60000 : 60000))]);
      return { cookie: `session_id=${token}`, id: user.id, name };
    };
    const customer = await createSession('client');
    const staff = await createSession('staff');
    const expired = await createSession('client', true);
    const app = express();
    app.get('/staff-test', loadSession, requireRole('staff'), (req, res) => res.json(req.user));
    app.use(portal);
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, options = {}, cookie = '') => fetch(base + route, {
      ...options, redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', cookie, ...options.headers },
    });
    for (const cookie of ['', 'session_id=%ZZ', 'session_id=unknown', expired.cookie]) {
      assert.deepEqual(await (await request('/api/me', {}, cookie)).json(), { user_id: null });
      assert.equal((await request('/api/products?start_id=1&end_id=15', {}, cookie)).status, 401);
      assert.equal((await request('/api/orders/analyze', { method: 'POST', body: '{}' }, cookie)).status, 401);
      const home = await request('/home.html', {}, cookie);
      assert.equal(home.status, 302);
      assert.equal(home.headers.get('location'), '/login.html');
      const staffPage = await request('/staff.html', {}, cookie);
      assert.equal(staffPage.status, 302);
      assert.equal(staffPage.headers.get('location'), '/login.html');
    }
    assert.deepEqual(await (await request('/api/me', {}, customer.cookie)).json(), {
      user_id: customer.id, user_name: customer.name, role: 'client',
    });
    assert.equal((await request('/home.html', {}, customer.cookie)).status, 200);
    assert.equal((await request('/api/products?start_id=1&end_id=15', {}, customer.cookie)).status, 200);
    // Invalid data reaches validation after authentication, without calling AI.
    assert.equal((await request('/api/orders/analyze', { method: 'POST', body: '{}' }, customer.cookie)).status, 400);
    assert.equal((await request('/staff-test')).status, 401);
    assert.equal((await request('/staff-test', { headers: { role: 'staff' } }, customer.cookie)).status, 403);
    assert.equal((await request('/staff-test', {}, staff.cookie)).status, 200);
    const blockedPage = await request('/staff.html', {}, customer.cookie);
    assert.equal(blockedPage.status, 403);
    assert.equal(blockedPage.headers.get('cache-control'), 'no-store');
    const allowedPage = await request('/staff.html', {}, staff.cookie);
    assert.equal(allowedPage.status, 200);
    assert.match(await allowedPage.text(), /Trang dành cho nhân viên/);
    assert.equal((await request('/views/staff.html', {}, customer.cookie)).status, 404);
    // Encoded or alternate static paths must not expose the protected HTML.
    for (const route of ['/%73taff.html', '/staff%2ehtml', '/staff.html/']) {
      const response = await request(route, {}, customer.cookie);
      assert.notEqual(response.status, 200);
    }
    const logout = await request('/api/logout', { method: 'POST' }, customer.cookie);
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /session_id=;/);
    assert.deepEqual(await (await request('/api/me', {}, customer.cookie)).json(), { user_id: null });
    assert.equal((await request('/api/logout', { method: 'POST' })).status, 204);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    db.query = originalQuery;
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await db.end();
  }
});
