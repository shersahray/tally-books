'use strict';
// How the features built side by side fit together: custom roles on the routes and records the other features added
// (mark as sent, Import data, deposits on estimates, recurring kinds, company settings, receipts by email), tags in the
// report filters, and the cash basis with deposits on estimates.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const R = require('../public/roles.js');
const RF = require('../public/report-filters.js');
const CASH = require('../public/cashbasis.js');
const DEP = require('../public/deposits-calc.js');

let server, base, dir, owner, co, clerk, acct;
const PW = 'correct horse battery staple';
async function req(cookie, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const c = url => `/api/c/${co}${url}`;
const NONE = { sales: 'none', expenses: 'none', banking: 'none', payroll: 'none', reports: 'none', accounting: 'none', salestax: 'none', settings: 'none' };
/** A staff member with a custom role of these permissions, signed in. */
async function staffWith(name, perms) {
  const role = (await req(owner, 'POST', '/api/roles', { name, perms: { ...NONE, ...perms } })).json.role;
  const email = name.toLowerCase().replace(/\W+/g, '') + '@example.com';
  const u = await req(owner, 'POST', '/api/users', { name, username: email, password: 'temporary pass 123', role: 'staff', customRole: role.id });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  const login = await req(null, 'POST', '/api/auth/login', { username: email, password: 'temporary pass 123' });
  assert.equal((await req(login.cookie, 'POST', '/api/auth/password', { current: 'temporary pass 123', password: name + ' picks a long phrase' })).status, 200);
  return login.cookie;
}
const inv = (id, number) => [
  { op: 'set', collection: 'docs', id, data: { kind: 'invoice', number, contactId: 'cu', date: '2026-09-15', due: '2026-10-15', lines: [{ desc: 'Work', account: 'a4000', qty: 1, rate: 100, taxCode: 'none' }], sub: 100, tax: 0, total: 100 } },
  { op: 'set', collection: 'entries', id: 'd_' + id, data: { type: 'invoice', date: '2026-09-15', ref: number, docId: id, contactId: 'cu', lines: [{ account: 'a1200', debit: 100, credit: 0 }, { account: 'a4000', debit: 0, credit: 100 }] } },
];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-fit-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await req(null, 'POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Bookkeeping' })).cookie;
  co = (await req(owner, 'POST', '/api/companies', { name: 'Maple Dental', province: 'ON' })).json.company.id;
  const r = await req(owner, 'POST', c('/batch'), { writes: [
    { op: 'set', collection: 'contacts', id: 'cu', data: { kind: 'customer', name: 'Pat Customer' } },
    { op: 'set', collection: 'estimates', id: 'est1', data: { number: 'E-1', date: '2026-09-01', contactId: 'cu', lines: [{ desc: 'Job', account: 'a4000', qty: 1, rate: 1000, taxCode: 'none' }], sub: 1000, tax: 0, total: 1000, status: 'open', deposit: { kind: 'amount', value: 200 } } },
    ...inv('i1', '1001'),
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Expenses and Accounting, no Sales: a bookkeeper's assistant who doesn't touch invoicing.
  clerk = await staffWith('Ap Clerk', { expenses: 'edit', accounting: 'edit', reports: 'view' });
  // Sales and nothing else.
  acct = await staffWith('Ar Clerk', { sales: 'edit' });
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('roles: every transaction type and recurring kind has an area; settings added by features are mapped', () => {
  const types = require('../src/server/validate.js').ENTRY_TYPES;
  assert.ok(types.length > 15);
  // The entry types the server accepts (validate.js), deposits on estimates included.
  for (const t of ['custdeposit', 'depapply', 'deprefund']) assert.equal(R.recordArea('entries', { type: t }), 'sales', t);
  for (const t of types) assert.ok(R.ENTRY_AREA[t], `ENTRY_AREA has ${t}`);
  assert.equal(R.recordArea('recurring', { kind: 'invoice' }), 'sales');
  assert.equal(R.recordArea('recurring', { kind: 'bill' }), 'expenses');
  assert.equal(R.recordArea('recurring', { kind: 'expense' }), 'expenses');
  assert.equal(R.recordArea('recurring', { kind: 'deposit' }), 'banking');
  assert.equal(R.recordArea('recurring', { kind: 'transfer' }), 'banking');
  assert.equal(R.recordArea('recurring', { kind: 'journal' }), 'accounting');
  for (const k of ['tags', 'tagGroups', 'classes', 'classPerLine', 'classLabel']) assert.equal(R.settingArea(k), 'accounting', k);
  assert.equal(R.settingArea('cashForecast'), 'reports');
  assert.equal(R.settingArea('savedReports'), 'reports');
  assert.equal(R.settingArea('reportBasis'), 'settings');
  assert.equal(R.settingArea('approvals'), 'settings');
  // Setting up the Customer deposits account: Sales or Accounting.
  const dep = { code: '2345', name: 'Customer deposits', type: 'Liability', detail: 'custdep', active: true };
  assert.equal(R.canWrite({ ...NONE, sales: 'edit' }, 'accounts', dep, null), true);
  assert.equal(R.canWrite({ ...NONE, accounting: 'edit' }, 'accounts', dep, null), true);
  assert.equal(R.canWrite({ ...NONE, expenses: 'edit' }, 'accounts', dep, null), false);
  assert.equal(R.canWrite({ ...NONE, sales: 'edit' }, 'accounts', { ...dep, name: 'Renamed' }, { ...dep, detail: '' }), false, 'only marking it, nothing else');
  assert.equal(R.canWrite({ ...NONE, sales: 'edit' }, 'accounts', { ...dep, detail: '' }, null), false, 'any other account is Accounting');
  for (const k of ['customers', 'vendors', 'items', 'accounts', 'invoices', 'bills', 'journal']) assert.ok(R.AREAS[R.IMPORT_AREA[k]], k);
});

test('roles: without Sales, invoices can’t be marked as sent or imported; with Sales they can', async () => {
  let r = await req(clerk, 'POST', c('/docs/mark-sent'), { docIds: ['i1'] });
  assert.equal(r.status, 403, 'mark as sent is a change to the invoices');
  assert.match(r.json.error, /Sales/);
  r = await req(acct, 'POST', c('/docs/mark-sent'), { docIds: ['i1'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Import data adds only what the role can change.
  r = await req(clerk, 'POST', c('/import'), { writes: inv('i2', '1002'), addOnly: true, source: 'a spreadsheet' });
  assert.equal(r.status, 403, 'an invoice import needs Sales');
  r = await req(clerk, 'POST', c('/import'), { writes: [{ op: 'set', collection: 'contacts', id: 'nc', data: { kind: 'customer', name: 'New customer' } }], addOnly: true });
  assert.equal(r.status, 403, 'new customers are Sales');
  r = await req(clerk, 'POST', c('/import'), { writes: [{ op: 'set', collection: 'contacts', id: 'nv', data: { kind: 'vendor', name: 'New vendor' } }], addOnly: true });
  assert.equal(r.status, 200, 'vendors are Expenses: ' + JSON.stringify(r.json));
  r = await req(acct, 'POST', c('/import'), { writes: inv('i2', '1002'), addOnly: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req(acct, 'POST', c('/import'), { writes: [{ op: 'set', collection: 'entries', id: 'j9', data: { type: 'journal', date: '2026-09-01', lines: [{ account: 'a1000', debit: 5, credit: 0 }, { account: 'a4000', debit: 0, credit: 5 }] } }], addOnly: true });
  assert.equal(r.status, 403, 'journal entries are Accounting');
  // No copy of the books is made for an import that was refused.
  const snaps = fs.readdirSync(path.join(dir, 'before-restore')).filter(f => f.startsWith(co + '-before-import-'));
  assert.equal(snaps.length, 2);
});

test('roles: deposits on estimates are Sales, and Sales can set up the Customer deposits account', async () => {
  const depAcct = { code: '2345', name: 'Customer deposits', type: 'Liability', detail: 'custdep', active: true };
  const received = { type: 'custdeposit', date: '2026-09-05', estimateId: 'est1', amount: 200, bank: 'a1000', method: 'etransfer', lines: DEP.lines('custdeposit', 'dep', 'a1000', 200) };
  let r = await req(clerk, 'POST', c('/batch'), { writes: [{ op: 'set', collection: 'accounts', id: 'dep', data: depAcct }, { op: 'set', collection: 'entries', id: 'dp1', data: received }] });
  assert.equal(r.status, 403, 'no Sales: no deposits');
  r = await req(acct, 'POST', c('/batch'), { writes: [{ op: 'set', collection: 'accounts', id: 'dep', data: depAcct }, { op: 'set', collection: 'entries', id: 'dp1', data: received }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req(acct, 'PUT', c('/records/entries/du1'), { type: 'depapply', date: '2026-09-20', estimateId: 'est1', applyTo: 'i1', amount: 100, lines: DEP.lines('depapply', 'dep', 'a1200', 100) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req(acct, 'PUT', c('/records/accounts/dep'), { ...depAcct, name: 'Renamed' });
  assert.equal(r.status, 403, 'changing the account itself is Accounting');
});

test('roles: recurring transactions follow what they make', async () => {
  const sched = { every: 'month', n: 1, next: '2026-11-30', day: 31, end: '', mode: 'remind' };
  const jn = { ...sched, kind: 'journal', name: 'Accrual', lines: [{ account: 'a6000', debit: 10, credit: 0 }, { account: 'a2000', debit: 0, credit: 10 }] };
  assert.equal((await req(acct, 'PUT', c('/records/recurring/rj'), jn)).status, 403, 'a recurring journal entry is Accounting');
  assert.equal((await req(clerk, 'PUT', c('/records/recurring/rj'), jn)).status, 200);
  const tf = { ...sched, kind: 'transfer', name: 'Savings', from: 'a1000', to: 'a1010', amount: 50 };
  assert.equal((await req(clerk, 'PUT', c('/records/recurring/rt'), tf)).status, 403, 'a recurring transfer is Banking');
});

test('roles: settings added by features follow their area; receipts by email senders are Settings', async () => {
  const cur = async () => { const { rev, closingDate, closingPassword, hasCode, ...x } = (await req(owner, 'GET', c('/state'))).json.company; return x; };
  let s = await cur();
  // Sales only: classes, classes on each line and the reports' default method are areas it can't see, so they're
  // kept as they were (roleSettings); nothing changes.
  let r = await req(acct, 'PUT', c('/settings'), { ...s, classPerLine: true, classes: [{ id: 'k1', name: 'Ottawa' }], reportBasis: 'cash' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let now = await cur();
  assert.equal(now.classPerLine, false); assert.deepEqual(now.classes, []); assert.equal(now.reportBasis, 'accrual');
  // Accounting: classes and how they're tracked.
  r = await req(clerk, 'PUT', c('/settings'), { ...s, classPerLine: true, classLabel: 'location', classes: [{ id: 'k1', name: 'Ottawa' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  s = await cur();
  assert.equal(s.classPerLine, true); assert.equal(s.classLabel, 'location');
  // The forecast's planned items are Reports (View only here).
  assert.equal((await req(clerk, 'PUT', c('/settings'), { ...s, cashForecast: { ...s.cashForecast, days: 60 } })).status, 403);
  // Receipts by email: who may send is Settings.
  assert.equal((await req(clerk, 'PUT', c('/receipts/email'), { allowed: ['a@example.com'] })).status, 403);
  assert.equal((await req(clerk, 'POST', c('/receipts/email/new'))).status, 403);
  assert.equal((await req(acct, 'GET', c('/receipts/email'))).status, 403, 'no Expenses or Settings: not even the address');
  assert.equal((await req(clerk, 'GET', c('/receipts/email'))).status, 200, 'Expenses sees the address for the Receipts inbox');
});

test('report filters: tags', () => {
  const L = (account, debit, credit = 0) => ({ account, debit, credit });
  const E = [
    { id: 'a', date: '2026-01-05', tags: ['show'], lines: [L('bank', 100), L('sales', 0, 100)] },
    { id: 'b', date: '2026-01-06', tags: ['show', 'web'], lines: [L('rent', 40, 0), L('bank', 0, 40)] },
    { id: 'c', date: '2026-01-07', lines: [L('bank', 70), L('sales', 0, 70)] },
    // Classes on each line don't change tags: the whole transaction is tagged.
    { id: 'd', date: '2026-01-08', tags: ['web'], lines: [{ ...L('bank', 30), cls: '' }, { ...L('sales', 0, 20), cls: 'k1' }, { ...L('sales', 0, 10), cls: 'k2' }] },
  ];
  const ps = []; for (const e of E) for (const l of e.lines) ps.push({ e, account: l.account, debit: l.debit, credit: l.credit, date: e.date, cls: l.cls ?? '' });
  const ctx = { kind: () => '', projCust: () => '' };
  const ids = f => [...new Set(RF.apply(ps, f, ctx).map(p => p.e.id))];
  assert.deepEqual(ids({ tag: ['show'] }), ['a', 'b']);
  assert.deepEqual(ids({ tag: ['web'] }), ['b', 'd']);
  assert.deepEqual(ids({ tag: ['web', 'show'] }), ['a', 'b', 'd'], 'any of the tags');
  assert.deepEqual(ids({ tag: ['web'], cls: ['k1'] }), ['d'], 'stacks with a line class');
  assert.equal(RF.apply(ps, { tag: ['web'], cls: ['k1'] }, ctx).length, 1, 'only the k1 line');
  assert.deepEqual(RF.clean({ tag: ['web', 'show', 'web'] }), { tag: ['show', 'web'] });
});

test('saved reports keep a tag filter', async () => {
  const { rev, closingDate, closingPassword, hasCode, ...s } = (await req(owner, 'GET', c('/state'))).json.company;
  const tags = [{ id: 'g1', name: 'Trade show', group: '' }];
  let r = await req(owner, 'PUT', c('/settings'), { ...s, tags, savedReports: [{ id: 'sr1', name: 'Trade show P&L', tab: 'pl', period: 'fy', flt: { tag: ['g1'], bogus: ['x'] } }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const saved = (await req(owner, 'GET', c('/state'))).json.company.savedReports[0];
  assert.deepEqual(saved.flt, { tag: ['g1'] });
});

test('cash basis with deposits on estimates: a liability, settling the invoice when used, always balanced', () => {
  const docs = [{ id: 'i1', kind: 'invoice', total: 1130 }];
  const entries = [
    { id: 'd1', type: 'custdeposit', date: '2026-08-01', estimateId: 'e1', amount: 300, lines: DEP.lines('custdeposit', 'dep', 'bank', 300) },
    { id: 'x', type: 'invoice', docId: 'i1', date: '2026-09-01', lines: [{ account: 'ar', debit: 1130, credit: 0 }, { account: 'inc', debit: 0, credit: 1000 }, { account: 'hst', debit: 0, credit: 130 }] },
    { id: 'u1', type: 'depapply', date: '2026-09-10', estimateId: 'e1', applyTo: 'i1', amount: 300, lines: DEP.lines('depapply', 'dep', 'ar', 300) },
    { id: 'p1', type: 'payment', date: '2026-10-01', applyTo: 'i1', amount: 830, lines: [{ account: 'bank', debit: 830, credit: 0 }, { account: 'ar', debit: 0, credit: 830 }] },
    { id: 'd2', type: 'custdeposit', date: '2026-08-02', estimateId: 'e2', amount: 50, lines: DEP.lines('custdeposit', 'dep', 'bank', 50) },
    { id: 'r2', type: 'deprefund', date: '2026-08-20', estimateId: 'e2', amount: 50, lines: DEP.lines('deprefund', 'dep', 'bank', 50) },
  ];
  const ps = CASH.cashPostings(entries, docs, ['ar']);
  const sum = (acct, from, to) => Math.round(ps.filter(p => p.account === acct && (!from || p.date >= from) && (!to || p.date <= to)).reduce((s, p) => s + p.debit - p.credit, 0) * 100) / 100;
  const all = Math.round(ps.reduce((s, p) => s + p.debit - p.credit, 0) * 100) / 100;
  assert.equal(all, 0, 'debits equal credits');
  // The deposit itself is never income: August has the money in the bank and the liability, and no income.
  assert.equal(sum('inc', '2026-08-01', '2026-08-31'), 0);
  assert.equal(sum('dep', null, '2026-08-31'), -300, 'held for the job (the refunded one is gone)');
  // Used on the invoice on Sept 10: that settles 300 of 1130, so that share of income and tax counts on Sept 10.
  assert.equal(sum('inc', '2026-09-01', '2026-09-30'), -265.49);
  assert.equal(sum('hst', '2026-09-01', '2026-09-30'), -34.51);
  assert.equal(sum('dep'), 0, 'used up');
  assert.equal(sum('inc'), -1000, 'all of it once paid');
  assert.equal(sum('ar'), 0, 'no A/R on the cash basis');
  for (const d of ['2026-08-31', '2026-09-30', '2026-10-31']) assert.equal(Math.round(ps.filter(p => p.date <= d).reduce((s, p) => s + p.debit - p.credit, 0) * 100) / 100, 0, 'balanced as of ' + d);
});
