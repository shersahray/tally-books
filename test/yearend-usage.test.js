'use strict';
require('./setup-payroll-on'); // year-end files switched on, as `npm test` runs them
// Year-end files started, counted per firm and month for charging per file (the administrator's Overview).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

const PW = 'correct horse battery staple';
let server, base, dir, admin, firmB, coA, coB, coB2;
async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function start(opts) {
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, autoWorkflows: false, ...opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function file(co, cookie, yearEnd) {
  const st = (await call('GET', `/api/c/${co}/state`, undefined, cookie)).json;
  const bank = st.accounts.find(a => a.detail === 'bank').id, sales = st.accounts.find(a => a.type === 'Income').id;
  return { yearEnd, snapshot: { lines: [{ account: bank, name: 'Bank', type: 'Asset', cur: 10, prior: 0 }, { account: sales, name: 'Sales', type: 'Income', cur: -10, prior: 0 }] } };
}
const usage = async month => (await call('GET', '/api/overview/yearends' + (month ? '?month=' + month : ''), undefined, admin)).json;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-yeusage-'));
  await start();
  admin = (await call('POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Books' })).cookie;
  coA = (await call('POST', '/api/companies', { name: 'Own Client', province: 'ON' }, admin)).json.company.id;
  // A file started before counting began is picked up the first time the overview is opened.
  assert.equal((await call('PUT', `/api/c/${coA}/records/engagements/old`, await file(coA, admin, '2024-12-31'), admin)).status, 200);
  fs.rmSync(path.join(dir, 'yearend-usage.json'));
  const inv = (await call('POST', '/api/firms/invite', { firmName: 'North Ledger', name: 'Nora', email: 'nora@north.example', plan: 'thrive' }, admin)).json;
  firmB = (await call('POST', '/api/auth/link/accept', { token: inv.user.link, password: PW, acceptTerms: true })).cookie;
  coB = (await call('POST', '/api/companies', { name: 'Birch Dental', province: 'ON' }, firmB)).json.company.id;
  coB2 = (await call('POST', '/api/companies', { name: 'Cedar Cafe', province: 'ON' }, firmB)).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('only the administrator sees year-end usage', async () => {
  assert.equal((await call('GET', '/api/overview/yearends', undefined, firmB)).status, 403);
});

test('files are counted once per company and year-end, when started', async () => {
  const before0 = await usage();
  assert.deepEqual(before0.firms.map(f => [f.firmName, f.count, f.exempt]), [['Sher Books', 1, true]], 'the file started before counting, from the administrator’s own firm, not charged');
  assert.equal(before0.billable, 0);

  assert.equal((await call('PUT', `/api/c/${coB}/records/engagements/f1`, await file(coB, firmB, '2025-12-31'), firmB)).status, 200);
  // Changes, deleting and starting again, or a second file for the same year-end: still one.
  assert.equal((await call('PUT', `/api/c/${coB}/records/engagements/f1`, { ...(await file(coB, firmB, '2025-12-31')), notes: 'x' }, firmB)).status, 200);
  assert.equal((await call('DELETE', `/api/c/${coB}/records/engagements/f1`, undefined, firmB)).status, 200);
  assert.equal((await call('PUT', `/api/c/${coB}/records/engagements/f2`, await file(coB, firmB, '2025-12-31'), firmB)).status, 200);
  // The next year-end (rolled forward) and another client each count.
  assert.equal((await call('PUT', `/api/c/${coB}/records/engagements/f3`, await file(coB, firmB, '2026-12-31'), firmB)).status, 200);
  assert.equal((await call('PUT', `/api/c/${coB2}/records/engagements/g1`, await file(coB2, firmB, '2025-12-31'), firmB)).status, 200);
  // A batch that fails saves nothing, so nothing is counted.
  const bad = await call('POST', `/api/c/${coB2}/batch`, { writes: [{ op: 'set', collection: 'engagements', id: 'g9', data: await file(coB2, firmB, '2024-06-30') }, { op: 'set', collection: 'nope', id: 'x', data: {} }] }, firmB);
  assert.notEqual(bad.status, 200);

  const u = await usage();
  const nl = u.firms.find(f => f.firmName === 'North Ledger');
  assert.equal(nl.count, 3);
  assert.equal(nl.exempt, false);
  assert.deepEqual(nl.files.map(x => [x.companyName, x.yearEnd]).sort(), [['Birch Dental', '2025-12-31'], ['Birch Dental', '2026-12-31'], ['Cedar Cafe', '2025-12-31']]);
  assert.equal(nl.files[0].by, 'Nora');
  assert.equal(u.billable, 3);
  assert.equal(u.total, 4);
  assert.ok(u.months.includes(u.month));
  assert.equal((await usage('2001-01')).firms.length, 0, 'another month');
});

test('the count is kept when the server restarts', async () => {
  await server.shutdown();
  await start();
  admin = (await call('POST', '/api/auth/login', { username: 'sher@example.com', password: PW })).cookie;
  assert.equal((await usage()).billable, 3);
});
