'use strict';
// Projects and time, fixed assets, inventory, and multi-currency: what the server checks.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, co, cookie, fxCalls = 0;
async function fakeFx(url) {
  fxCalls++;
  const m = url.match(/FX([A-Z]{3})CAD.*end_date=(\d{4}-\d{2}-\d{2})/);
  if (m[1] === 'XXX') return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ observations: [{ d: '2026-09-11', ['FX' + m[1] + 'CAD']: { v: '1.3650' } }, { d: m[2], ['FX' + m[1] + 'CAD']: { v: '1.3712' } }] }) };
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-phase3-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, fxFetch: fakeFx });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Shop Co', province: 'ON' })).json.company.id;
  await call('PUT', '/api/c/records/contacts/c1', { name: 'Ana', kind: 'customer' });
  await call('PUT', '/api/c/records/accounts/a1350', { code: '1350', name: 'Inventory', type: 'Asset', detail: '', active: true });
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('projects and time: checked, and kept while in use', async () => {
  assert.equal((await call('PUT', '/api/c/records/projects/p1', { name: '' })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/projects/p1', { name: 'Clinic fit-out', contactId: 'c1', budget: '5000' })).status, 200);
  assert.equal((await call('PUT', '/api/c/records/times/t1', { date: '2026-10-01', who: 'Sher', hours: 30, projectId: 'p1' })).status, 400, 'more than 24 hours');
  assert.equal((await call('PUT', '/api/c/records/times/t1', { date: '2026-10-01', who: '', hours: 2 })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/times/t1', { date: '2026-10-01', who: 'Sher', hours: 2.5, rate: 95, cost: 40, billable: true, contactId: 'c1', projectId: 'p1' })).status, 200);
  const t = (await call('GET', '/api/c/state')).json.times[0];
  assert.deepEqual([t.hours, t.rate, t.cost, t.billable], [2.5, 95, 40, true]);
  assert.equal((await call('DELETE', '/api/c/records/projects/p1')).status, 409, 'has time on it');
  // Billed: the time can't be deleted while its invoice exists.
  await call('POST', '/api/c/batch', { writes: [
    { op: 'set', collection: 'docs', id: 'i1', data: { kind: 'invoice', number: '1001', date: '2026-10-02', due: '2026-11-01', contactId: 'c1', proj: 'p1', lines: [{ desc: 'Time', account: 'a4000', qty: 2.5, rate: 95, taxCode: 'none' }], sub: 237.5, tax: 0, total: 237.5 } },
    { op: 'set', collection: 'entries', id: 'd_i1', data: { type: 'invoice', date: '2026-10-02', docId: 'i1', proj: 'p1', lines: [{ account: 'a1200', debit: 237.5, credit: 0 }, { account: 'a4000', debit: 0, credit: 237.5, taxCode: 'none' }] } },
    { op: 'set', collection: 'times', id: 't1', data: { ...t, invoiceId: 'i1' } }] });
  assert.equal((await call('DELETE', '/api/c/records/times/t1')).status, 409);
});

test('fixed assets: checked, and amortization in the books is undone from the register', async () => {
  const a = { name: 'Laptop', acquired: '2026-03-15', cost: 2400, ccaClass: '50', ccaRate: 55, method: 'straight', life: 3, assetAccount: 'a1500', accumAccount: 'a1350', expenseAccount: 'a6000' };
  assert.equal((await call('PUT', '/api/c/records/assets/x1', { ...a, life: 0 })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/assets/x1', { ...a, expenseAccount: 'a4000' })).status, 400, 'an income account');
  assert.equal((await call('PUT', '/api/c/records/assets/x1', { ...a, disposed: '2026-01-01' })).status, 400, 'sold before it was bought');
  assert.equal((await call('PUT', '/api/c/records/assets/x1', a)).status, 200);
  const r = await call('POST', '/api/c/batch', { writes: [
    { op: 'set', collection: 'entries', id: 'am1', data: { type: 'journal', date: '2026-12-31', lines: [{ account: 'a6000', debit: 666.67, credit: 0 }, { account: 'a1350', debit: 0, credit: 666.67 }] } },
    { op: 'set', collection: 'assets', id: 'x1', data: { ...a, posted: { 2026: 'am1' } } }] });
  assert.equal(r.status, 200);
  assert.equal((await call('DELETE', '/api/c/records/entries/am1')).status, 409);
  assert.equal((await call('DELETE', '/api/c/records/assets/x1')).status, 409);
  assert.equal((await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'assets', id: 'x1', data: { ...a, posted: {} } }, { op: 'delete', collection: 'entries', id: 'am1' }] })).status, 200);
});

test('inventory: items need their accounts, adjustments are their own type', async () => {
  const it = { name: 'Toothbrush', type: 'inventory', price: 89, cost: 40, incomeAccount: 'a4000', taxCode: 'std' };
  assert.equal((await call('PUT', '/api/c/records/items/k1', it)).status, 400, 'no asset account');
  assert.equal((await call('PUT', '/api/c/records/items/k1', { ...it, assetAccount: 'a1350', cogsAccount: 'a4000' })).status, 400, 'income isn’t cost of goods sold');
  assert.equal((await call('PUT', '/api/c/records/items/k1', { ...it, assetAccount: 'a1350', cogsAccount: 'a5000', qtyStart: 5, valueStart: 200 })).status, 400, 'starting quantity needs a date');
  assert.equal((await call('PUT', '/api/c/records/items/k1', { ...it, assetAccount: 'a1350', cogsAccount: 'a5000', qtyStart: 5, valueStart: 200, startDate: '2026-01-01' })).status, 200);
  const k = (await call('GET', '/api/c/state')).json.items.find(i => i.id === 'k1');
  assert.deepEqual([k.bought, k.sold, k.expenseAccount], [true, true, 'a1350'], 'bought into the inventory account');
  assert.equal((await call('PUT', '/api/c/records/entries/adj1', { type: 'invadjust', date: '2026-10-05', inv: { item: 'k1', qty: -2, value: -80 }, lines: [{ account: 'a5000', debit: 80, credit: 0 }, { account: 'a1350', debit: 0, credit: 80 }] })).status, 200);
  assert.equal((await call('DELETE', '/api/c/records/items/k1')).status, 409, 'has an adjustment');
});

test('multi-currency: currencies are checked and fixed once used; Bank of Canada rates', async () => {
  assert.equal((await call('PUT', '/api/c/records/contacts/u1', { name: 'Boston Co', kind: 'customer', currency: 'usd' })).status, 200);
  assert.equal((await call('GET', '/api/c/state')).json.contacts.find(c => c.id === 'u1').currency, undefined, 'not a currency code: Canadian dollars');
  assert.equal((await call('PUT', '/api/c/records/contacts/u1', { name: 'Boston Co', kind: 'customer', currency: 'USD' })).status, 200);
  const inv = { kind: 'invoice', number: 'U1', date: '2026-09-15', due: '2026-10-15', contactId: 'u1', currency: 'USD', lines: [{ desc: 'x', account: 'a4000', qty: 1, rate: 1000, taxCode: 'export' }], sub: 1000, tax: 0, total: 1000 };
  assert.equal((await call('PUT', '/api/c/records/docs/u1doc', inv)).status, 400, 'needs a rate');
  assert.equal((await call('PUT', '/api/c/records/docs/u1doc', { ...inv, fx: 1.37 })).status, 200);
  assert.equal((await call('PUT', '/api/c/records/contacts/u1', { name: 'Boston Co', kind: 'customer', currency: 'EUR' })).status, 409, 'has an invoice');
  // A bank account in US dollars; its currency is fixed once it has transactions.
  assert.equal((await call('PUT', '/api/c/records/accounts/usb', { code: '1015', name: 'US chequing', type: 'Asset', detail: 'bank', currency: 'USD', active: true })).status, 200);
  assert.equal((await call('GET', '/api/c/state')).json.accounts.find(a => a.id === 'usb').currency, 'USD');
  await call('PUT', '/api/c/records/entries/dep1', { type: 'deposit', date: '2026-10-01', currency: 'USD', fx: 1.4, lines: [{ account: 'usb', debit: 140, credit: 0, fx: { cur: 'USD', amt: 100 } }, { account: 'a4000', debit: 0, credit: 140 }] });
  assert.equal((await call('PUT', '/api/c/records/accounts/usb', { code: '1015', name: 'US chequing', type: 'Asset', detail: 'bank', active: true })).status, 409);
  assert.equal((await call('PUT', '/api/c/records/accounts/a6000', { code: '6000', name: 'Advertising', type: 'Expense', detail: '', currency: 'USD', active: true })).status, 200);
  assert.equal((await call('GET', '/api/c/state')).json.accounts.find(a => a.id === 'a6000').currency, undefined, 'only bank and card accounts');
  // Rates: the latest on or before the date, cached.
  let r = await call('GET', '/api/c/fx?cur=USD&date=2026-09-14');
  assert.deepEqual([r.json.rate, r.json.date, r.json.source], [1.3712, '2026-09-14', 'Bank of Canada']);
  const n = fxCalls;
  await call('GET', '/api/c/fx?cur=USD&date=2026-09-14');
  assert.equal(fxCalls, n, 'cached');
  assert.equal((await call('GET', '/api/c/fx?cur=XXX&date=2026-09-14')).status, 502);
  assert.equal((await call('GET', '/api/c/fx?cur=CAD&date=2026-09-14')).status, 400);
  // The client list counts what's owed in Canadian dollars.
  const list = (await call('GET', '/api/companies')).json.companies.find(c => c.id === co);
  assert.equal(list.receivable, r2(1370 + 237.5));
});
const r2 = n => Math.round(n * 100) / 100;
