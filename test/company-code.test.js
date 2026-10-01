'use strict';
// The 4-digit company code: owners and staff type it to open a company; clients don't need it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, owner, staff, client, coA, coB;
const OWNER_PW = 'correct horse battery staple';
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-code-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: OWNER_PW }) });
  owner = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(owner, 'POST', '/api/companies', { name: 'Bad Code', code: '12a4' })).status, 400);
  coA = (await call(owner, 'POST', '/api/companies', { name: 'Harbour Yoga', province: 'ON', code: '4821' })).json.company;
  coB = (await call(owner, 'POST', '/api/companies', { name: 'No Code Co', province: 'ON' })).json.company;
  const join = async (username, role, password) => {
    const link = (await call(owner, 'POST', '/api/users', { name: username, username, role, companies: [coA.id, coB.id], invite: true })).json.user.link;
    const a = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link, password }) });
    return a.headers.get('set-cookie').split(';')[0];
  };
  staff = await join('staff@example.com', 'staff', 'velvet tractor ocean pencil');
  client = await join('client@example.com', 'client', 'purple walrus harbour lantern');
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(ck, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie: ck }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const c = (co, p) => `/api/c/${co.id}${p}`;

test('a new company with a code: the creator is in, everyone else types it', async () => {
  assert.equal(coA.hasCode, true); assert.equal(coB.hasCode, false);
  const list = (await call(staff, 'GET', '/api/companies')).json.companies;
  assert.equal(list.find(x => x.id === coA.id).hasCode, true);
  assert.ok(!JSON.stringify(list).includes('4821'));

  assert.equal((await call(owner, 'GET', c(coA, '/state'))).status, 200, 'the owner who created it is already in');
  let r = await call(staff, 'GET', c(coA, '/state'));
  assert.equal(r.status, 423); assert.equal(r.json.codeRequired, true);
  assert.equal((await call(staff, 'PUT', c(coA, '/records/contacts/x'), { kind: 'customer', name: 'X' })).status, 423);
  assert.equal((await call(staff, 'GET', c(coB, '/state'))).status, 200, 'a company without a code opens as before');
  assert.equal((await call(client, 'GET', c(coA, '/state'))).status, 200, 'clients never need the code');

  assert.equal((await call(staff, 'POST', c(coA, '/code/check'), { code: '0000' })).status, 403);
  assert.equal((await call(staff, 'POST', c(coA, '/code/check'), { code: '4821' })).status, 200);
  r = await call(staff, 'GET', c(coA, '/state'));
  assert.equal(r.status, 200); assert.equal(r.json.company.hasCode, true);
  assert.ok(!JSON.stringify(r.json).includes('4821'));

  // A second sign-in (another computer, the other office) types it again.
  const l = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner@example.com', password: OWNER_PW }) });
  const owner2 = l.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(owner2, 'GET', c(coA, '/state'))).status, 423);
  // An owner who forgot it can set a new one without the old one.
  assert.equal((await call(owner2, 'PUT', c(coA, '/code'), { code: '4821' })).status, 200);
  assert.equal((await call(owner2, 'GET', c(coA, '/state'))).status, 200);
});

test('only an owner sets, changes or removes it; changing it signs everyone else out of the company', async () => {
  assert.equal((await call(staff, 'POST', c(coA, '/code/check'), { code: '4821' })).status, 200);
  assert.equal((await call(staff, 'PUT', c(coA, '/code'), { code: '1111' })).status, 403);
  assert.equal((await call(owner, 'PUT', c(coA, '/code'), { code: '99' })).status, 400);
  assert.equal((await call(owner, 'PUT', c(coA, '/code'), { code: '1357' })).status, 200);
  assert.equal((await call(owner, 'GET', c(coA, '/state'))).status, 200, 'the owner who changed it stays in');
  assert.equal((await call(staff, 'GET', c(coA, '/state'))).status, 423, 'staff type the new code');
  assert.equal((await call(staff, 'POST', c(coA, '/code/check'), { code: '4821' })).status, 403, 'the old code no longer works');
  assert.equal((await call(staff, 'POST', c(coA, '/code/check'), { code: '1357' })).status, 200);

  // Set a code on an existing company, then remove it.
  assert.equal((await call(owner, 'PUT', c(coB, '/code'), { code: '2468' })).status, 200);
  assert.equal((await call(staff, 'GET', c(coB, '/state'))).status, 423);
  assert.equal((await call(owner, 'PUT', c(coB, '/code'), { remove: true })).status, 200);
  assert.equal((await call(staff, 'GET', c(coB, '/state'))).status, 200);
  const audit = (await call(owner, 'GET', c(coB, '/audit'))).json;
  assert.ok(JSON.stringify(audit).includes('company code removed'));
});

test('five wrong codes lock that person out of the company for 15 minutes', async () => {
  await call(owner, 'PUT', c(coB, '/code'), { code: '5555' });
  for (let i = 0; i < 5; i++) assert.equal((await call(staff, 'POST', c(coB, '/code/check'), { code: '000' + i })).status, 403);
  assert.equal((await call(staff, 'POST', c(coB, '/code/check'), { code: '5555' })).status, 429, 'even the right code waits');
  assert.equal((await call(owner, 'POST', c(coB, '/code/check'), { code: '5555' })).status, 200, 'other people are not locked out');
});
