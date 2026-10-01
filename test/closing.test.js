'use strict';
// Closing the books: closed periods can't be changed without unlocking, clients never.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, co, owner, staff, client;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-close-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  owner = r.headers.get('set-cookie').split(';')[0];
  co = (await call(owner, 'POST', '/api/companies', { name: 'Close Co', province: 'ON' })).json.company.id;
  const join = async (username, role, password) => {
    const link = (await call(owner, 'POST', '/api/users', { name: username, username, role, companies: [co], invite: true })).json.user.link;
    const a = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link, password }) });
    return a.headers.get('set-cookie').split(';')[0];
  };
  staff = await join('staff@example.com', 'staff', 'velvet tractor ocean pencil');
  client = await join('client@example.com', 'client', 'purple walrus harbour lantern');
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(ck, method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie: ck }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const je = (date, amt = 100) => ({ type: 'journal', date, memo: 'test', lines: [{ account: 'a1000', debit: amt, credit: 0 }, { account: 'a3000', debit: 0, credit: amt }] });

test('closed periods are protected, and unlocking works', async () => {
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/old', je('2025-12-15'))).status, 200);
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/new', je('2026-01-15'))).status, 200);
  assert.equal((await call(staff, 'PUT', '/api/c/closing', { date: '2025-12-31' })).status, 403, 'only an owner closes the books');
  assert.equal((await call(owner, 'PUT', '/api/c/closing', { date: '2025-12-31', password: 'yearend2025' })).status, 200);
  const st = (await call(owner, 'GET', '/api/c/state')).json;
  assert.equal(st.company.closingDate, '2025-12-31'); assert.equal(st.company.closingPassword, true);
  assert.ok(!JSON.stringify(st).includes('yearend2025'));

  // Changing, deleting or adding in the closed period: refused.
  let r = await call(owner, 'PUT', '/api/c/records/entries/old', je('2025-12-15', 200));
  assert.equal(r.status, 423); assert.equal(r.json.closedThrough, '2025-12-31');
  assert.equal((await call(owner, 'DELETE', '/api/c/records/entries/old')).status, 423);
  assert.equal((await call(staff, 'PUT', '/api/c/records/entries/x1', je('2025-11-01'))).status, 423);
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/new', je('2025-12-20'))).status, 423, 'moving an entry into the closed period');
  // Open periods, and ticking an old entry as reconciled, still work.
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/new', je('2026-01-20', 150))).status, 200);
  const old = (await call(owner, 'GET', '/api/c/state')).json.entries.find(e => e.id === 'old');
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/old', { ...old, id: undefined, clear: { a1000: 'r' } })).status, 200);

  // Unlocking: a client can't; a wrong password is refused; the right one opens it for this session only.
  assert.equal((await call(client, 'POST', '/api/c/closing/unlock', { password: 'yearend2025' })).status, 403);
  assert.equal((await call(staff, 'POST', '/api/c/closing/unlock', { password: 'nope' })).status, 403);
  assert.equal((await call(staff, 'POST', '/api/c/closing/unlock', { password: 'yearend2025' })).status, 200);
  assert.equal((await call(staff, 'PUT', '/api/c/records/entries/old', je('2025-12-15', 250))).status, 200);
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/old', je('2025-12-15', 300))).status, 423, 'the owner’s session is still locked');
  r = await call(client, 'PUT', '/api/c/records/entries/c1', je('2025-10-01'));
  assert.equal(r.status, 423); assert.match(r.json.error, /bookkeeper/);

  // Settings changes keep the closing date; reopening clears it; wrong passwords lock out after 5.
  await call(owner, 'PUT', '/api/c/settings', { ...st.company, name: 'Close Co Ltd' });
  assert.equal((await call(owner, 'GET', '/api/c/state')).json.company.closingDate, '2025-12-31');
  for (let i = 0; i < 5; i++) await call(owner, 'POST', '/api/c/closing/unlock', { password: 'wrong' });
  assert.equal((await call(owner, 'POST', '/api/c/closing/unlock', { password: 'yearend2025' })).status, 429);
  assert.equal((await call(owner, 'PUT', '/api/c/closing', { date: '' })).status, 200);
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/old', je('2025-12-15', 300))).status, 200);
  const log = (await call(owner, 'GET', '/api/c/audit')).json.rows.map(x => x.action);
  assert.ok(log.includes('closing') && log.includes('unlock'));
});
