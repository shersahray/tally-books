'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, co, cookie = '';
const OWNER = { name: 'Sher Test', username: 'owner@example.com', password: 'correct horse battery staple' };
// fetch with the signed-in owner's session cookie
const afetch = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers || {}), cookie } });
async function signUp(b, who = OWNER) {
  const r = await fetch(b + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(who) });
  return r.headers.get('set-cookie').split(';')[0];
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-test-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = await signUp(base);
  const res = await afetch(base + '/api/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Co', province: 'ON' }) });
  co = (await res.json()).company.id;
});
after(async () => {
  await server.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Company-scoped calls: '/api/state' goes to '/api/c/<test company>/state'.
const scoped = url => (/^\/api\/(companies|health|events|backups|users|auth|security)/.test(url) || !url.startsWith('/api/') ? url : url.replace(/^\/api\//, `/api/c/${co}/`));
async function call(method, url, body) {
  const res = await fetch(base + scoped(url), {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
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
  const res = await fetch(base + scoped('/api/records/contacts/x'), { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', cookie }, body: '{"name":"x","kind":"vendor"}' });
  assert.equal(res.status, 403);
});

test('password protection', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-auth-'));
  const s = createApp({ dataDir: d, password: 's3cret', autoBackup: false });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}/api/companies`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('me:wrong').toString('base64') } })).status, 401);
  // right shared password gets past the first layer; a signed-in account is still required
  assert.equal((await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('me:s3cret').toString('base64') } })).status, 401);
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

test('companies: create with province tax, copy a chart, switch, archive', async () => {
  let r = await call('POST', '/api/companies', { name: 'Prairie Farms', province: 'AB', fyStart: 4 });
  assert.equal(r.status, 200, r.text);
  const ab = r.json.company.id;
  const abState = await (await afetch(`${base}/api/c/${ab}/state`)).json();
  assert.equal(abState.company.taxName, 'GST');
  assert.equal(abState.company.taxRate, 5);
  assert.equal(abState.company.fyStart, 4);
  assert.ok(abState.accounts.find(a => a.detail === 'tax' && a.name === 'GST payable'));
  assert.equal(abState.entries.length, 0, 'new company starts empty');

  // books are separate: a contact in one company doesn't appear in the other
  await afetch(`${base}/api/c/${ab}/records/contacts/farmer`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Farmer Joe', kind: 'customer' }) });
  const testState = await call('GET', '/api/state');
  assert.ok(!testState.json.contacts.find(c => c.id === 'farmer'));

  // copy the chart of accounts from the test company (which has a custom account from earlier tests)
  await call('PUT', '/api/records/accounts/custom1', { code: '6950', name: 'Farm supplies', type: 'Expense', detail: '' });
  r = await call('POST', '/api/companies', { name: 'Copy Co', province: 'ON', copyFrom: co });
  const cp = r.json.company.id;
  const cpState = await (await afetch(`${base}/api/c/${cp}/state`)).json();
  assert.ok(cpState.accounts.find(a => a.name === 'Farm supplies'));
  assert.equal(cpState.contacts.length, 0, 'only accounts are copied');

  // list with summaries, then archive
  let list = (await call('GET', '/api/companies')).json.companies;
  assert.ok(list.find(c => c.id === co).transactions > 0);
  r = await call('PUT', `/api/companies/${cp}`, { archived: true });
  assert.equal(r.json.company.archived, true);
  list = (await call('GET', '/api/companies')).json.companies;
  assert.equal(list.find(c => c.id === cp).archived, true);

  // renaming in settings renames it in the list
  await afetch(`${base}/api/c/${ab}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...abState.company, name: 'Prairie Farms Ltd.' }) });
  list = (await call('GET', '/api/companies')).json.companies;
  assert.equal(list.find(c => c.id === ab).name, 'Prairie Farms Ltd.');

  assert.equal((await afetch(`${base}/api/c/co_nope/state`)).status, 404);
  assert.equal((await call('POST', '/api/companies', { name: '  ' })).status, 400);
});

test('books from the single-company version become the first company', async () => {
  const { Store } = require('../src/server/db');
  const { seedDefaults } = require('../src/server/seed');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-legacy-'));
  const old = new Store(path.join(d, 'tally-books.db'));
  seedDefaults(old, { company: { name: 'Legacy Bakery' } });
  old.put('contacts', 'c1', { name: 'Old Customer', kind: 'customer' });
  old.close();
  const s = createApp({ dataDir: d, autoBackup: false });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const ck = await signUp(b);
  const list = (await (await fetch(b + '/api/companies', { headers: { cookie: ck } })).json()).companies;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Legacy Bakery');
  const st = await (await fetch(`${b}/api/c/${list[0].id}/state`, { headers: { cookie: ck } })).json();
  assert.ok(st.contacts.find(c => c.name === 'Old Customer'));
  await s.shutdown();
  // starting again doesn't adopt it twice
  const s2 = createApp({ dataDir: d, autoBackup: false });
  assert.equal(s2.registry.list().length, 1);
  s2.registry.closeAll();
  fs.rmSync(d, { recursive: true, force: true });
});

test('Quebec companies track GST and QST in separate accounts', async () => {
  const r = await call('POST', '/api/companies', { name: 'Montreal Bistro', province: 'QC', examples: true });
  assert.equal(r.status, 200, r.text);
  const st = await (await afetch(`${base}/api/c/${r.json.company.id}/state`)).json();
  assert.equal(st.company.qstRate, 9.975);
  const gst = st.accounts.find(a => a.detail === 'tax'), qst = st.accounts.find(a => a.detail === 'qst');
  assert.equal(gst.name, 'GST payable');
  assert.equal(qst.name, 'QST payable');
  // invoice 1001 for $1,200: GST 60.00 + QST 119.70 = 1,379.70
  const inv = st.docs.find(d => d.number === '1001');
  assert.equal(inv.total, 1379.7);
  const e = st.entries.find(x => x.id === 'd_' + inv.id);
  assert.equal(e.lines.find(l => l.account === gst.id).credit, 60);
  assert.equal(e.lines.find(l => l.account === qst.id).credit, 119.7);
});

test('sales tax filings are validated and cannot overlap', async () => {
  const filing = { tax: 'gst', from: '2026-07-01', to: '2026-09-30', filedOn: '2026-10-15', lines: { 109: 100 } };
  assert.equal((await call('PUT', '/api/records/filings/f1', filing)).status, 200);
  assert.equal((await call('PUT', '/api/records/filings/f2', { ...filing, from: '2026-09-01', to: '2026-11-30' })).status, 409, 'overlap');
  assert.equal((await call('PUT', '/api/records/filings/f1', { ...filing, filedOn: '2026-10-16' })).status, 200, 'editing itself is fine');
  assert.equal((await call('PUT', '/api/records/filings/f3', { ...filing, tax: 'pst' })).status, 400);
  assert.equal((await call('PUT', '/api/records/filings/f4', { ...filing, tax: 'qst', entryId: 'missing' })).status, 400);
  // a sales tax payment is a valid transaction type
  const r = await call('PUT', '/api/records/entries/tp1', entry([{ account: 'a2200', debit: 100 }, { account: 'a1000', credit: 100 }], { type: 'taxpayment', tax: 'gst', taxKind: 'payment' }));
  assert.equal(r.status, 200, r.text);
});

test('automatic backups write every company and remove old days', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-bk-'));
  let r = await call('PUT', '/api/backups', { folder: path.join(out, 'nope') });
  assert.equal(r.status, 400, 'folder must exist');
  r = await call('PUT', '/api/backups', { folder: out, keepDays: 3, enabled: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.target, path.join(out, 'Tally Books Backups'));

  // an old day that should be pruned, an old folder with foreign files that must be kept
  const root = path.join(out, 'Tally Books Backups');
  fs.mkdirSync(path.join(root, '2020-01-01'), { recursive: true });
  fs.writeFileSync(path.join(root, '2020-01-01', 'x.json'), '{}');
  fs.mkdirSync(path.join(root, '2020-01-02'), { recursive: true });
  fs.writeFileSync(path.join(root, '2020-01-02', 'notes.docx'), 'mine');

  r = await call('POST', '/api/backups/run');
  assert.equal(r.status, 200, r.text);
  const companies = (await call('GET', '/api/companies')).json.companies;
  assert.equal(r.json.count, companies.length);
  const files = fs.readdirSync(r.json.path).filter(f => f.endsWith('.json') && f !== 'companies.json');
  assert.equal(files.length, companies.length);
  assert.ok(!fs.existsSync(path.join(root, '2020-01-01')), 'old backup removed');
  assert.ok(fs.existsSync(path.join(root, '2020-01-02', 'notes.docx')), 'foreign files left alone');

  // a backup file restores through the normal restore route
  const testFile = files.find(f => f.includes(co));
  const body = JSON.parse(fs.readFileSync(path.join(r.json.path, testFile), 'utf8'));
  assert.equal(body.format, 'tally-books-backup');
  const before = (await call('GET', '/api/state')).json;
  r = await call('POST', '/api/restore', body);
  assert.equal(r.status, 200, r.text);
  const after = (await call('GET', '/api/state')).json;
  assert.equal(after.entries.length, before.entries.length);

  const st = (await call('GET', '/api/backups')).json;
  assert.equal(st.dueToday, false);
  assert.equal(st.lastError, '');
  fs.rmSync(out, { recursive: true, force: true });
});

test('sign-in: protected routes, wrong passwords, lockout, sign out', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-auth2-'));
  const s = createApp({ dataDir: d, autoBackup: false });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const j = (url, body, ck = '') => fetch(b + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', cookie: ck }, body: body && JSON.stringify(body) });

  let r = await j('/api/auth/me');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).setup, true, 'first run asks for setup');
  assert.equal((await j('/api/companies')).status, 401, 'data is locked before setup');
  assert.equal((await j('/api/auth/setup', { ...OWNER, password: 'short' })).status, 400, 'weak password refused');
  const ck = await signUp(b);
  assert.equal((await j('/api/auth/setup', { ...OWNER, username: 'second@example.com' })).status, 409, 'setup only once');
  assert.equal((await j('/api/companies', null, ck)).status, 200);

  // the password file never contains the password
  assert.ok(!fs.readFileSync(path.join(d, 'users.json'), 'utf8').includes(OWNER.password));

  // wrong passwords lock the account after 5 tries
  for (let i = 0; i < 4; i++) assert.equal((await j('/api/auth/login', { username: OWNER.username, password: 'nope-nope-nope' })).status, 401);
  assert.equal((await j('/api/auth/login', { username: OWNER.username, password: 'nope-nope-nope' })).status, 429);
  assert.equal((await j('/api/auth/login', OWNER)).status, 429, 'even the right password waits out the lock');
  s.auth.failures.clear();
  r = await j('/api/auth/login', OWNER);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const ck2 = r.headers.get('set-cookie').split(';')[0];

  // sign out ends the session
  await j('/api/auth/logout', {}, ck2);
  assert.equal((await j('/api/companies', null, ck2)).status, 401);

  // idle timeout
  s.auth.data.settings.idleMinutes = 5;
  for (const sess of s.auth.sessions.values()) sess.lastSeen -= 6 * 60 * 1000;
  assert.equal((await j('/api/companies', null, ck)).status, 401, 'session expires after inactivity');

  await s.shutdown();
  fs.rmSync(d, { recursive: true, force: true });
});

test('staff users see only their companies and must change a temporary password', async () => {
  const list = (await call('GET', '/api/companies')).json.companies;
  const allowed = list[0].id, other = list.find(c => c.id !== allowed).id;
  let r = await call('POST', '/api/users', { name: 'Staff Person', username: 'staff1', password: 'temporary pass 123', role: 'staff', companies: [allowed] });
  assert.equal(r.status, 200, r.text);
  const staffId = r.json.user.id;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'staff1', password: 'temporary pass 123' }) });
  const sc = login.headers.get('set-cookie').split(';')[0];
  const sf = (url, init = {}) => fetch(base + url, { ...init, headers: { 'Content-Type': 'application/json', cookie: sc } });

  r = await sf('/api/companies');
  assert.equal(r.status, 403, 'temporary password must be changed first');
  assert.equal((await r.json()).mustChange, true);
  r = await sf('/api/auth/password', { method: 'POST', body: JSON.stringify({ current: 'temporary pass 123', password: 'my own better phrase' }) });
  assert.equal(r.status, 200);

  const seen = (await (await sf('/api/companies')).json()).companies.map(c => c.id);
  assert.deepEqual(seen, [allowed]);
  assert.equal((await sf(`/api/c/${other}/state`)).status, 403);
  assert.equal((await sf(`/api/c/${allowed}/state`)).status, 200);
  assert.equal((await sf('/api/users')).status, 403, 'staff cannot manage users');
  assert.equal((await sf('/api/companies', { method: 'POST', body: JSON.stringify({ name: 'X' }) })).status, 403);

  // turning the account off signs them out
  await call('PUT', `/api/users/${staffId}`, { disabled: true });
  assert.equal((await sf('/api/companies')).status, 401);
  // the last owner can't be removed
  const me = (await call('GET', '/api/users')).json.users.find(u => u.role === 'owner');
  assert.equal((await call('PUT', `/api/users/${me.id}`, { role: 'staff' })).status, 409);
});

test('export sales carry a tax code and no sales tax', async () => {
  const r = await call('POST', '/api/companies', { name: 'Export Co', province: 'ON', examples: true });
  const st = await (await afetch(`${base}/api/c/${r.json.company.id}/state`)).json();
  const us = st.contacts.find(c => c.taxCode === 'export');
  assert.ok(us, 'example US customer defaults to zero-rated export');
  const inv = st.docs.find(d => d.contactId === us.id);
  assert.equal(inv.tax, 0);
  assert.equal(inv.total, 900);
  const e = st.entries.find(x => x.id === 'd_' + inv.id);
  assert.ok(e.lines.some(l => l.account === 'a4100' && l.credit === 900 && l.taxCode === 'export'));
  assert.ok(!e.lines.some(l => l.account === 'a2200'), 'no HST line');
});

test('payroll: employees and pay runs are validated and post balanced entries', async () => {
  const P = require('../public/payroll-calc.js');
  const emp = { name: 'Pat Payroll', prov: 'ON', freq: 'biweekly', payType: 'salary', rate: 52000, td1Fed: '', rrsp: 50 };
  assert.equal((await call('PUT', '/api/records/employees/e1', { ...emp, prov: 'XX' })).status, 400);
  assert.equal((await call('PUT', '/api/records/employees/e1', emp)).status, 200);
  const r = P.calc({ date: '2026-09-18', prov: 'ON', P: 26, gross: 2000, rrsp: 50 });
  const line = { employeeId: 'e1', name: emp.name, gross: 2000, rrsp: 50, union: 0, ded: r.employee, er: r.employer };
  const deds = Object.values(r.employee).reduce((s, v) => s + v, 0) + 50;
  line.net = Math.round((2000 - deds) * 100) / 100;
  const split = P.remitSplit(r.employee, r.employer);
  const er = Object.values(r.employer).reduce((s, v) => s + v, 0);
  const acct = (id, code, name, type, detail) => call('PUT', `/api/records/accounts/${id}`, { code, name, type, detail });
  assert.equal((await acct('a2300', '2300', 'Payroll liabilities – CRA', 'Liability', 'payroll_cra')).status, 200);
  assert.equal((await acct('a2320', '2320', 'Other payroll deductions', 'Liability', 'payroll_other')).status, 200);
  assert.equal((await acct('a7110', '7110', 'Employer payroll taxes', 'Expense', 'payroll_tax')).status, 200);
  const r2 = n => Math.round(n * 100) / 100;
  const lines = [{ account: 'a7100', debit: 2000, credit: 0 }, { account: 'a7110', debit: r2(er), credit: 0 },
    { account: 'a2300', debit: 0, credit: split.cra }, { account: 'a2320', debit: 0, credit: 50 }, { account: 'a1000', debit: 0, credit: line.net }];
  const run = { payDate: '2026-09-18', freq: 'biweekly', bank: 'a1000', entryId: 'pr_1', lines: [line] };
  // Net pay that doesn't add up is refused, and so is the whole batch.
  const bad = await call('POST', '/api/batch', { writes: [
    { op: 'set', collection: 'entries', id: 'pr_1', data: { type: 'payrun', date: '2026-09-18', lines } },
    { op: 'set', collection: 'payruns', id: 'run1', data: { ...run, lines: [{ ...line, net: line.net + 1 }] } }] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /net pay/);
  // Earnings broken down have to add up to gross; vacation pay is only set aside for "accrue" employees.
  const entry = { op: 'set', collection: 'entries', id: 'pr_1', data: { type: 'payrun', date: '2026-09-18', lines } };
  const parts = await call('POST', '/api/batch', { writes: [entry,
    { op: 'set', collection: 'payruns', id: 'run1', data: { ...run, lines: [{ ...line, regular: 1800, holiday: 100, vacPay: 50 }] } }] });
  assert.equal(parts.status, 400); assert.match(parts.json.error, /add up to gross/);
  const acc = await call('POST', '/api/batch', { writes: [entry,
    { op: 'set', collection: 'payruns', id: 'run1', data: { ...run, lines: [{ ...line, regular: 1900, holiday: 100, vacMode: 'each', vacAccrued: 80 }] } }] });
  assert.equal(acc.status, 400); assert.match(acc.json.error, /set aside/);
  assert.equal((await call('PUT', '/api/records/employees/e1', { ...emp, vacRate: 150 })).status, 400);
  assert.equal((await call('PUT', '/api/records/employees/e1', { ...emp, vacMode: 'sometimes' })).status, 400);
  assert.equal((await call('PUT', '/api/records/employees/e1', { ...emp, roes: 'x' })).status, 400);
  const parts2 = await call('POST', '/api/batch', { writes: [entry,
    { op: 'set', collection: 'payruns', id: 'run1', data: { ...run, lines: [{ ...line, regular: 1500, other: 100 }] } }] });
  assert.equal(parts2.status, 400, 'regular + other must add up too');
  const roe = await call('PUT', '/api/records/employees/e1', { ...emp, roes: [{ reason: 'E', calc: { type: '<img src=x onerror=alert(1)>', hours: '<b>', periods: [{ n: '<i>', amount: 5 }] } }] });
  assert.equal(roe.status, 200);
  const roeCalc = (await call('GET', '/api/state')).json.employees.find(x => x.id === 'e1').roes[0].calc;
  assert.equal(roeCalc.type, 'B'); assert.equal(roeCalc.hours, 0); assert.equal(roeCalc.periods[0].n, 0);
  const ok = await call('POST', '/api/batch', { writes: [
    { op: 'set', collection: 'entries', id: 'pr_1', data: { type: 'payrun', date: '2026-09-18', lines } },
    { op: 'set', collection: 'payruns', id: 'run1', data: { ...run, lines: [{ ...line, regular: 1900, holiday: 100, holidays: [{ date: '2026-09-07', name: 'Labour Day' }, { date: 'bad' }], vacMode: 'accrue', vacAccrued: 80, vacPay: 0 }] } }] });
  assert.equal(ok.status, 200, ok.text);
  const saved = (await call('GET', '/api/state')).json.payruns.find(x => x.id === 'run1').lines[0];
  assert.deepEqual(saved.holidays, [{ date: '2026-09-07', name: 'Labour Day' }]);
  assert.equal(saved.vacAccrued, 80);
  // The employee and the entry are protected while the pay run exists.
  assert.equal((await call('DELETE', '/api/records/employees/e1')).status, 409);
  assert.equal((await call('DELETE', '/api/records/entries/pr_1')).status, 409);
  const del = await call('POST', '/api/batch', { writes: [{ op: 'delete', collection: 'payruns', id: 'run1' }, { op: 'delete', collection: 'entries', id: 'pr_1' }] });
  assert.equal(del.status, 200);
  assert.equal((await call('DELETE', '/api/records/employees/e1')).status, 200);
  // Payroll settings round-trip through company settings.
  const s = (await call('GET', '/api/state')).json.company;
  assert.equal((await call('PUT', '/api/settings', { ...s, payroll: { remitFreq: 'quarterly', hsfRate: 1.25 } })).status, 200);
  assert.deepEqual((await call('GET', '/api/state')).json.company.payroll, { remitFreq: 'quarterly', hsfRate: 1.25, craAccount: '', rqId: '', hsfPrimary: false, assocPayroll: 0 });
  // Quick Method settings: a start date is needed; rates are kept within 0–20%.
  assert.equal((await call('PUT', '/api/settings', { ...s, quickMethod: { on: true } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { ...s, quickMethod: { on: true, from: '2026-01-01', type: 'goods', gstRate: 99, qstRate: '', credit: false, extra: 'x' } })).status, 200);
  assert.deepEqual((await call('GET', '/api/state')).json.company.quickMethod, { on: true, from: '2026-01-01', type: 'goods', gstRate: 20, qstRate: '', credit: false });
  // Capital asset accounts, and the adjustment the Quick Method posts when a return is filed.
  assert.equal((await call('PUT', '/api/records/accounts/a1500', { code: '1500', name: 'Equipment', type: 'Asset', detail: 'capital' })).status, 200);
  assert.equal((await call('PUT', '/api/settings', { ...s, quickMethod: { on: true, from: '2026-02-01' } })).status, 400, 'mid-quarter start');
  assert.equal((await call('PUT', '/api/records/entries/qm1', { type: 'qmadjust', tax: 'gst', date: '2026-09-30', lines: [{ account: 'a1500', debit: 10, credit: 0 }, { account: 'a1000', debit: 0, credit: 10 }] })).status, 200);
  const filing = { tax: 'gst', from: '2026-07-01', to: '2026-09-30', filedOn: '2026-10-01', lines: { 109: 0 }, method: 'quick' };
  assert.equal((await call('PUT', '/api/records/filings/f1', { ...filing, qmEntryId: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/api/records/filings/f1', { ...filing, qmEntryId: 'qm1', method: 'weird' })).status, 400);
  assert.equal((await call('PUT', '/api/records/filings/f1', { ...filing, qmEntryId: 'qm1' })).status, 200);
});

// A fresh server for one test; returns helpers bound to it.
async function freshServer(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-x-'));
  const s = createApp({ dataDir: d, autoBackup: false, ...extra });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const j = async (method, url, body, ck = '') => {
    const r = await fetch(b + url, { method, headers: { 'Content-Type': 'application/json', cookie: ck }, body: body && JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  return { s, b, d, j, done: async () => { await s.shutdown(); fs.rmSync(d, { recursive: true, force: true }); } };
}

test('two-step sign-in: set up, sign in with a code, recovery codes, replay and required policy', async () => {
  const { s, j, done } = await freshServer({ require2fa: 'owners' });
  const { totp } = require('../src/server/auth');
  const owner = await j('POST', '/api/auth/setup', OWNER);
  const ck = owner.cookie;
  assert.equal(owner.json.user.mustEnroll, true, 'owners must set it up on this server');
  let r = await j('GET', '/api/companies', null, ck);
  assert.equal(r.status, 403);
  assert.equal(r.json.mustEnroll, true);

  const start = (await j('POST', '/api/auth/2fa/start', {}, ck)).json;
  assert.match(start.uri, /^otpauth:\/\/totp\/Tally%20Books:owner%40example\.com\?secret=[A-Z2-7]{32}&issuer=Tally%20Books/);
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await j('POST', '/api/auth/2fa/confirm', { code: '000000' === totp(start.secret, step) ? '111111' : '000000' }, ck)).status, 400);
  r = await j('POST', '/api/auth/2fa/confirm', { code: totp(start.secret, step) }, ck);
  assert.equal(r.status, 200);
  const recovery = r.json.recovery;
  assert.equal(recovery.length, 10);
  assert.equal((await j('GET', '/api/companies', null, ck)).status, 200, 'unlocked once set up');
  assert.ok(!fs.readFileSync(path.join(s.auth.file), 'utf8').includes(recovery[0]), 'recovery codes are stored hashed');

  // Password alone is not enough now.
  r = await j('POST', '/api/auth/login', OWNER);
  assert.equal(r.status, 200);
  assert.equal(r.json.needCode, true);
  assert.equal(r.cookie, '', 'no session before the code');
  const ticket = r.json.ticket;
  assert.equal((await j('POST', '/api/auth/login/code', { ticket, code: totp(start.secret, step) })).status, 401, 'a code already used is refused');
  r = await j('POST', '/api/auth/login/code', { ticket, code: totp(start.secret, step + 1) });
  assert.equal(r.status, 200);
  assert.ok(r.cookie.startsWith('tb_session='));

  // A recovery code works once.
  let t2 = (await j('POST', '/api/auth/login', OWNER)).json.ticket;
  assert.equal((await j('POST', '/api/auth/login/code', { ticket: t2, code: recovery[0] })).status, 200);
  t2 = (await j('POST', '/api/auth/login', OWNER)).json.ticket;
  assert.equal((await j('POST', '/api/auth/login/code', { ticket: t2, code: recovery[0] })).status, 401);

  // Three wrong codes end the ticket.
  const t3 = (await j('POST', '/api/auth/login', OWNER)).json.ticket;
  for (let i = 0; i < 2; i++) await j('POST', '/api/auth/login/code', { ticket: t3, code: '123456' });
  r = await j('POST', '/api/auth/login/code', { ticket: t3, code: '123456' });
  assert.equal(r.json.restart, true);
  assert.equal((await j('POST', '/api/auth/login/code', { ticket: t3, code: totp(start.secret, step + 2) })).status, 401);

  // Required for owners: can't be turned off.
  assert.equal((await j('POST', '/api/auth/2fa/disable', { password: OWNER.password }, ck)).status, 409);
  const log = (await j('GET', '/api/security/log', null, ck)).json.log;
  assert.ok(log.some(e => e.event === 'code-failed') && log.some(e => e.event === '2fa-on') && log.some(e => e.event === 'recovery-code-used'));
  await done();
});

test('invitation links, client role and view-only access', async () => {
  const { s, j, done } = await freshServer();
  const ck = (await j('POST', '/api/auth/setup', OWNER)).cookie;
  const co1 = (await j('POST', '/api/companies', { name: 'Client One', province: 'ON' }, ck)).json.company.id;
  const co2 = (await j('POST', '/api/companies', { name: 'Client Two', province: 'ON' }, ck)).json.company.id;
  assert.equal((await j('POST', '/api/users', { name: 'Cli', username: 'cli@example.com', role: 'client', invite: true }, ck)).status, 400, 'a client needs a company');
  let r = await j('POST', '/api/users', { name: 'Cli', username: 'cli@example.com', role: 'client', companies: [co1], readOnly: true, invite: true }, ck);
  assert.equal(r.status, 200);
  const link = r.json.user.link;
  assert.ok(link && link.length > 20);
  assert.ok(!fs.readFileSync(s.auth.file, 'utf8').includes(link), 'links are stored hashed');
  assert.equal((await j('POST', '/api/auth/login', { username: 'cli@example.com', password: 'anything at all here' })).status, 401, 'no password until the invite is accepted');
  assert.deepEqual((await j('POST', '/api/auth/link', { token: link })).json, { name: 'Cli', username: 'cli@example.com', kind: 'invite' });
  r = await j('POST', '/api/auth/link/accept', { token: link, password: 'client chosen phrase' });
  assert.equal(r.status, 200);
  const cc = r.cookie;
  assert.equal((await j('POST', '/api/auth/link', { token: link })).status, 410, 'a link works once');

  const seen = (await j('GET', '/api/companies', null, cc)).json.companies.map(c => c.id);
  assert.deepEqual(seen, [co1]);
  assert.equal((await j('GET', `/api/c/${co2}/state`, null, cc)).status, 403);
  assert.equal((await j('GET', `/api/c/${co1}/state`, null, cc)).status, 200);
  r = await j('PUT', `/api/c/${co1}/records/contacts/c1`, { name: 'X', kind: 'customer' }, cc);
  assert.equal(r.status, 403);
  assert.match(r.json.error, /view only/);
  assert.equal((await j('GET', `/api/c/${co1}/audit`, null, cc)).status, 403, 'clients don’t see the audit log');
  assert.equal((await j('GET', '/api/backups', null, cc)).json.hidden, true);
  assert.equal((await j('POST', '/api/backups/run', {}, cc)).status, 403);

  // Turn off view only: the client can now make changes, and they're in the audit log under their name.
  const cid = (await j('GET', '/api/users', null, ck)).json.users.find(u => u.role === 'client').id;
  await j('PUT', `/api/users/${cid}`, { readOnly: false }, ck);
  assert.equal((await j('PUT', `/api/c/${co1}/records/contacts/c1`, { name: 'Added by client', kind: 'customer' }, cc)).status, 200);
  await j('PUT', `/api/c/${co1}/records/contacts/c1`, { name: 'Renamed by owner', kind: 'customer' }, ck);
  await j('DELETE', `/api/c/${co1}/records/contacts/c1`, null, ck);
  const audit = (await j('GET', `/api/c/${co1}/audit`, null, ck)).json.rows;
  assert.deepEqual(audit.slice(0, 3).map(a => [a.action, a.username]), [['delete', OWNER.username], ['change', OWNER.username], ['add', 'cli@example.com']]);
  const full = (await j('GET', `/api/c/${co1}/audit/${audit[1].seq}`, null, ck)).json;
  assert.equal(full.before.name, 'Added by client');
  assert.equal(full.after.name, 'Renamed by owner');

  // Password reset link for an existing user.
  r = await j('POST', `/api/users/${cid}/link`, {}, ck);
  assert.equal(r.json.kind, 'reset');
  assert.equal((await j('POST', '/api/auth/link/accept', { token: r.json.token, password: 'short' })).status, 400);
  assert.equal((await j('POST', '/api/auth/link/accept', { token: r.json.token, password: 'a brand new phrase' })).status, 200);
  assert.equal((await j('GET', '/api/companies', null, cc)).status, 401, 'resetting the password ends old sessions');
  await done();
});

test('too many failed sign-ins from one address are slowed down', async () => {
  const { s, j, done } = await freshServer();
  await j('POST', '/api/auth/setup', OWNER);
  for (let i = 0; i < 20; i++) await j('POST', '/api/auth/login', { username: `nobody${i}@example.com`, password: 'wrong wrong wrong' });
  const r = await j('POST', '/api/auth/login', OWNER);
  assert.equal(r.status, 429);
  assert.match(r.json.error, /your network/);
  await done();
});

test('security headers and off-site backups to Azure Blob Storage', async () => {
  // A stand-in for Azure Blob Storage: PUT, list and DELETE on one container.
  const blobs = new Map();
  const http = require('node:http');
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    assert.equal(u.searchParams.get('sig'), 'secret', 'the SAS token is sent');
    if (req.method === 'PUT') { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { blobs.set(decodeURIComponent(u.pathname.replace('/backups/', '')), Buffer.concat(chunks).toString()); res.writeHead(201); res.end(); }); return; }
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/xml' }); res.end(`<EnumerationResults><Blobs>${[...blobs.keys()].map(n => `<Blob><Name>${n}</Name></Blob>`).join('')}</Blobs><NextMarker/></EnumerationResults>`); return; }
    if (req.method === 'DELETE') { blobs.delete(decodeURIComponent(u.pathname.replace('/backups/', ''))); res.writeHead(202); res.end(); return; }
    res.writeHead(405); res.end();
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  blobs.set('2001-01-01/Old (x).json', '{}');
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-bk-'));
  const { j, b, done } = await freshServer({ backupBlobUrl: `http://127.0.0.1:${fake.address().port}/backups?sv=1&sp=racwdl&sig=secret`, backupFolder: bdir });
  const ck = (await j('POST', '/api/auth/setup', OWNER)).cookie;
  await j('POST', '/api/companies', { name: 'Blob Co', province: 'ON' }, ck);
  const r = await j('POST', '/api/backups/run', {}, ck);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const names = [...blobs.keys()];
  assert.ok(names.some(n => /^\d{4}-\d{2}-\d{2}\/Blob Co \(.+\)\.json$/.test(n)), names.join());
  assert.ok(names.some(n => n.endsWith('/companies.json')));
  assert.ok(!names.includes('2001-01-01/Old (x).json'), 'old days are removed off-site too');
  const st = (await j('GET', '/api/backups', null, ck)).json;
  assert.equal(st.offsite.lastError, '');
  assert.equal(st.offsite.where, `127.0.0.1:${fake.address().port}`);

  const page = await fetch(b + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('strict-transport-security'), null, 'no HSTS over plain http');
  const https = await fetch(b + '/', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(https.headers.get('strict-transport-security'), /max-age/);
  await done();
  fake.close();
  fs.rmSync(bdir, { recursive: true, force: true });
});

test('a new online server needs the setup code to create the first owner', async () => {
  const { j, done } = await freshServer({ setupCode: 'blue harbour 42' });
  const me = await j('GET', '/api/auth/me');
  assert.equal(me.json.setup, true);
  assert.equal(me.json.setupCode, true);
  assert.equal((await j('POST', '/api/auth/setup', OWNER)).status, 403);
  assert.equal((await j('POST', '/api/auth/setup', { ...OWNER, setupCode: 'wrong' })).status, 403);
  assert.equal((await j('POST', '/api/auth/setup', { ...OWNER, setupCode: 'blue harbour 42' })).status, 200);
  await done();
});

test('review fixes: replacing two-step needs the password, restore is owner-only and keeps a copy, staff see less', async () => {
  const { s, d, j, done } = await freshServer();
  const { totp } = require('../src/server/auth');
  const ck = (await j('POST', '/api/auth/setup', OWNER)).cookie;
  const co = (await j('POST', '/api/companies', { name: 'Keep Co', province: 'ON' }, ck)).json.company.id;
  // Owner turns on two-step; a second start without the password is refused.
  const st = (await j('POST', '/api/auth/2fa/start', {}, ck)).json;
  await j('POST', '/api/auth/2fa/confirm', { code: totp(st.secret, Math.floor(Date.now() / 30000)) }, ck);
  assert.equal((await j('POST', '/api/auth/2fa/start', {}, ck)).status, 400);
  assert.equal((await j('POST', '/api/auth/2fa/start', { password: OWNER.password }, ck)).status, 200);
  // Owners can't set their own password from the users screen.
  const me = (await j('GET', '/api/users', null, ck)).json.users[0];
  assert.equal((await j('PUT', `/api/users/${me.id}`, { password: 'another long phrase' }, ck)).status, 409);
  // A client who isn't view only still can't restore, change settings or load examples.
  const inv = (await j('POST', '/api/users', { name: 'C', username: 'c@example.com', role: 'client', companies: [co], invite: true }, ck)).json.user.link;
  const cc = (await j('POST', '/api/auth/link/accept', { token: inv, password: 'client long phrase' })).cookie;
  assert.equal((await j('POST', `/api/c/${co}/restore`, { format: 'tally-books-backup', company: { name: 'x' } }, cc)).status, 403);
  assert.equal((await j('PUT', `/api/c/${co}/settings`, { name: 'x' }, cc)).status, 403);
  assert.equal((await j('POST', `/api/c/${co}/examples`, {}, cc)).status, 403);
  // Staff see backup status without paths, and can't run backups.
  const sl = (await j('POST', '/api/users', { name: 'S', username: 's@example.com', role: 'staff', invite: true }, ck)).json.user.link;
  const sc = (await j('POST', '/api/auth/link/accept', { token: sl, password: 'staff long phrase' })).cookie;
  const bs = (await j('GET', '/api/backups', null, sc)).json;
  assert.equal(bs.limited, true);
  assert.equal(bs.folder, undefined);
  assert.equal((await j('POST', '/api/backups/run', {}, sc)).status, 403);
  // The owner's restore keeps a copy of what was replaced.
  const backup = (await (await fetch(`${s.address ? `http://127.0.0.1:${s.address().port}` : ''}/api/c/${co}/backup`, { headers: { cookie: ck } })).json());
  // (the owner's session ended when they replaced two-step? No: only other sessions end)
  assert.equal((await j('POST', `/api/c/${co}/restore`, backup, ck)).status, 200);
  assert.equal(fs.readdirSync(path.join(d, 'before-restore')).length, 1);
  // Long usernames are refused before any work is done.
  assert.equal((await j('POST', '/api/auth/login', { username: 'x'.repeat(5000), password: 'y' })).status, 401);
  await done();
});

test('a flood of simultaneous sign-ins from one address is turned away', async () => {
  const { j, done } = await freshServer();
  await j('POST', '/api/auth/setup', OWNER);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => j('POST', '/api/auth/login', { username: `n${i}@example.com`, password: 'wrong wrong wrong' })));
  assert.ok(results.filter(r => r.status === 429).length >= 9, results.map(r => r.status).join());
  await done();
});

test('language: each user keeps their own, and French books get French account names', async () => {
  const { j, done } = await freshServer();
  const ck = (await j('POST', '/api/auth/setup', OWNER)).cookie;
  assert.equal((await j('PUT', '/api/auth/prefs', { lang: 'fr' }, ck)).json.user.lang, 'fr');
  assert.equal((await j('GET', '/api/auth/me', null, ck)).json.user.lang, 'fr');
  const co = (await j('POST', '/api/companies', { name: 'Bistro', province: 'QC', lang: 'fr', examples: true }, ck)).json.company.id;
  const st = (await j('GET', `/api/c/${co}/state`, null, ck)).json;
  assert.equal(st.company.lang, 'fr');
  const name = id => st.accounts.find(a => a.id === id).name;
  assert.equal(name('a1000'), 'Compte chèques');
  assert.equal(name('a2200'), 'TPS à payer');
  assert.equal(name('a2210'), 'TVQ à payer');
  assert.ok(st.contacts.some(c => c.name === 'Clinique dentaire Maple'));
  assert.ok(st.entries.some(e => e.memo === 'Frais mensuels du compte'));
  const en = (await j('POST', '/api/companies', { name: 'Maple', province: 'ON' }, ck)).json.company.id;
  assert.equal((await j('GET', `/api/c/${en}/state`, null, ck)).json.accounts.find(a => a.id === 'a1000').name, 'Chequing');
  await done();
});
