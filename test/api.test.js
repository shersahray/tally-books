'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-test-'));
  server = createApp({ dbPath: path.join(dir, 'test.db') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await server.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const entry = (lines, extra = {}) => ({ type: 'journal', date: '2026-09-01', memo: 'test', lines, ...extra });

test('first run seeds the chart of accounts and company settings', async () => {
  const { status, json } = await call('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(json.accounts.length, 29);
  assert.ok(json.accounts.find(a => a.id === 'a1000' && a.detail === 'bank'));
  assert.equal(json.company.taxName, 'HST');
  assert.deepEqual(json.entries, []);
});

test('serves the web app', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Tally Books<\/title>/);
  const js = await call('GET', '/app.js');
  assert.equal(js.status, 200);
  const trav = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(trav.status, 200);
});

test('accepts a balanced journal entry', async () => {
  const r = await call('PUT', '/api/records/entries/j1', entry([
    { account: 'a1000', debit: 500, credit: 0 },
    { account: 'a3000', debit: 0, credit: 500 },
  ]));
  assert.equal(r.status, 200, r.text);
  const { json } = await call('GET', '/api/state');
  assert.equal(json.entries.find(e => e.id === 'j1').lines[0].debit, 500);
});

test('rejects unbalanced, one-sided, negative and unknown-account entries', async () => {
  const bad = [
    [{ account: 'a1000', debit: 100 }, { account: 'a3000', credit: 99.99 }],
    [{ account: 'a1000', debit: 100, credit: 100 }, { account: 'a3000', credit: 0 }],
    [{ account: 'a1000', debit: -100 }, { account: 'a3000', credit: -100 }],
    [{ account: 'nope', debit: 100 }, { account: 'a3000', credit: 100 }],
    [{ account: 'a1000', debit: 100 }],
  ];
  for (const lines of bad) {
    const r = await call('PUT', '/api/records/entries/bad', entry(lines));
    assert.equal(r.status, 400, JSON.stringify(lines));
    assert.ok(r.json.error);
  }
  const { json } = await call('GET', '/api/state');
  assert.ok(!json.entries.find(e => e.id === 'bad'));
});

test('handles cents without floating point drift', async () => {
  const r = await call('PUT', '/api/records/entries/cents', entry([
    { account: 'a6400', debit: 0.1 }, { account: 'a6400', debit: 0.2 }, { account: 'a1000', credit: 0.3 },
  ]));
  assert.equal(r.status, 200, r.text);
});

test('batch writes are all-or-nothing', async () => {
  const r = await call('POST', '/api/batch', { writes: [
    { op: 'set', collection: 'contacts', id: 'c1', data: { name: 'Acme Ltd', kind: 'customer' } },
    { op: 'set', collection: 'entries', id: 'e_bad', data: entry([{ account: 'a1000', debit: 1 }, { account: 'a3000', credit: 2 }]) },
  ] });
  assert.equal(r.status, 400);
  const { json } = await call('GET', '/api/state');
  assert.ok(!json.contacts.find(c => c.id === 'c1'), 'contact from failed batch must not be saved');
});

test('invoice, payment and delete protections', async () => {
  let r = await call('POST', '/api/batch', { writes: [
    { op: 'set', collection: 'contacts', id: 'c2', data: { name: 'Birch Co', kind: 'customer' } },
    { op: 'set', collection: 'docs', id: 'inv1', data: { kind: 'invoice', number: '1001', contactId: 'c2', date: '2026-09-01', due: '2026-10-01', lines: [], total: 113 } },
    { op: 'set', collection: 'entries', id: 'd_inv1', data: { type: 'invoice', date: '2026-09-01', contactId: 'c2', docId: 'inv1', lines: [
      { account: 'a1200', debit: 113 }, { account: 'a4100', credit: 100 }, { account: 'a2200', credit: 13 }] } },
  ] });
  assert.equal(r.status, 200, r.text);
  r = await call('PUT', '/api/records/entries/p1', { type: 'payment', date: '2026-09-15', contactId: 'c2', applyTo: 'inv1', amount: 113, bank: 'a1000',
    lines: [{ account: 'a1000', debit: 113 }, { account: 'a1200', credit: 113 }] });
  assert.equal(r.status, 200, r.text);

  assert.equal((await call('DELETE', '/api/records/docs/inv1')).status, 409, 'doc with payments');
  assert.equal((await call('DELETE', '/api/records/contacts/c2')).status, 409, 'contact in use');
  assert.equal((await call('DELETE', '/api/records/accounts/a1200')).status, 409, 'account in use');
  assert.equal((await call('DELETE', '/api/records/accounts/a7200')).status, 200, 'unused account');

  r = await call('PUT', '/api/records/accounts/a1000', { code: '1000', name: 'Chequing', type: 'Expense', detail: '' });
  assert.equal(r.status, 409, 'type change on used account');
  r = await call('PUT', '/api/records/accounts/new1', { code: '1000', name: 'Dup', type: 'Asset' });
  assert.equal(r.status, 409, 'duplicate code');
});

test('settings are validated', async () => {
  const r = await call('PUT', '/api/settings', { name: '  Birch Bookkeeping  ', fyStart: 4, taxRate: 5, taxName: 'GST', terms: 15, currency: '$' });
  assert.equal(r.status, 200);
  const { json } = await call('GET', '/api/state');
  assert.equal(json.company.name, 'Birch Bookkeeping');
  assert.equal(json.company.fyStart, 4);
});

test('backup and restore round-trip', async () => {
  const backup = await call('GET', '/api/backup');
  assert.equal(backup.status, 200);
  assert.equal(backup.json.format, 'tally-books-backup');
  const before = await call('GET', '/api/state');

  await call('PUT', '/api/records/contacts/tmp', { name: 'Temporary', kind: 'vendor' });
  const r = await call('POST', '/api/restore', backup.json);
  assert.equal(r.status, 200, r.text);
  const afterState = await call('GET', '/api/state');
  assert.ok(!afterState.json.contacts.find(c => c.id === 'tmp'));
  for (const c of ['accounts', 'contacts', 'docs', 'entries']) assert.equal(afterState.json[c].length, before.json[c].length, c);

  assert.equal((await call('POST', '/api/restore', { format: 'something-else' })).status, 400);
});

test('example data loads and keeps the books balanced', async () => {
  const r = await call('POST', '/api/examples');
  assert.equal(r.status, 200, r.text);
  const { json } = await call('GET', '/api/state');
  assert.ok(json.docs.some(d => d.example));
  let dr = 0, cr = 0;
  for (const e of json.entries) for (const l of e.lines) { dr += Math.round(l.debit * 100); cr += Math.round(l.credit * 100); }
  assert.equal(dr, cr);
});

test('blocks cross-site writes', async () => {
  const res = await fetch(base + '/api/records/contacts/x', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"name":"x","kind":"vendor"}' });
  assert.equal(res.status, 403);
});

test('password protection', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-auth-'));
  const s = createApp({ dbPath: path.join(d, 'a.db'), password: 's3cret' });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/api/state`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('me:wrong').toString('base64') } })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('me:s3cret').toString('base64') } })).status, 200);
  await s.shutdown();
  fs.rmSync(d, { recursive: true, force: true });
});

test('bank import skips lines already imported', async () => {
  const rows = [
    { date: '2026-09-02', amount: -4.75, desc: 'TIM HORTONS' },
    { date: '2026-09-02', amount: -4.75, desc: 'TIM HORTONS' }, // a second, identical coffee the same day
    { date: '2026-09-03', amount: 2500, desc: 'PAYROLL', fitid: 'F1' },
  ];
  let r = await call('POST', '/api/bank/import', { account: 'a1010', rows });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.added, r.json.skipped], [3, 0]);
  r = await call('POST', '/api/bank/import', { account: 'a1010', rows: [...rows, { date: '2026-09-04', amount: -10, desc: 'NEW' }] });
  assert.deepEqual([r.json.added, r.json.skipped], [1, 3]);
  const bad = await call('POST', '/api/bank/import', { account: 'a4100', rows });
  assert.equal(bad.status, 400, 'income account is not a bank account');
  const bad2 = await call('POST', '/api/bank/import', { account: 'a1010', rows: [{ date: 'nope', amount: 1 }] });
  assert.equal(bad2.status, 400);
});

test('matching a bank line, then deleting the transaction sends it back for review', async () => {
  const { json } = await call('GET', '/api/state');
  const line = json.bankTxns.find(b => b.account === 'a1010' && b.desc === 'NEW');
  let r = await call('POST', '/api/batch', { writes: [
    { op: 'set', collection: 'entries', id: 'bk1', data: entry([{ account: 'a6100', debit: 10 }, { account: 'a1010', credit: 10 }], { type: 'expense', date: '2026-09-04', clear: { a1010: 'c' } }) },
    { op: 'set', collection: 'bankTxns', id: line.id, data: { ...line, status: 'added', entryId: 'bk1', made: true } },
  ] });
  assert.equal(r.status, 200, r.text);
  // cleared marks must refer to an account on the transaction
  r = await call('PUT', '/api/records/entries/bk2', entry([{ account: 'a6100', debit: 1 }, { account: 'a1010', credit: 1 }], { clear: { a1000: 'c' } }));
  assert.equal(r.status, 400);
  // the bank account now has bank lines, so it can't be deleted
  assert.equal((await call('DELETE', '/api/records/accounts/a1010')).status, 409);
  assert.equal((await call('DELETE', '/api/records/entries/bk1')).status, 200);
  const after = await call('GET', '/api/state');
  const back = after.json.bankTxns.find(b => b.id === line.id);
  assert.equal(back.status, 'new');
  assert.equal(back.entryId, '');
  // excluding a line goes through the single-record route
  r = await call('PUT', `/api/records/bankTxns/${line.id}`, { ...back, status: 'excluded' });
  assert.equal(r.status, 200, r.text);
});

test('rules and reconciliations are validated', async () => {
  assert.equal((await call('PUT', '/api/records/rules/r1', { text: 'ROGERS', direction: 'out', account: 'a6800', tax: true })).status, 200);
  assert.equal((await call('PUT', '/api/records/rules/r2', { text: '', account: 'a6800' })).status, 400);
  assert.equal((await call('PUT', '/api/records/rules/r3', { text: 'X', account: 'a1000' })).status, 400, 'bank account as rule category');
  assert.equal((await call('PUT', '/api/records/recons/rc1', { account: 'a1000', statementDate: '2026-09-30', endingBalance: 100, entryIds: [] })).status, 200);
  assert.equal((await call('PUT', '/api/records/recons/rc2', { account: 'a4100', statementDate: '2026-09-30', endingBalance: 100, entryIds: [] })).status, 400);
});
