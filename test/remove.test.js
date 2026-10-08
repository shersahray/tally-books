'use strict';
// Removing what was made by mistake: an empty company, and a person who never signed in.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, owner;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-remove-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await call('POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' })).cookie;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('an empty company can be removed (its file is kept aside); one with transactions can only be archived', async () => {
  const empty = (await call('POST', '/api/companies', { name: 'Typo Co', province: 'ON' }, owner)).json.company.id;
  const used = (await call('POST', '/api/companies', { name: 'Real Co', province: 'ON' }, owner)).json.company.id;
  await call('PUT', `/api/c/${used}/records/entries/e1`, { type: 'journal', date: '2026-10-01', lines: [{ account: 'a1000', debit: 10, credit: 0 }, { account: 'a6000', debit: 0, credit: 10 }] }, owner);
  const link = (await call('POST', '/api/users', { name: 'C', username: 'c@example.com', role: 'client', companies: [empty], invite: true }, owner)).json.user;
  assert.equal((await call('DELETE', `/api/companies/${used}`, undefined, owner)).status, 409);
  assert.equal((await call('DELETE', `/api/companies/${empty}`, undefined, owner)).status, 200);
  assert.ok(!(await call('GET', '/api/companies', undefined, owner)).json.companies.some(c => c.id === empty));
  assert.equal(fs.readdirSync(path.join(dir, 'removed-companies')).filter(f => f.startsWith(empty)).length, 1, 'kept aside, not deleted');
  const users = (await call('GET', '/api/users', undefined, owner)).json.users;
  assert.deepEqual(users.find(u => u.username === 'c@example.com').companies, [], 'nobody keeps access to it');
  assert.equal((await call('GET', `/api/c/${empty}/state`, undefined, owner)).status, 404);
  void link;
});

test('a person who never signed in can be removed; someone who has signed in is turned off instead', async () => {
  const co = (await call('POST', '/api/companies', { name: 'ABC', province: 'ON' }, owner)).json.company.id;
  const wrong = (await call('POST', '/api/users', { name: 'Wrong', username: 'wrong@exmaple.com', role: 'client', companies: [co], invite: true }, owner)).json.user;
  const right = (await call('POST', '/api/users', { name: 'Right', username: 'right@example.com', role: 'client', companies: [co], invite: true }, owner)).json.user;
  await call('POST', '/api/auth/link/accept', { token: right.link, password: 'client long phrase' });
  assert.equal((await call('DELETE', `/api/users/${right.id}`, undefined, owner)).status, 409);
  assert.equal((await call('DELETE', `/api/users/${wrong.id}`, undefined, owner)).status, 200);
  assert.equal((await call('POST', '/api/auth/link/accept', { token: wrong.link, password: 'another long phrase' })).status, 410, 'the old invitation no longer works');
  const me = (await call('GET', '/api/users', undefined, owner)).json.users.find(u => u.username === 'sher@example.com');
  assert.equal((await call('DELETE', `/api/users/${me.id}`, undefined, owner)).status, 409, 'not yourself');
  // The email can be invited again, correctly this time.
  assert.equal((await call('POST', '/api/users', { name: 'Wrong', username: 'wrong@exmaple.com', role: 'client', companies: [co], invite: true }, owner)).status, 200);
});

test('imported accounts can be removed in one go; those still in use stay', async () => {
  const co = (await call('POST', '/api/companies', { name: 'Pizza Co', province: 'QC' }, owner)).json.company.id;
  const put = (id, data) => call('PUT', `/api/c/${co}/records/accounts/${id}`, data, owner);
  await put('i100', { code: '100', name: 'Encaisse Desjardins', type: 'Asset', detail: 'bank', imported: 'QuickBooks' });
  await put('i511', { code: '511', name: 'Loyer', type: 'Expense', detail: '', imported: 'QuickBooks' });
  await put('i527', { code: '527', name: 'Royautés', type: 'Expense', detail: '', imported: 'QuickBooks' });
  await put('mine', { code: '999', name: 'Added by hand', type: 'Expense', detail: '' });
  await call('PUT', `/api/c/${co}/records/entries/ob`, { type: 'journal', date: '2025-01-31', lines: [{ account: 'i100', debit: 10, credit: 0 }, { account: 'i511', debit: 0, credit: 10 }], opening: true, imported: 'QuickBooks' }, owner);
  const r = await call('POST', `/api/c/${co}/accounts/remove-imported`, {}, owner);
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, 1);
  assert.deepEqual(r.json.kept.sort(), ['Encaisse Desjardins', 'Loyer']);
  let ids = (await call('GET', `/api/c/${co}/state`, undefined, owner)).json.accounts.map(a => a.id);
  assert.ok(!ids.includes('i527') && ids.includes('i100') && ids.includes('mine'), 'only the unused imported account goes; hand-made ones stay');
  // Once the opening balance entry is deleted, the rest can go too.
  await call('DELETE', `/api/c/${co}/records/entries/ob`, undefined, owner);
  assert.equal((await call('POST', `/api/c/${co}/accounts/remove-imported`, {}, owner)).json.removed, 2);
  ids = (await call('GET', `/api/c/${co}/state`, undefined, owner)).json.accounts.map(a => a.id);
  assert.ok(!ids.includes('i100') && !ids.includes('i511') && ids.includes('mine'));
  assert.equal((await call('POST', `/api/c/${co}/accounts/remove-imported`, {}, owner)).status, 404, 'nothing left to remove');
});
