'use strict';
// Invoice look and own fields, late fee settings, classes, budgets, mileage and purchase orders.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, co, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-phase2-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Plan Co', province: 'ON' })).json.company.id;
  await call('PUT', '/api/c/records/contacts/v1', { name: 'Supplier Inc', kind: 'vendor' });
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const company = async () => (await call('GET', '/api/c/state')).json.company;

test('settings: document look, own fields, late fees and classes', async () => {
  const cur = await company();
  let r = await call('PUT', '/api/c/settings', { ...cur, docStyle: { color: '#1f4e8c', layout: 'bold' }, customFields: [{ label: 'PO number', purchase: true }, { label: '' }, { label: 'Project' }, { label: 'Fourth' }],
    lateFee: { on: true, kind: 'percent', amount: 2, graceDays: 5, account: 'a4000' }, classes: [{ id: 'k1', name: 'Ottawa' }, { id: 'k2', name: 'ottawa' }, { id: 'k3', name: 'Toronto' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = await company();
  assert.deepEqual(c.docStyle, { color: '#1f4e8c', layout: 'bold' });
  assert.deepEqual(c.customFields.map(f => [f.id, f.label, f.purchase]), [['f1', 'PO number', true], ['f3', 'Project', false]]);
  assert.deepEqual(c.lateFee, { on: true, kind: 'percent', amount: 2, graceDays: 5, account: 'a4000' });
  assert.deepEqual(c.classes.map(x => x.name), ['Ottawa', 'Toronto'], 'same name twice is kept once');
  r = await call('PUT', '/api/c/settings', { ...c, docStyle: { color: 'red; x', layout: 'weird' } });
  assert.deepEqual((await company()).docStyle, { color: '#0a7369', layout: 'classic' });
  assert.equal((await call('PUT', '/api/c/settings', { ...c, lateFee: { on: true, kind: 'percent', amount: 45, account: 'a4000' } })).status, 400);
  assert.equal((await call('PUT', '/api/c/settings', { ...c, lateFee: { on: true, kind: 'flat', amount: 0, account: 'a4000' } })).status, 400);
  // A class rides on transactions.
  r = await call('PUT', '/api/c/records/entries/j1', { type: 'journal', date: '2026-03-01', cls: 'k1', lines: [{ account: 'a6000', debit: 50, credit: 0 }, { account: 'a1000', debit: 0, credit: 50 }] });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/c/state')).json.entries.find(e => e.id === 'j1').cls, 'k1');
});

test('budgets: 12 months per income or expense account', async () => {
  const b = { name: '2026 plan', start: '2026-01-01', amounts: { a4000: Array(12).fill(1000), a6000: [100, '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], a5000: Array(12).fill(0) } };
  assert.equal((await call('PUT', '/api/c/records/budgets/b1', { ...b, start: '2026-01-15' })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/budgets/b1', { ...b, amounts: { a1000: Array(12).fill(1) } })).status, 400, 'not a bank account');
  assert.equal((await call('PUT', '/api/c/records/budgets/b1', { ...b, amounts: { a4000: [1, 2] } })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/budgets/b1', b)).status, 200);
  const saved = (await call('GET', '/api/c/state')).json.budgets[0];
  assert.deepEqual(Object.keys(saved.amounts).sort(), ['a4000', 'a6000'], 'empty rows aren’t kept');
  const cur = await company();
  assert.equal((await call('PUT', '/api/c/settings', { ...cur, savedReports: [{ id: 'r1', name: 'Budget', tab: 'bva', period: 'fy', budget: 'b1', cls: 'k1' }] })).status, 200);
  assert.deepEqual((await company()).savedReports.map(x => [x.tab, x.budget, x.cls]), [['bva', 'b1', 'k1']]);
});

test('mileage: trips are checked, and a claimed expense is undone from the mileage log', async () => {
  assert.equal((await call('PUT', '/api/c/records/trips/t1', { date: '2026-03-02', km: 0, purpose: 'x' })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/trips/t1', { date: '2026-03-02', km: 42.25, purpose: '' })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/trips/t1', { date: '2026-03-02', km: 42.25, purpose: 'Client meeting', from: 'Office', to: 'Client', contactId: 'v1' })).status, 200);
  assert.equal((await call('GET', '/api/c/state')).json.trips[0].km, 42.3);
  const r = await call('POST', '/api/c/batch', { writes: [
    { op: 'set', collection: 'entries', id: 'm1', data: { type: 'journal', date: '2026-03-31', mileage: true, lines: [{ account: 'a6000', debit: 30.88, credit: 0 }, { account: 'a1000', debit: 0, credit: 30.88 }] } },
    { op: 'set', collection: 'trips', id: 't1', data: { date: '2026-03-02', km: 42.3, purpose: 'Client meeting', entryId: 'm1' } }] });
  assert.equal(r.status, 200);
  assert.equal((await call('DELETE', '/api/c/records/entries/m1')).status, 409, 'undo the claim from the mileage log');
  const undo = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'trips', id: 't1', data: { date: '2026-03-02', km: 42.3, purpose: 'Client meeting', entryId: '' } }, { op: 'delete', collection: 'entries', id: 'm1' }] });
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
});

test('purchase orders: vendor, lines, open or closed, linked to the bill', async () => {
  const po = { number: 'PO-1001', date: '2026-04-01', expected: '2026-04-15', contactId: 'v1', lines: [{ desc: 'Paper', account: 'a6000', qty: 10, rate: 5, taxCode: 'std' }], sub: 50, tax: 6.5, total: 56.5, status: 'open' };
  assert.equal((await call('PUT', '/api/c/records/pos/p1', { ...po, contactId: 'nobody' })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/pos/p1', { ...po, lines: [] })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/pos/p1', { ...po, status: 'weird' })).status, 200);
  let x = (await call('GET', '/api/c/state')).json.pos[0];
  assert.equal(x.status, 'open');
  assert.equal((await call('PUT', '/api/c/records/pos/p1', { ...po, status: 'closed', billId: 'bill9' })).status, 200);
  x = (await call('GET', '/api/c/state')).json.pos[0];
  assert.deepEqual([x.status, x.billId], ['closed', 'bill9']);
});
