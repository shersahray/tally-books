'use strict';
// Several firms on one server: each sees only its own companies, people and sign-ins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, admin, aCo;
const PW = 'correct horse battery staple';
async function req(cookie, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const login = async (username, password = PW) => req(null, 'POST', '/api/auth/login', { username, password });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-firms-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await req(null, 'POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Bookkeeping' });
  assert.equal(r.status, 200);
  admin = r.cookie;
  assert.equal(r.json.user.platformAdmin, true);
  assert.equal(r.json.user.firmName, 'Sher Bookkeeping');
  aCo = (await req(admin, 'POST', '/api/companies', { name: 'Maple Dental', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

let bOwner, bCo, bUserId;
test('sign-ups: off by default, then waiting for approval, then approved', async () => {
  let r = await req(null, 'POST', '/api/auth/signup', { firmName: 'North Ledger', name: 'Nora', username: 'nora@north.ca', password: PW });
  assert.equal(r.status, 403, 'sign-ups are off until an administrator turns them on');
  assert.equal((await req(admin, 'PUT', '/api/firms/settings', { signups: 'sometimes' })).status, 400);
  assert.equal((await req(admin, 'PUT', '/api/firms/settings', { signups: 'approval' })).status, 200);
  const me = await req(null, 'GET', '/api/auth/me');
  assert.equal(me.json.signups, 'approval', 'the sign-in screen can offer sign-up');

  assert.equal((await req(null, 'POST', '/api/auth/signup', { firmName: '', name: 'Nora', username: 'nora@north.ca', password: PW })).status, 400);
  const dup = await req(null, 'POST', '/api/auth/signup', { firmName: 'X', name: 'Sher again', username: 'sher@example.com', password: PW });
  assert.equal(dup.status, 400, 'usernames are unique across firms…');
  assert.doesNotMatch(dup.json.error, /taken|exists/, '…but sign-up doesn’t say which emails have accounts');
  r = await req(null, 'POST', '/api/auth/signup', { firmName: 'North Ledger', name: 'Nora', username: 'nora@north.ca', password: PW });
  assert.equal(r.status, 200); assert.equal(r.json.pending, true); assert.equal(r.cookie, '', 'not signed in while waiting');
  r = await login('nora@north.ca');
  assert.equal(r.status, 403); assert.match(r.json.error, /waiting for approval/);

  const firms = (await req(admin, 'GET', '/api/firms')).json;
  const nl = firms.firms.find(f => f.name === 'North Ledger');
  assert.equal(nl.status, 'pending'); assert.equal(nl.ai, false); assert.equal(nl.owner.username, 'nora@north.ca');
  assert.equal(firms.firms.find(f => f.id === firms.myFirm).companies, 1);
  assert.equal((await req(admin, 'PUT', `/api/firms/${nl.id}`, { status: 'active' })).status, 200);
  r = await login('nora@north.ca');
  assert.equal(r.status, 200);
  bOwner = r.cookie;
  assert.equal(r.json.user.platformAdmin, false);
  assert.equal(r.json.user.firmName, 'North Ledger');
});

test('each firm sees only its own companies', async () => {
  assert.deepEqual((await req(bOwner, 'GET', '/api/companies')).json.companies, []);
  bCo = (await req(bOwner, 'POST', '/api/companies', { name: 'Birch Cafe', province: 'NS' })).json.company.id;
  assert.deepEqual((await req(bOwner, 'GET', '/api/companies')).json.companies.map(c => c.name), ['Birch Cafe']);
  assert.deepEqual((await req(admin, 'GET', '/api/companies')).json.companies.map(c => c.name), ['Maple Dental']);
  // The other firm's books: as if they didn't exist.
  assert.equal((await req(bOwner, 'GET', `/api/c/${aCo}/state`)).status, 404);
  assert.equal((await req(admin, 'GET', `/api/c/${bCo}/state`)).status, 404, 'not even the administrator opens another firm’s books');
  assert.equal((await req(bOwner, 'PUT', `/api/c/${aCo}/records/entries/x`, { type: 'journal', date: '2026-01-01', lines: [] })).status, 404);
  assert.equal((await req(bOwner, 'PUT', `/api/companies/${aCo}`, { archived: true })).status, 404);
  assert.equal((await req(bOwner, 'POST', '/api/companies', { name: 'Copycat', copyFrom: aCo })).status, 400, 'can’t copy another firm’s chart of accounts');
  assert.equal((await req(bOwner, 'GET', `/api/c/${bCo}/state`)).status, 200);
});

test('each firm manages only its own people', async () => {
  const bUsers = (await req(bOwner, 'GET', '/api/users')).json;
  assert.deepEqual(bUsers.users.map(u => u.username), ['nora@north.ca']);
  assert.equal(bUsers.firm.name, 'North Ledger');
  const sherId = (await req(admin, 'GET', '/api/users')).json.users[0].id;
  assert.equal((await req(bOwner, 'PUT', `/api/users/${sherId}`, { disabled: true })).status, 404);
  assert.equal((await req(bOwner, 'POST', `/api/users/${sherId}/link`, {})).status, 404);
  assert.equal((await req(bOwner, 'POST', '/api/users', { name: 'Spy', username: 'spy@north.ca', role: 'client', companies: [aCo], invite: true })).status, 404);
  const add = await req(bOwner, 'POST', '/api/users', { name: 'Ben', username: 'ben@north.ca', role: 'staff', companies: [bCo], invite: true });
  assert.equal(add.status, 200);
  bUserId = add.json.user.id;
  assert.equal(add.json.user.firmId, (await req(bOwner, 'GET', '/api/firm')).json.firm.id);
  assert.deepEqual((await req(admin, 'GET', '/api/users')).json.users.map(u => u.username), ['sher@example.com']);
  assert.equal((await req(admin, 'PUT', `/api/users/${bUserId}`, { disabled: true })).status, 404, 'the administrator doesn’t manage other firms’ people');
  // The last owner of a firm stays an owner, counted within that firm.
  const noraId = bUsers.users[0].id;
  assert.equal((await req(bOwner, 'PUT', `/api/users/${noraId}`, { role: 'staff' })).status, 409);
  // Sign-in activity: only their own people.
  const log = (await req(bOwner, 'GET', '/api/security/log')).json.log;
  assert.ok(log.length && log.every(e => [e.username, e.by].some(n => /@north\.ca$/.test(n || ''))), 'only North Ledger’s sign-ins');
  assert.ok((await req(admin, 'GET', '/api/security/log')).json.log.some(e => e.username === 'nora@north.ca'), 'the administrator sees the whole server');
});

test('server-wide settings are for the administrator only', async () => {
  assert.equal((await req(bOwner, 'PUT', '/api/security', { idleMinutes: 5 })).status, 403);
  assert.equal((await req(bOwner, 'GET', '/api/firms')).status, 403);
  assert.equal((await req(bOwner, 'GET', '/api/overview')).status, 403, 'the overview is for the administrator');
  assert.equal((await req(bOwner, 'GET', '/api/overview/downloads')).status, 403);
  assert.equal((await req(bOwner, 'PUT', '/api/firms/settings', { signups: 'open' })).status, 403);
  assert.equal((await req(bOwner, 'PUT', '/api/backups', { keepDays: 1 })).status, 403);
  assert.equal((await req(bOwner, 'POST', '/api/backups/run', {})).status, 403);
  assert.equal((await req(bOwner, 'PUT', '/api/ai', { apiKey: 'sk-ant-x' })).status, 403);
  const bk = (await req(bOwner, 'GET', '/api/backups')).json;
  assert.equal(bk.limited, true); assert.equal(bk.folder, undefined, 'where backups are kept is the administrator’s business');
  assert.equal((await req(bOwner, 'GET', '/api/ai')).json.firmAllowed, false);
  const ai = await req(bOwner, 'POST', `/api/c/${bCo}/ai/suggest`, { ids: ['x'] });
  assert.equal(ai.status, 403); assert.match(ai.json.error, /isn’t part of this company’s plan/, 'firms that sign up start on Essentials');
  // Owners can rename their own firm.
  assert.equal((await req(bOwner, 'PUT', '/api/firm', { name: 'North Ledger Inc.' })).json.firm.name, 'North Ledger Inc.');
});

test('suspending a firm signs its people out; the administrator’s own firm can’t be suspended', async () => {
  const firms = (await req(admin, 'GET', '/api/firms')).json;
  assert.equal((await req(admin, 'PUT', `/api/firms/${firms.myFirm}`, { status: 'suspended' })).status, 409);
  const nl = firms.firms.find(f => f.name === 'North Ledger Inc.');
  assert.equal((await req(admin, 'PUT', `/api/firms/${nl.id}`, { status: 'suspended' })).status, 200);
  assert.equal((await req(bOwner, 'GET', '/api/companies')).status, 401);
  const r = await login('nora@north.ca');
  assert.equal(r.status, 403); assert.match(r.json.error, /suspended/);
  await req(admin, 'PUT', `/api/firms/${nl.id}`, { status: 'active', ai: true });
  bOwner = (await login('nora@north.ca')).cookie;
  assert.equal((await req(bOwner, 'GET', '/api/ai')).json.firmAllowed, true);
});

test('plans: Essentials leaves out payroll, AI, advanced reports and special tax methods; Plus has them; each company can switch them off', async () => {
  const firms = (await req(admin, 'GET', '/api/firms')).json;
  const nl = firms.firms.find(f => f.name === 'North Ledger Inc.');
  assert.equal(nl.plan, 'essentials'); assert.equal(firms.defaultPlan, 'essentials');
  assert.equal(firms.firms.find(f => f.id === firms.myFirm).plan, 'plus', 'the administrator’s own firm has everything');
  assert.equal((await req(bOwner, 'GET', '/api/auth/me')).json.user.firmPlan, 'essentials');
  const emp = { name: 'Pat Payroll', prov: 'NS', freq: 'biweekly', payType: 'salary', rate: 52000, td1Fed: '' };
  let r = await req(bOwner, 'PUT', `/api/c/${bCo}/records/employees/e1`, emp);
  assert.equal(r.status, 403); assert.match(r.json.error, /Payroll isn’t part/);
  assert.equal((await req(bOwner, 'POST', `/api/c/${bCo}/batch`, { writes: [{ op: 'set', collection: 'payruns', id: 'p1', data: {} }] })).status, 403, 'not through a batch either');
  assert.equal((await req(bOwner, 'PUT', `/api/c/${bCo}/records/filings/f1`, { tax: 'gst', method: 'quick', from: '2026-07-01', to: '2026-09-30', filedOn: '2026-10-15', lines: { 101: 1000 } })).status, 403);
  const st = (await req(bOwner, 'GET', `/api/c/${bCo}/state`)).json.company;
  assert.equal((await req(bOwner, 'PUT', `/api/c/${bCo}/settings`, { ...st, quickMethod: { on: true, from: '2026-01-01', type: 'service' } })).status, 403);
  assert.equal((await req(bOwner, 'PUT', `/api/c/${bCo}/settings`, { ...st, savedReports: [{ id: 'r1', name: 'Monthly', tab: 'pl' }] })).status, 403);
  // Ordinary bookkeeping is in every plan.
  assert.equal((await req(bOwner, 'PUT', `/api/c/${bCo}/records/filings/f1`, { tax: 'gst', from: '2026-07-01', to: '2026-09-30', filedOn: '2026-10-15', lines: { 109: 100 } })).status, 200);
  // Only the administrator changes plans.
  assert.equal((await req(bOwner, 'PUT', `/api/firms/${nl.id}`, { plan: 'plus' })).status, 403);
  assert.equal((await req(admin, 'PUT', `/api/firms/${nl.id}`, { plan: 'gold' })).status, 400);
  assert.equal((await req(admin, 'PUT', `/api/firms/${nl.id}`, { plan: 'plus' })).status, 200);
  assert.equal((await req(bOwner, 'GET', '/api/auth/me')).json.user.firmPlan, 'plus');
  assert.equal((await req(bOwner, 'PUT', `/api/c/${bCo}/records/employees/e1`, emp)).status, 200);
  // A client who doesn't need payroll: switched off for this company only.
  r = await req(bOwner, 'PUT', `/api/c/${bCo}/settings`, { ...st, features: { payroll: false, ai: true, nonsense: false } });
  assert.equal(r.status, 200);
  assert.deepEqual((await req(bOwner, 'GET', `/api/c/${bCo}/state`)).json.company.features, { payroll: false }, 'only switches that are off are kept');
  assert.equal((await req(bOwner, 'PUT', `/api/c/${bCo}/records/employees/e2`, { ...emp, name: 'Sam' })).status, 403);
  assert.ok((await req(bOwner, 'GET', `/api/c/${bCo}/state`)).json.employees.some(e => e.id === 'e1'), 'switching off keeps the records');
  assert.equal((await req(bOwner, 'PUT', `/api/c/${bCo}/settings`, { ...st, features: {} })).status, 200);
  assert.equal((await req(bOwner, 'PUT', `/api/c/${bCo}/records/employees/e2`, { ...emp, name: 'Sam' })).status, 200);
  // The plan new firms get when they sign up.
  assert.equal((await req(admin, 'PUT', '/api/firms/settings', { defaultPlan: 'gold' })).status, 400);
  assert.equal((await req(admin, 'PUT', '/api/firms/settings', { defaultPlan: 'plus' })).status, 200);
  assert.equal((await req(admin, 'GET', '/api/firms')).json.defaultPlan, 'plus');
  await req(admin, 'PUT', '/api/firms/settings', { defaultPlan: 'essentials' });
});

test('open sign-ups sign the new firm straight in; at most 5 sign-up tries a day from one network', async () => {
  await req(admin, 'PUT', '/api/firms/settings', { signups: 'open' });
  const r = await req(null, 'POST', '/api/auth/signup', { firmName: 'Coast Books', name: 'Cal', username: 'cal@coast.ca', password: PW });
  assert.equal(r.status, 200); assert.ok(r.cookie.startsWith('tb_session='));
  assert.deepEqual((await req(r.cookie, 'GET', '/api/companies')).json.companies, []);
  // Five tries from this address today (failed ones count too, so sign-up can't be used to test emails).
  assert.equal((await req(null, 'POST', '/api/auth/signup', { firmName: 'Six', name: 'S', username: 't6@x.ca', password: PW })).status, 429);
});

test('books from before firms existed become the first firm, run by its owners', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-firms-old-'));
  fs.writeFileSync(path.join(d, 'users.json'), JSON.stringify({ version: 1, users: [
    { id: 'u_1', name: 'Owner', username: 'o@x.ca', role: 'owner', companies: [], created: 1 },
    { id: 'u_2', name: 'Staff', username: 's@x.ca', role: 'staff', companies: [], created: 2 }], settings: {} }));
  fs.mkdirSync(path.join(d, 'companies'));
  fs.writeFileSync(path.join(d, 'companies.json'), JSON.stringify({ version: 1, companies: [{ id: 'co_old', name: 'Old Co', file: 'companies/co_old.db', archived: false, created: 1 }] }));
  const app = createApp({ dataDir: d, autoBackup: false });
  try {
    const users = JSON.parse(fs.readFileSync(path.join(d, 'users.json'), 'utf8'));
    assert.equal(users.firms.length, 1);
    assert.ok(users.users.every(u => u.firmId === users.firms[0].id));
    assert.equal(users.users[0].platformAdmin, true); assert.ok(!users.users[1].platformAdmin);
    assert.equal(users.firms[0].ai, true, 'the original firm keeps AI');
    const cos = JSON.parse(fs.readFileSync(path.join(d, 'companies.json'), 'utf8'));
    assert.equal(cos.companies[0].firmId, users.firms[0].id);
  } finally { await app.shutdown(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('administrators’ accounts are protected from other owners; the server always keeps an administrator', async () => {
  const add = await req(admin, 'POST', '/api/users', { name: 'Ann', username: 'ann@sher.ca', role: 'owner', invite: true });
  const annId = add.json.user.id;
  await req(null, 'POST', '/api/auth/link/accept', { token: add.json.user.link, password: PW });
  const ann = (await login('ann@sher.ca')).cookie;
  const sherId = (await req(admin, 'GET', '/api/users')).json.users.find(u => u.username === 'sher@example.com').id;
  // An ordinary owner can't take over or lock out the administrator.
  for (const [method, url, body] of [['POST', `/api/users/${sherId}/link`, {}], ['PUT', `/api/users/${sherId}`, { reset2fa: true }], ['PUT', `/api/users/${sherId}`, { disabled: true }], ['PUT', `/api/users/${sherId}`, { role: 'staff' }], ['PUT', `/api/users/${annId}`, { platformAdmin: true }]]) {
    assert.equal((await req(ann, method, url, body)).status, 403, `${method} ${url} ${JSON.stringify(body)}`);
  }
  assert.equal((await req(ann, 'GET', '/api/firms')).status, 403);
  // The only administrator can't be demoted, turned off, or stop being an administrator.
  assert.equal((await req(admin, 'PUT', `/api/users/${sherId}`, { platformAdmin: false })).status, 409);
  // Make Ann an administrator too: then Sher can step down, and back.
  assert.equal((await req(admin, 'PUT', `/api/users/${annId}`, { platformAdmin: true })).json.user.platformAdmin, true);
  assert.equal((await req(ann, 'GET', '/api/firms')).status, 200);
  assert.equal((await req(admin, 'PUT', `/api/users/${sherId}`, { platformAdmin: false })).status, 200);
  assert.equal((await req(ann, 'PUT', `/api/users/${sherId}`, { platformAdmin: true })).json.user.platformAdmin, true);
  // Server-wide events stay out of an ordinary firm's sign-in activity.
  const nora = (await login('nora@north.ca')).cookie;
  const log = (await req(nora, 'GET', '/api/security/log')).json.log;
  assert.ok(!log.some(e => ['firm-changed', 'security-changed', 'ai-settings', 'firm-signup'].includes(e.event)));
  // Backups: no server-wide numbers for other firms.
  assert.equal((await req(nora, 'GET', '/api/backups')).json.lastCount, undefined);
});

test('a firm that never got going can be removed, freeing its email; firms with books can’t', async () => {
  const firms = (await req(admin, 'GET', '/api/firms')).json.firms;
  const three = firms.find(f => f.name === 'Coast Books');
  assert.equal((await req(admin, 'DELETE', `/api/firms/${three.id}`)).status, 409, 'suspend first');
  await req(admin, 'PUT', `/api/firms/${three.id}`, { status: 'suspended' });
  assert.equal((await req(admin, 'DELETE', `/api/firms/${three.id}`)).status, 200);
  assert.ok(!(await req(admin, 'GET', '/api/firms')).json.firms.some(f => f.id === three.id));
  assert.equal((await login('cal@coast.ca')).status, 401, 'its people are gone');
  const nl = firms.find(f => f.name === 'North Ledger Inc.');
  await req(admin, 'PUT', `/api/firms/${nl.id}`, { status: 'suspended' });
  assert.equal((await req(admin, 'DELETE', `/api/firms/${nl.id}`)).status, 409, 'it has a company');
  await req(admin, 'PUT', `/api/firms/${nl.id}`, { status: 'active', aiCapUsd: 5 });
  assert.equal((await req(admin, 'GET', '/api/firms')).json.firms.find(f => f.id === nl.id).aiCapUsd, 5);
});

test('live updates: only your own firm’s, and they stop when the session ends', async () => {
  const nora = (await login('nora@north.ca')).cookie;
  const ctl = new AbortController(), got = [];
  const res = await fetch(base + '/api/events', { headers: { cookie: nora }, signal: ctl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let closed = false;
  (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) { closed = true; break; } got.push(dec.decode(value)); } } catch { closed = true; } })();
  await new Promise(r => setTimeout(r, 100));
  await req(admin, 'POST', '/api/companies', { name: 'Another Sher client', province: 'ON' }); // the administrator's firm
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!got.join('').includes('"companies":true'), 'no news of other firms’ companies');
  await req(nora, 'POST', '/api/auth/logout', {});
  await req(admin, 'POST', '/api/companies', { name: 'One more', province: 'ON' });
  await new Promise(r => setTimeout(r, 150));
  assert.ok(closed, 'the stream ended with the session');
  ctl.abort();
});
