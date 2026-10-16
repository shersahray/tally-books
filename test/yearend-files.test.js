'use strict';
require('./setup-payroll-on'); // year-end files (and payroll) on, as `npm test` does
// Year-end files: coming soon by default; the leadsheet math; and on the server, firm staff only, a snapshot that
// adds up, final files locked, accounts on a file kept, and nothing for clients.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const E = require('../public/engagements-calc.js');
const { createApp } = require('../src/server/app');

test('year-end files are coming soon: out of every plan until switched on', () => {
  const env = { ...process.env }; delete env.SUMLORA_YEAREND;
  const probe = `const P = require(${JSON.stringify(path.join(__dirname, '..', 'public', 'plans.js'))});
    console.log(JSON.stringify({ soon: P.comingSoon('yearEndFiles'), flagged: P.FEATURES.yearEndFiles.comingSoon, inThrive: P.PLANS.thrive.features.includes('yearEndFiles'), on: P.featureOn('thrive', {}, 'yearEndFiles', {}), blurb: P.PLANS.thrive.blurb }));`;
  const r = JSON.parse(execFileSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' }));
  assert.deepEqual([r.soon, r.flagged, r.inThrive, r.on], [true, true, false, false]);
  assert.ok(!/year-end/i.test(r.blurb));
});

test('leadsheets: suggestions from type, detail, GIFI code and name', () => {
  const s = (name, type, extra) => E.suggest({ name, type, ...extra });
  assert.equal(s('Chequing', 'Asset', { detail: 'bank' }), 'A');
  assert.equal(s('Accounts receivable', 'Asset', { detail: 'ar' }), 'C');
  assert.equal(s('Due from shareholder', 'Asset'), 'F');
  assert.equal(s('Computer equipment', 'Asset', { detail: 'capital' }), 'G');
  assert.equal(s('Accumulated amortization', 'Asset', { gifi: '1775' }), 'G');
  assert.equal(s('Prepaid insurance', 'Asset'), 'E');
  assert.equal(s('HST payable', 'Liability', { detail: 'tax' }), 'CC');
  assert.equal(s('Income taxes payable', 'Liability'), 'DD');
  assert.equal(s('Due to shareholder', 'Liability', { gifi: '2780' }), 'GG');
  assert.equal(s('Bank loan', 'Liability'), 'FF');
  assert.equal(s('Accounts payable', 'Liability', { detail: 'ap' }), 'BB');
  assert.equal(s('Common shares', 'Equity'), 'SC');
  assert.equal(s('Sales', 'Income'), 'R');
  assert.equal(s('Interest income', 'Income'), 'OI');
  assert.equal(s('Purchases', 'Cost of Goods Sold'), 'COS');
  assert.equal(s('Rent', 'Expense'), 'X');
  assert.equal(s('Current income taxes', 'Expense', { gifi: '9990' }), 'IT');
  assert.equal(E.suggest({ id: E.RE_OPEN, type: 'Equity' }), 'RE');
});

test('leadsheets: adjustments change the working trial balance, leadsheet totals and net income', () => {
  const file = {
    snapshot: { lines: [
      { account: 'bank', name: 'Chequing', type: 'Asset', detail: 'bank', cur: 5000, prior: 3000 },
      { account: 'eq', name: 'Computer equipment', type: 'Asset', detail: 'capital', cur: 3000, prior: 0 },
      { account: 'sales', name: 'Sales', type: 'Income', cur: -10000, prior: -8000 },
      { account: 'rent', name: 'Rent', type: 'Expense', cur: 2000, prior: 5000 },
    ] },
    map: { rent: 'OI' },
    ajes: [{ num: 1, lines: [{ account: 'amort', debit: 600, credit: 0 }, { account: 'eq', debit: 0, credit: 600 }] }],
  };
  const tb = E.workingTb(file, [{ id: 'amort', name: 'Amortization', type: 'Expense' }]);
  assert.equal(tb.find(r => r.account === 'eq').final, 2400);
  assert.equal(tb.find(r => r.account === 'amort').final, 600, 'an account only in an adjusting entry is added');
  assert.equal(tb.find(r => r.account === 'rent').lead, 'OI', 'the accountant’s choice wins');
  assert.equal(E.netIncome(tb, 'cur'), 8000);
  assert.equal(E.netIncome(tb, 'final'), 7400);
  assert.equal(E.netIncome(tb, 'prior'), 3000);
  const ls = E.leadsheets(file, [{ id: 'amort', name: 'Amortization', type: 'Expense' }]);
  assert.deepEqual(ls.map(l => l.code), ['A', 'G', 'R', 'X', 'OI']);
  assert.deepEqual([ls[1].cur, ls[1].adj, ls[1].final], [3000, -600, 2400]);
  assert.equal(E.ajeProblem({ lines: [{ debit: 10 }, { credit: 9 }] }), 'Debits and credits don’t balance (off by 1.00).');
  assert.equal(E.ajeProblem({ lines: [{ debit: 10 }] }), 'An adjusting entry needs at least two lines with amounts.');
  assert.deepEqual(E.changedSince(file, { bank: 5000, eq: 3000, sales: -10500, rent: 2000 }).map(x => x.account), ['sales']);
});

test('statements and GIFI: the balance sheet balances, retained earnings roll forward, and Schedule 125 agrees', () => {
  const f = { snapshot: { lines: [
    { account: 'bank', name: 'Chequing', type: 'Asset', detail: 'bank', gifi: '1001', cur: 5000, prior: 3000 },
    { account: 'eq', name: 'Equipment', type: 'Asset', detail: 'capital', gifi: '1740', cur: 3000, prior: 0 },
    { account: 'ap', name: 'Accounts payable', type: 'Liability', detail: 'ap', gifi: '2620', cur: -1000, prior: -500 },
    { account: 'sh', name: 'Common shares', type: 'Equity', gifi: '3500', cur: -100, prior: -100 },
    { account: E.RE_OPEN, name: 'Retained earnings, beginning of year', type: 'Equity', gifi: '3600', cur: -2400, prior: 0 },
    { account: 'div', name: 'Dividends', type: 'Equity', gifi: '3700', cur: 500, prior: 0 },
    { account: 'sales', name: 'Sales', type: 'Income', gifi: '8000', cur: -10000, prior: -8000 },
    { account: 'rent', name: 'Rent', type: 'Expense', gifi: '8910', cur: 5000, prior: 5600 },
  ] }, ajes: [{ lines: [{ account: 'amort', debit: 600 }, { account: 'eq', credit: 600 }] }] };
  const accts = [{ id: 'amort', name: 'Amortization', type: 'Expense', gifi: '8670' }];
  const st = E.statements(f, accts);
  assert.deepEqual(st.is.net, { cur: 4400, prior: 2400 });
  assert.deepEqual(st.re.closing, { cur: 6300, prior: 2400 });
  assert.deepEqual(st.bs.off, { cur: 0, prior: 0 });
  assert.deepEqual(st.bs.assets, { cur: 7400, prior: 3000 });
  const g = E.gifi(f, accts), at = code => g.lines.find(l => l.code === code);
  assert.ok(g.agrees);
  assert.deepEqual([at('2599').cur, at('3640').cur, at('3600').cur, at('3700').cur, at('9367').cur, at('9999').cur], [7400, 7400, 6300, 500, 5600, 4400]);
  assert.equal(at('1740').cur, 2400, 'the adjustment reaches the GIFI line');
  // An account with no GIFI code is listed, and fixing it in the chart of accounts is used without a new snapshot.
  const g2 = E.gifi(f, [{ id: 'amort', name: 'Amortization', type: 'Expense' }]);
  assert.deepEqual(g2.missing.map(m => m.account), ['amort']); assert.equal(g2.agrees, false);
});

/* ---------- on the server ---------- */
let server, base, dir, owner, client, co;
async function req(cookie, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const c = url => `/api/c/${co}${url}`;
let bank, sales, rent;
const file = (extra = {}) => ({
  yearEnd: '2025-12-31', kind: 'compilation', status: 'open',
  snapshot: { takenAt: Date.now(), by: 'Sher', lines: [{ account: bank, name: 'Chequing', type: 'Asset', cur: 1000, prior: 0 }, { account: sales, name: 'Sales', type: 'Income', cur: -1000, prior: 0 }] },
  map: {}, ajes: [], ...extra,
});

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-yearfiles-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, autoWorkflows: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple', firmName: 'Sher Bookkeeping' }) });
  owner = s.headers.get('set-cookie').split(';')[0];
  co = (await req(owner, 'POST', '/api/companies', { name: 'Maple Dental', province: 'ON' })).json.company.id;
  const accts = (await req(owner, 'GET', c('/state'))).json.accounts;
  bank = accts.find(a => a.detail === 'bank').id; sales = accts.find(a => a.type === 'Income').id; rent = accts.find(a => a.type === 'Expense').id;
  const link = (await req(owner, 'POST', '/api/users', { name: 'Client', username: 'client@example.com', role: 'client', companies: [co], invite: true })).json.user.link;
  const acc = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link, password: 'client long phrase here' }) });
  client = acc.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('server: staff make a year-end file; it must add up, and a final one is locked until reopened', async () => {
  let r = await req(owner, 'PUT', c('/records/engagements/y1'), file({ map: { [sales]: 'OI', nope: 'A', [bank]: 'ZZ' } }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let y = (await req(owner, 'GET', c('/state'))).json.engagements.find(x => x.id === 'y1');
  assert.deepEqual(y.map, { [sales]: 'OI' }, 'unknown accounts and leadsheets are dropped');
  r = await req(owner, 'PUT', c('/records/engagements/y2'), file({ snapshot: { lines: [{ account: bank, cur: 1000 }, { account: sales, cur: -999 }] } }));
  assert.equal(r.status, 400); assert.match(r.json.error, /doesn’t add up to zero/);
  r = await req(owner, 'PUT', c('/records/engagements/y1'), file({ ajes: [{ id: 'j1', num: 1, lines: [{ account: rent, debit: 50 }, { account: bank, credit: 40 }] }] }));
  assert.equal(r.status, 400); assert.match(r.json.error, /don’t balance/);
  r = await req(owner, 'PUT', c('/records/engagements/y1'), file({ ajes: [{ id: 'j1', num: 1, memo: 'Accrual', lines: [{ account: rent, debit: 50 }, { account: bank, credit: 50 }] }] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // An account on a year-end file's adjusting entry can't be deleted.
  r = await req(owner, 'DELETE', c(`/records/accounts/${rent}`));
  assert.equal(r.status, 409);
  y = (await req(owner, 'GET', c('/state'))).json.engagements.find(x => x.id === 'y1');
  assert.equal((await req(owner, 'PUT', c('/records/engagements/y1'), { ...y, status: 'final', finalBy: 'Sher' })).status, 200);
  y = (await req(owner, 'GET', c('/state'))).json.engagements.find(x => x.id === 'y1');
  r = await req(owner, 'PUT', c('/records/engagements/y1'), { ...y, notes: 'changed' });
  assert.equal(r.status, 409, 'a final file can’t change');
  assert.equal((await req(owner, 'PUT', c('/records/engagements/y1'), { ...y, status: 'open' })).status, 200, 'but it can be reopened');
});

test('server: clients never see or change year-end files', async () => {
  const s = await req(client, 'GET', c('/state'));
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.engagements, []);
  assert.equal((await req(client, 'PUT', c('/records/engagements/y9'), file())).status, 403);
  assert.equal((await req(client, 'DELETE', c('/records/engagements/y1'))).status, 403);
  assert.equal((await req(owner, 'GET', c('/state'))).json.engagements.length, 1, 'still there for staff');
});

test('server: a company with year-end files switched off can’t make them', async () => {
  const { rev, closingDate, closingPassword, hasCode, ...co0 } = (await req(owner, 'GET', c('/state'))).json.company;
  assert.equal((await req(owner, 'PUT', c('/settings'), { ...co0, features: { ...(co0.features || {}), yearEndFiles: false } })).status, 200);
  assert.deepEqual((await req(owner, 'GET', c('/state'))).json.engagements, [], 'hidden while off');
  const r = await req(owner, 'PUT', c('/records/engagements/y3'), file({ yearEnd: '2024-12-31' }));
  assert.equal(r.status, 403);
});
