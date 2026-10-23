'use strict';
require('./setup-payroll-on'); // year-end files on, as `npm test` does
// Year-end files: suggested adjusting entries, last year brought over from CaseWare, and the trial balance from the
// client's QuickBooks Online or Xero (with stand-ins for Intuit's and Xero's APIs).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const E = require('../public/engagements-calc.js');
const { createApp } = require('../src/server/app');

test('suggested adjusting entries: amortization, accruals and shareholder reclassifications, once each', () => {
  const accounts = [{ id: 'sh1', name: 'Due to shareholder', type: 'Liability' }, { id: 'sh2', name: 'Due from shareholder', type: 'Asset' }, { id: 'rent', name: 'Rent', type: 'Expense' }, { id: 'acc', name: 'Accrued liabilities', type: 'Liability' }];
  const file = { yearEnd: '2025-12-31', ajes: [], map: {}, snapshot: { lines: [{ account: 'sh1', name: 'Due to shareholder', type: 'Liability', cur: 2500, prior: 0 }, { account: 'rent', name: 'Rent', type: 'Expense', cur: -2500, prior: 0 }] } };
  const ctx = { amort: [{ id: 'as1', name: 'Truck', amount: 4200, expense: 'amx', accum: 'acx' }, { id: 'as2', name: 'Nothing', amount: 0, expense: 'amx', accum: 'acx' }],
    bills: [{ id: 'b1', vendor: 'Hydro', number: '77', date: '2026-01-10', lines: [{ account: 'rent', amount: 300 }, { account: 'acc', amount: 39 }] }], accrualAccount: 'acc', types: { rent: 'Expense', acc: 'Liability' } };
  const s = E.suggestAjes(file, accounts, ctx);
  assert.deepEqual(s.map(x => x.kind), ['amortization', 'accrual', 'reclass']);
  const [am, ac, rc] = s;
  assert.deepEqual(am.lines, [{ account: 'amx', debit: 4200, credit: 0 }, { account: 'acx', debit: 0, credit: 4200 }]);
  assert.equal(am.key, 'amort:as1:2025-12-31');
  assert.deepEqual(ac.lines, [{ account: 'rent', debit: 300, credit: 0 }, { account: 'acc', debit: 0, credit: 300 }], 'expense lines only (not the tax)');
  assert.deepEqual(rc.lines, [{ account: 'sh2', debit: 2500, credit: 0 }, { account: 'sh1', debit: 0, credit: 2500 }]);
  for (const x of s) assert.equal(E.ajeProblem({ num: 1, memo: x.memo, lines: x.lines }), '', x.key);
  // Once added (fromId), not suggested again.
  assert.deepEqual(E.suggestAjes({ ...file, ajes: [{ fromId: am.key }, { fromId: ac.key }] }, accounts, ctx).map(x => x.kind), ['reclass']);
  assert.deepEqual(E.suggestAjes(file, accounts, { ...ctx, accrualAccount: '' }).map(x => x.kind), ['amortization', 'reclass']);
});

/* ---------- the server ---------- */
const QBO_ID = 'ABqbo1234567890client', QBO_SECRET = 'qboSecret1234567890', XERO_ID = 'XEROCLIENT1234567890', XERO_SECRET = 'xeroSecret_1234567890';
const fake = { calls: [], tokens: {}, n: 0, expireNext: false };
const URLS = {
  qbo: { authorize: 'https://appcenter.example/connect/oauth2', token: 'https://oauth.example/qbo/token', revoke: 'https://oauth.example/qbo/revoke', api: { production: 'https://qbo.example', sandbox: 'https://sandbox-qbo.example' }, scope: 'com.intuit.quickbooks.accounting' },
  xero: { authorize: 'https://login.xero.example/authorize', token: 'https://identity.xero.example/token', connections: 'https://api.xero.example/connections', api: 'https://api.xero.example/api.xro/2.0', scope: 'offline_access accounting.reports.read accounting.settings.read' },
};
const QBO_TB = { Header: {}, Rows: { Row: [
  { ColData: [{ value: 'Chequing', id: '35' }, { value: '12,500.00' }, { value: '' }] },
  { ColData: [{ value: 'Accounts Payable (A/P)', id: '33' }, { value: '' }, { value: '2500.00' }] },
  { ColData: [{ value: 'Retained Earnings', id: '2' }, { value: '' }, { value: '4000.00' }] },
  { ColData: [{ value: 'Sales', id: '79' }, { value: '' }, { value: '20000.00' }] },
  { Header: { ColData: [{ value: 'Expenses' }] }, Rows: { Row: [{ ColData: [{ value: 'Rent', id: '57' }, { value: '14000.00' }, { value: '' }] }] } },
  { ColData: [{ value: 'Nothing', id: '90' }, { value: '' }, { value: '' }] },
  { group: 'GrandTotal', Summary: { ColData: [{ value: 'TOTAL' }, { value: '26500.00' }, { value: '26500.00' }] } },
] } };
const QBO_ACCOUNTS = { QueryResponse: { Account: [
  { Id: '35', Name: 'Chequing', AcctNum: '1000', AccountType: 'Bank' }, { Id: '33', Name: 'Accounts Payable (A/P)', AccountType: 'Accounts Payable' },
  { Id: '2', Name: 'Retained Earnings', AccountType: 'Equity', AccountSubType: 'RetainedEarnings' }, { Id: '79', Name: 'Sales', AcctNum: '4000', AccountType: 'Income' }, { Id: '57', Name: 'Rent', AccountType: 'Expense' }] } };
const XERO_TB = { Reports: [{ ReportID: 'TrialBalance', Rows: [
  { RowType: 'Header', Cells: [{ Value: 'Account' }, { Value: 'Debit' }, { Value: 'Credit' }, { Value: 'YTD Debit' }, { Value: 'YTD Credit' }] },
  { RowType: 'Section', Title: 'Revenue', Rows: [{ RowType: 'Row', Cells: [{ Value: 'Sales (200)', Attributes: [{ Value: 'a-200', Id: 'account' }] }, { Value: '' }, { Value: '500.00' }, { Value: '' }, { Value: '9000.00' }] }] },
  { RowType: 'Section', Title: 'Expenses', Rows: [{ RowType: 'Row', Cells: [{ Value: 'Rent (469)', Attributes: [{ Value: 'a-469', Id: 'account' }] }, { Value: '' }, { Value: '' }, { Value: '6000.00' }, { Value: '' }] }] },
  { RowType: 'Section', Title: 'Assets', Rows: [{ RowType: 'Row', Cells: [{ Value: 'Business Bank (090)', Attributes: [{ Value: 'a-090', Id: 'account' }] }, { Value: '' }, { Value: '' }, { Value: '4500.00' }, { Value: '' }] }] },
  { RowType: 'Section', Title: 'Equity', Rows: [{ RowType: 'Row', Cells: [{ Value: 'Retained Earnings (960)', Attributes: [{ Value: 'a-960', Id: 'account' }] }, { Value: '' }, { Value: '' }, { Value: '' }, { Value: '1500.00' }] }] },
  { RowType: 'Section', Title: '', Rows: [{ RowType: 'SummaryRow', Cells: [{ Value: 'Total' }, { Value: '' }, { Value: '' }, { Value: '10500.00' }, { Value: '10500.00' }] }] },
] }] };
const XERO_ACCOUNTS = { Accounts: [{ AccountID: 'a-200', Code: '200', Name: 'Sales', Type: 'REVENUE' }, { AccountID: 'a-469', Code: '469', Name: 'Rent', Type: 'OVERHEADS' }, { AccountID: 'a-090', Code: '090', Name: 'Business Bank', Type: 'BANK' }, { AccountID: 'a-960', Code: '960', Name: 'Retained Earnings', Type: 'EQUITY' }] };

async function fakeFetch(url, init = {}) {
  const u = new URL(url), h = init.headers || {};
  fake.calls.push({ url: u.toString(), method: init.method || 'GET', headers: h, body: init.body });
  const json = (status, j) => ({ ok: status < 400, status, json: async () => j });
  const basic = (id, sec) => h.Authorization === 'Basic ' + Buffer.from(`${id}:${sec}`).toString('base64');
  if (u.toString() === URLS.qbo.token || u.toString() === URLS.xero.token) {
    const qbo = u.toString() === URLS.qbo.token;
    if (!(qbo ? basic(QBO_ID, QBO_SECRET) : basic(XERO_ID, XERO_SECRET))) return json(401, { error: 'invalid_client' });
    const p = new URLSearchParams(init.body);
    if (p.get('grant_type') === 'authorization_code' && p.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
    if (p.get('grant_type') === 'refresh_token' && !fake.tokens['r:' + p.get('refresh_token')]) return json(400, { error: 'invalid_grant' });
    const n = ++fake.n, access = `acc${n}`, refresh = `ref${n}`;
    fake.tokens[access] = true; fake.tokens['r:' + refresh] = true;
    return json(200, { access_token: access, refresh_token: refresh, expires_in: fake.expireNext ? 1 : 3600, token_type: 'bearer' });
  }
  if (u.toString() === URLS.qbo.revoke) { fake.revoked = JSON.parse(init.body).token; return json(200, {}); }
  const tok = String(h.Authorization || '').replace('Bearer ', '');
  if (!fake.tokens[tok]) return json(401, { error: 'expired' });
  if (u.toString() === URLS.xero.connections) return json(200, [{ tenantId: 'tenant-1', tenantName: 'Northern Lights Ltd', tenantType: 'ORGANISATION' }]);
  if (u.host === 'qbo.example') {
    if (u.pathname.endsWith('/companyinfo/9130')) return json(200, { CompanyInfo: { CompanyName: 'Maple Dental Inc.' } });
    if (u.pathname.endsWith('/query')) return json(200, QBO_ACCOUNTS);
    if (u.pathname.endsWith('/reports/TrialBalance')) return json(200, QBO_TB);
  }
  if (u.host === 'api.xero.example') {
    if (h['xero-tenant-id'] !== 'tenant-1') return json(403, {});
    if (u.pathname.endsWith('/Accounts')) return json(200, XERO_ACCOUNTS);
    if (u.pathname.endsWith('/Reports/TrialBalance')) return json(200, XERO_TB);
  }
  return json(404, {});
}

let server, base, dir, owner, client, co, co2;
async function req(cookie, method, url, body) {
  const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-ledgers-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, autoWorkflows: false, publicUrl: 'https://app.sumlora.example', ledgerFetch: fakeFetch, ledgerUrls: URLS });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple', firmName: 'Sher Bookkeeping', acceptTerms: true }) });
  owner = s.headers.get('set-cookie').split(';')[0];
  co = (await req(owner, 'POST', '/api/companies', { name: 'Maple Dental', province: 'ON' })).json.company.id;
  co2 = (await req(owner, 'POST', '/api/companies', { name: 'Northern Lights', province: 'ON' })).json.company.id;
  const link = (await req(owner, 'POST', '/api/users', { name: 'Client', username: 'client@example.com', role: 'client', companies: [co], invite: true })).json.user.link;
  const acc = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link, password: 'client long phrase here', acceptTerms: true }) });
  client = acc.headers.get('set-cookie').split(';')[0];
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('server: CaseWare prior year on a books file: own lines only for the prior year', async () => {
  const accts = (await req(owner, 'GET', `/api/c/${co}/state`)).json.accounts;
  const bank = accts.find(a => a.detail === 'bank').id, sales = accts.find(a => a.type === 'Income').id;
  const snap = lines => ({ takenAt: Date.now(), by: 'Sher', lines, priorSource: 'caseware', priorImport: { [bank]: 800, 'x:cw-1500': 200, [E.RE_OPEN]: -1000, nope: 5 }, priorFile: 'cw.xlsx' });
  const ok = [{ account: bank, name: 'Chequing', type: 'Asset', cur: 1000, prior: 800 }, { account: sales, name: 'Sales', type: 'Income', cur: -1000, prior: 0 }, { account: 'x:cw-1500', name: 'Old truck', type: 'Asset', cur: 0, prior: 200 }, { account: E.RE_OPEN, name: 'Retained earnings', type: 'Equity', cur: 0, prior: -1000 }];
  let r = await req(owner, 'PUT', `/api/c/${co}/records/engagements/cw1`, { yearEnd: '2025-12-31', kind: 'compilation', status: 'progress', snapshot: snap(ok), map: {}, ajes: [] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const f = (await req(owner, 'GET', `/api/c/${co}/state`)).json.engagements.find(x => x.id === 'cw1');
  assert.equal(f.snapshot.priorSource, 'caseware'); assert.equal(f.snapshot.priorFile, 'cw.xlsx');
  assert.deepEqual(f.snapshot.priorImport, { [bank]: 800, 'x:cw-1500': 200, [E.RE_OPEN]: -1000 }, 'unknown accounts dropped');
  // An own line with a current-year balance in a file that follows the books: not allowed.
  const bad = ok.map(l => l.account === 'x:cw-1500' ? { ...l, cur: 50 } : l.account === bank ? { ...l, cur: 950 } : l);
  r = await req(owner, 'PUT', `/api/c/${co}/records/engagements/cw2`, { yearEnd: '2024-12-31', kind: 'compilation', status: 'progress', snapshot: snap(bad), map: {}, ajes: [] });
  assert.equal(r.status, 400);
  await req(owner, 'DELETE', `/api/c/${co}/records/engagements/cw1`);
});

test('ledgers: the administrator’s keys, checked and never sent back', async () => {
  let st = (await req(owner, 'GET', '/api/ledgers')).json;
  assert.deepEqual([st.admin, st.qbo.configured, st.xero.configured, st.redirectUri], [true, false, false, 'https://app.sumlora.example/api/ledger/callback']);
  assert.equal((await req(owner, 'GET', `/api/c/${co}/ledger`)).json.configured.qbo, false);
  assert.equal((await req(owner, 'POST', `/api/c/${co}/ledger/connect`, { provider: 'qbo' })).status, 409, 'no keys yet');
  assert.equal((await req(owner, 'PUT', '/api/ledgers', { qbo: { clientId: 'has spaces in it' } })).status, 400);
  st = (await req(owner, 'PUT', '/api/ledgers', { qbo: { clientId: QBO_ID, secret: QBO_SECRET, env: 'production' }, xero: { clientId: XERO_ID, secret: XERO_SECRET } })).json;
  assert.deepEqual([st.qbo.configured, st.xero.configured, st.qbo.clientIdHint], [true, true, '…' + QBO_ID.slice(-4)]);
  assert.ok(![QBO_ID, QBO_SECRET, XERO_SECRET].some(k => JSON.stringify(st).includes(k)));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'ledgers.json')).mode & 0o077, 0);
  // Clients learn nothing and can't change anything.
  assert.equal((await req(client, 'PUT', '/api/ledgers', { qbo: { clientId: '' } })).status, 403);
  assert.equal((await req(client, 'GET', `/api/c/${co}/ledger`)).status, 403);
  assert.equal((await req(client, 'POST', `/api/c/${co}/ledger/connect`, { provider: 'qbo' })).status, 403);
});

test('ledgers: QuickBooks Online: connect through Intuit’s sign-in and bring the trial balance in', async () => {
  const r = await req(owner, 'POST', `/api/c/${co}/ledger/connect`, { provider: 'qbo' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const u = new URL(r.json.url), state = u.searchParams.get('state');
  assert.equal(u.origin + u.pathname, URLS.qbo.authorize);
  assert.deepEqual([u.searchParams.get('client_id'), u.searchParams.get('scope'), u.searchParams.get('redirect_uri'), u.searchParams.get('response_type')], [QBO_ID, URLS.qbo.scope, 'https://app.sumlora.example/api/ledger/callback', 'code']);
  // Coming back: a made-up state is refused; the real one works once, without a session cookie (SameSite=Strict).
  let cb = await req(null, 'GET', `/api/ledger/callback?code=good-code&state=madeup&realmId=9130`);
  assert.equal(cb.status, 200); assert.match(cb.text, /wasn’t made/);
  cb = await req(null, 'GET', `/api/ledger/callback?code=good-code&state=${state}&realmId=9130`);
  assert.match(cb.text, /Connected to QuickBooks Online/); assert.match(cb.text, /Maple Dental Inc\./);
  assert.ok(!/<script/i.test(cb.text));
  cb = await req(null, 'GET', `/api/ledger/callback?code=good-code&state=${state}&realmId=9130`);
  assert.match(cb.text, /expired/, 'a state is used once');
  const st = (await req(owner, 'GET', `/api/c/${co}/ledger`)).json;
  assert.deepEqual([st.connected, st.provider, st.name, st.by], [true, 'qbo', 'Maple Dental Inc.', 'Sher']);
  assert.ok(!JSON.stringify(st).includes('acc1') && !JSON.stringify(st).includes('ref1'), 'tokens stay on the server');
  assert.equal((await req(owner, 'GET', `/api/c/${co2}/ledger`)).json.connected, false, 'only that company');

  const tb = await req(owner, 'GET', `/api/c/${co}/ledger/tb?start=2025-01-01&end=2025-12-31`);
  assert.equal(tb.status, 200, JSON.stringify(tb.json));
  const call = fake.calls.find(x => x.url.includes('/reports/TrialBalance'));
  assert.match(call.url, /^https:\/\/qbo\.example\/v3\/company\/9130\/reports\/TrialBalance\?start_date=2025-01-01&end_date=2025-12-31&accounting_method=Accrual/);
  assert.deepEqual(tb.json.lines.map(l => [l.id, l.code, l.type, l.detail, l.amount, !!l.retained]), [
    ['35', '1000', 'Asset', 'bank', 12500, false], ['33', '', 'Liability', 'ap', -2500, false], ['2', '', 'Equity', '', -4000, true], ['79', '4000', 'Income', '', -20000, false], ['57', '', 'Expense', '', 14000, false]]);
  assert.equal(tb.json.lines.reduce((t, l) => t + l.amount, 0), 0);
  assert.equal((await req(owner, 'GET', `/api/c/${co}/ledger/tb?start=2025-12-31&end=2025-01-01`)).status, 400);

  // The access token runs out: it's refreshed on the next call.
  delete fake.tokens.acc1;
  const again = await req(owner, 'GET', `/api/c/${co}/ledger/tb?start=2025-01-01&end=2025-12-31`);
  assert.equal(again.status, 200, 'refreshed with the refresh token');
  assert.ok(fake.calls.some(x => x.url === URLS.qbo.token && /grant_type=refresh_token/.test(x.body)));
  // The refresh token no longer works either: connect again.
  for (const k of Object.keys(fake.tokens)) delete fake.tokens[k];
  const gone = await req(owner, 'GET', `/api/c/${co}/ledger/tb?start=2025-01-01&end=2025-12-31`);
  assert.equal(gone.status, 401); assert.match(gone.json.error, /Connect again/);
  fake.tokens.acc9 = true; fake.tokens['r:ref9'] = true;
  const L = JSON.parse(fs.readFileSync(path.join(dir, 'ledgers.json'), 'utf8')).connections[co];
  assert.ok(L && L.refresh, 'the connection is kept, to connect again over');

  // A year-end file from QuickBooks Online: its own accounts, like an import.
  const lines = tb.json.lines.map(l => ({ account: l.retained ? E.RE_OPEN : `x:qbo-${l.id}`, code: l.code, name: l.name, type: l.type, detail: l.detail, cur: l.amount, prior: 0 }));
  const put = await req(owner, 'PUT', `/api/c/${co}/records/engagements/q1`, { yearEnd: '2025-12-31', kind: 'compilation', status: 'progress', map: {}, ajes: [{ num: 1, memo: 'Accrue', lines: [{ account: 'x:qbo-57', debit: 100 }, { account: 'x:qbo-33', credit: 100 }] }],
    snapshot: { takenAt: Date.now(), by: 'Sher', source: 'qbo', pulledAt: 123, ledgerName: 'Maple Dental Inc.', lines } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  const f = (await req(owner, 'GET', `/api/c/${co}/state`)).json.engagements.find(x => x.id === 'q1');
  assert.deepEqual([f.snapshot.source, f.snapshot.pulledAt, f.snapshot.ledgerName, f.snapshot.lines.length, f.ajes.length], ['qbo', 123, 'Maple Dental Inc.', 5, 1]);

  // Disconnect: the tokens are revoked at Intuit; the file keeps its trial balance.
  assert.equal((await req(owner, 'DELETE', `/api/c/${co}/ledger`)).json.connected, false);
  assert.ok(fake.revoked && fake.revoked.startsWith('ref'));
  assert.equal((await req(owner, 'GET', `/api/c/${co}/ledger/tb?start=2025-01-01&end=2025-12-31`)).status, 404);
  assert.ok((await req(owner, 'GET', `/api/c/${co}/state`)).json.engagements.some(x => x.id === 'q1'));
});

test('ledgers: Xero: the organisation is picked up, and the year-to-date columns are used', async () => {
  const r = await req(owner, 'POST', `/api/c/${co2}/ledger/connect`, { provider: 'xero' });
  const state = new URL(r.json.url).searchParams.get('state');
  assert.equal(new URL(r.json.url).searchParams.get('scope'), URLS.xero.scope);
  const cancelled = await req(owner, 'POST', `/api/c/${co2}/ledger/connect`, { provider: 'xero' });
  const cb0 = await req(null, 'GET', `/api/ledger/callback?error=access_denied&state=${new URL(cancelled.json.url).searchParams.get('state')}`);
  assert.match(cb0.text, /access_denied/);
  const cb = await req(null, 'GET', `/api/ledger/callback?code=good-code&state=${state}`);
  assert.match(cb.text, /Connected to Xero/); assert.match(cb.text, /Northern Lights Ltd/);
  const tb = (await req(owner, 'GET', `/api/c/${co2}/ledger/tb?start=2025-01-01&end=2025-12-31`)).json;
  assert.equal(tb.provider, 'xero');
  assert.deepEqual(tb.lines.map(l => [l.id, l.code, l.name, l.type, l.detail, l.amount, !!l.retained]), [
    ['a-200', '200', 'Sales', 'Income', '', -9000, false], ['a-469', '469', 'Rent', 'Expense', '', 6000, false], ['a-090', '090', 'Business Bank', 'Asset', 'bank', 4500, false], ['a-960', '960', 'Retained Earnings', 'Equity', '', -1500, true]]);
  assert.ok(fake.calls.some(x => x.url.endsWith('/Reports/TrialBalance?date=2025-12-31') && x.headers['xero-tenant-id'] === 'tenant-1'));
  assert.equal((await req(owner, 'POST', `/api/c/${co2}/ledger/connect`, { provider: 'sage' })).status, 400);
  // Removing the company removes its connection.
  assert.equal((await req(owner, 'DELETE', `/api/companies/${co2}`)).status, 200);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'ledgers.json'), 'utf8')).connections[co2]);
});

