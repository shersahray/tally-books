'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// Classes on each line (company setting classPerLine): one bill or invoice split across classes. How the forms post
// them (app.js calcLines, docPostLines, moneyLines), how the reports add them up (reports.js rix, report-filters.js,
// cashbasis.js) and what the server accepts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const RF = require('../public/report-filters.js');
const CASH = require('../public/cashbasis.js');
const { createApp } = require('../src/server/app');

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const J = x => JSON.parse(JSON.stringify(x));

/* ---------- the app's own posting code, run with the few globals it needs ---------- */
function appFns(company = {}) {
  const src = pub('app.js'), pick = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, start); const j = src.indexOf(end, i); return src.slice(i, j); };
  const ctx = { S: { company: { taxRate: 13, taxName: 'HST', ...company }, accounts: [{ id: 'hst', detail: 'tax', name: 'HST payable' }] } };
  vm.createContext(ctx);
  vm.runInContext(`
    const r2=n=>Math.round(((+n)||0)*100+Number.EPSILON*100)/100;
    const byDetail=d=>S.accounts.find(a=>a.detail===d);
    ${pick('const pstOn=', '// Tax on a taxable amount')}
    ${pick('const taxCodeOf=', 'const taxCodeOptions')}
    ${pick('function calcLines(', '// Total per account')}
    ${pick('function groupBy(', 'const delBtn')}
    ${pick('function docPostLines(', '/** A saved document')}
    ${pick('const docRecord=', 'function docForm(')}
    ${pick('function moneyLines(', 'function moneyForm(')}
    this.calcLines=calcLines;this.docPostLines=docPostLines;this.docRecord=docRecord;this.moneyLines=moneyLines;`, ctx);
  return ctx;
}

test('a bill split across two classes posts each expense line with its class; tax and A/P stay without one', () => {
  const A = appFns();
  const c = A.calcLines([
    { desc: 'Rent, east store', account: 'rent', qty: 1, rate: 1000, taxCode: 'std', cls: 'k1' },
    { desc: 'Rent, west store', account: 'rent', qty: 1, rate: 600, taxCode: 'std', cls: 'k2' },
    { desc: 'Supplies', account: 'sup', qty: 1, rate: 100, taxCode: 'std', cls: 'k1' },
  ], x => (+x.qty || 0) * (+x.rate || 0), true);
  const lines = J(A.docPostLines('bill', c, 'ap'));
  assert.deepEqual(lines.filter(l => l.cls !== undefined).map(l => [l.account, l.debit, l.cls]), [['rent', 1000, 'k1'], ['rent', 600, 'k2'], ['sup', 100, 'k1']]);
  const tax = lines.find(l => l.account === 'hst'), ap = lines.find(l => l.account === 'ap');
  assert.equal(tax.cls, undefined); assert.equal(ap.cls, undefined);
  assert.equal(tax.debit, 221); assert.equal(ap.credit, 1921);
  assert.deepEqual(J(A.docRecord(c).lines).map(l => l.cls), ['k1', 'k2', 'k1'], 'the bill keeps each line’s class');
  // Without classes on lines (the setting off), lines with the same account are still added together, as before.
  const plain = A.calcLines([{ account: 'rent', qty: 1, rate: 1000, taxCode: 'std' }, { account: 'rent', qty: 1, rate: 600, taxCode: 'std' }], x => x.qty * x.rate, true);
  assert.deepEqual(J(A.docPostLines('bill', plain, 'ap')), [{ account: 'rent', debit: 1600, credit: 0, taxCode: 'std' }, { account: 'hst', debit: 208, credit: 0, memo: 'HST paid' }, { account: 'ap', debit: 0, credit: 1808 }]);
  assert.equal(J(A.docRecord(plain).lines)[0].cls, undefined);
  // An expense (money form) splits the same way; a line with no class keeps '' so it isn't given the transaction's.
  const e = A.calcLines([{ account: 'rent', amount: 50, taxCode: 'none', cls: 'k2' }, { account: 'rent', amount: 30, taxCode: 'none', cls: '' }], x => +x.amount, true);
  assert.deepEqual(J(A.moneyLines(true, e, 'bank')).map(l => [l.account, l.debit, l.credit, l.cls]), [['rent', 50, 0, 'k2'], ['rent', 30, 0, ''], ['bank', 0, 80, undefined]]);
});

/* ---------- the reports ---------- */
const ACCTS = [
  { id: 'bank', name: 'Chequing', type: 'Asset', detail: 'bank' }, { id: 'ar', name: 'Accounts receivable', type: 'Asset', detail: 'ar' },
  { id: 'ap', name: 'Accounts payable', type: 'Liability', detail: 'ap' }, { id: 'hst', name: 'HST payable', type: 'Liability', detail: 'tax' },
  { id: 'sales', name: 'Sales', type: 'Income' }, { id: 'rent', name: 'Rent', type: 'Expense' }, { id: 'sup', name: 'Supplies', type: 'Expense' },
];
const L = (account, debit, credit = 0, cls) => ({ account, debit, credit, ...(cls !== undefined ? { cls } : {}) });
const ENTRIES = [
  // A bill for two stores: rent split between East and West, supplies for East.
  { id: 'd_b1', type: 'bill', docId: 'b1', date: '2026-03-01', contactId: 'v1', lines: [L('rent', 1000, 0, 'k1'), L('rent', 600, 0, 'k2'), L('sup', 100, 0, 'k1'), L('hst', 221), L('ap', 0, 1921)] },
  // An invoice with a class at the top (as before) and one line moved to West.
  { id: 'd_i1', type: 'invoice', docId: 'i1', date: '2026-03-05', contactId: 'c1', cls: 'k1', lines: [L('ar', 2260), L('sales', 0, 1500), L('sales', 0, 500, 'k2'), L('hst', 0, 260)] },
  // An old expense with the class on the transaction only.
  { id: 'x1', type: 'expense', date: '2026-03-10', cls: 'k2', lines: [L('sup', 80), L('bank', 0, 80)] },
  // A journal entry with a class on each line, one line without.
  { id: 'j1', type: 'journal', date: '2026-03-20', cls: 'k1', lines: [L('rent', 300, 0, 'k2'), L('rent', 0, 100, ''), L('bank', 0, 200)] },
  { id: 'p1', type: 'billpayment', date: '2026-04-15', applyTo: 'b1', amount: 960.5, lines: [L('ap', 960.5), L('bank', 0, 960.5)] },
];
const DOCS = [{ id: 'b1', kind: 'bill', date: '2026-03-01', total: 1921 }, { id: 'i1', kind: 'invoice', date: '2026-03-05', total: 2260 }];
function loadReports(company = {}) {
  const ctx = {
    console, TallyRepFilter: RF, TallyCash: CASH,
    S: { accounts: ACCTS, entries: ENTRIES, docs: DOCS, contacts: [{ id: 'c1', name: 'Client', kind: 'customer' }, { id: 'v1', name: 'Landlord', kind: 'vendor' }], projects: [],
      company: { name: 'Test', classes: [{ id: 'k1', name: 'East' }, { id: 'k2', name: 'West' }], ...company }, rep: { tab: 'pl', period: 'custom', from: '2026-01-01', to: '2026-12-31' }, more: {} },
  };
  const app = pub('app.js'), i = app.indexOf('let PC=null;'), postingsSrc = app.slice(i, app.indexOf('\n', app.indexOf('function postings(', i)));
  vm.createContext(ctx);
  vm.runInContext(`
    const r2=n=>Math.round(((+n)||0)*100+Number.EPSILON*100)/100;
    const pad=n=>String(n).padStart(2,'0'),iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()),pd=s=>new Date(s+'T12:00:00');
    const addDays=(s,n)=>{const d=pd(s);d.setDate(d.getDate()+n);return iso(d)},daysBetween=(a,b)=>Math.round((pd(b)-pd(a))/864e5),monthEnd=(y,m)=>iso(new Date(y,m,0));
    function fyStartOf(s){return s.slice(0,4)+'-01-01'}
    const TYPES=['Asset','Liability','Equity','Income','Cost of Goods Sold','Expense'];
    const debitNormal=t=>t==='Asset'||t==='Expense'||t==='Cost of Goods Sold';
    ${postingsSrc}
    const acct=id=>S.accounts.find(a=>a.id===id);const acctName=id=>(acct(id)||{}).name||'';
    const sortAccts=a=>a.slice().sort((x,y)=>TYPES.indexOf(x.type)-TYPES.indexOf(y.type)||x.name.localeCompare(y.name));
    const contactName=id=>(S.contacts.find(c=>c.id===id)||{}).name||'';
    const T=s=>s,W=s=>s,esc=s=>String(s??''),money=n=>String(n),mcell=n=>String(n),LOC=()=>'en-CA',fmtDate=d=>d;
    const clsWords=()=>({one:'Class',many:'Classes',by:'By class',none:'No class',slug:'class'});
    const clsName=id=>((S.company.classes||[]).find(c=>c.id===id)||{}).name||'';
    const rh=(t,s)=>t+' '+s;const shownCount=(k,n,p)=>Math.min(n,p||100);const moreRow=()=>'';
    const TLABEL={invoice:'Invoice',bill:'Bill',expense:'Expense',journal:'Journal entry',billpayment:'Bill payment'};
    const tbReport=()=>null;
    ${pub('reports.js')}
    this.rPL=rPL;this.rTxList=rTxList;this.reset=()=>{PC=null};`, ctx);
  return ctx;
}
const row = (r, label) => J(r.rows.find(x => x.label === label));

test('P&L by class: each line goes to its class column, and the columns add up to the whole P&L', () => {
  const c = loadReports();
  const plain = c.rPL();
  c.S.rep.compare = 'byclass';
  const by = c.rPL();
  assert.deepEqual(J(by.head), ['East', 'West', 'No class', 'Total']);
  // East: rent 1000 (bill), supplies 100; sales 1500 (invoice's own class). West: rent 600 + 300 (journal), supplies 80, sales 500.
  assert.deepEqual(row(by, 'Rent').cells, [1000, 900, -100, 1800]);
  assert.deepEqual(row(by, 'Supplies').cells, [100, 80, 0, 180]);
  assert.deepEqual(row(by, 'Sales').cells, [1500, 500, 0, 2000]);
  for (const label of ['Sales', 'Rent', 'Supplies', 'Total income', 'Total expenses', 'Net income']) assert.equal(row(by, label).cells.at(-1), row(plain, label).cells[0], label);
  assert.deepEqual(row(by, 'Net income').cells, [400, -480, 100, 20]);
});

test('the class choice and the class filter pick up line classes', () => {
  const c = loadReports();
  c.S.rep.cls = 'k2';
  assert.deepEqual(row(c.rPL(), 'Rent').cells, [900]);
  assert.deepEqual(row(c.rPL(), 'Total income').cells, [500]);
  c.S.rep.cls = '__none';
  assert.deepEqual(row(c.rPL(), 'Rent').cells, [-100], 'a line set to no class is not given the transaction’s');
  c.S.rep.cls = ''; c.S.rep.flt = { cls: ['k1'] };
  assert.deepEqual(row(c.rPL(), 'Net income').cells, [400]);
  // The transaction list shows every class on a split transaction.
  c.S.rep.tab = 'tl'; c.S.rep.flt = null;
  const t = J(c.rTxList()).csv, bill = t.find(r => r[1] === 'Bill');
  assert.equal(bill[7], 'East, West');
  c.S.rep.flt = { cls: ['k2'] };
  assert.deepEqual(J(c.rTxList()).csv.slice(1, -1).map(r => r[1]).sort(), ['Bill', 'Expense', 'Invoice', 'Journal entry']);
  // The pure filter: a line class beats the transaction's.
  const ps = [{ e: { cls: 'k1' }, cls: 'k2', account: 'a' }, { e: { cls: 'k1' }, account: 'b' }, { e: { cls: 'k1' }, cls: '', account: 'c' }];
  assert.deepEqual(RF.apply(ps, { cls: ['k1'] }, { kind: () => '', projCust: () => '' }).map(p => p.account), ['b']);
  assert.deepEqual(RF.apply(ps, { cls: ['__none'] }, { kind: () => '', projCust: () => '' }).map(p => p.account), ['c']);
});

test('cash basis keeps each line’s class as the bill is paid', () => {
  const ps = CASH.cashPostings(ENTRIES, DOCS, new Set(['ar', 'ap']));
  const paid = ps.filter(p => p.e.id === 'd_b1' && p.date === '2026-04-15');
  assert.deepEqual(paid.filter(p => p.account !== 'ap' && p.account !== 'hst').map(p => [p.account, p.debit, p.cls]), [['rent', 500, 'k1'], ['rent', 300, 'k2'], ['sup', 50, 'k1']]);
  assert.ok(!ps.some(p => p.e.id === 'd_i1'), 'the unpaid invoice is left out');
  const c = loadReports();
  c.S.rep.basis = 'cash'; c.S.rep.compare = 'byclass';
  const by = c.rPL();
  assert.deepEqual(row(by, 'Rent').cells, [500, 600, -100, 1000]);
  assert.deepEqual(row(by, 'Total income').cells.at(-1), 0);
  c.S.rep.compare = ''; c.S.rep.cls = 'k1';
  assert.deepEqual(row(c.rPL(), 'Supplies').cells, [50]);
  // Accrual postings carry the class too.
  assert.deepEqual(CASH.accrualPostings([ENTRIES[1]]).map(p => p.cls), ['k1', 'k1', 'k2', 'k1']);
});

test('turning the setting off changes nothing in the reports', () => {
  const on = loadReports({ classPerLine: true }), off = loadReports({ classPerLine: false });
  for (const c of [on, off]) c.S.rep.compare = 'byclass';
  assert.deepEqual(J(on.rPL().csv), J(off.rPL().csv));
});

/* ---------- the server ---------- */
let server, base, dir, co, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-lcls-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Two Stores', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const company = async () => (await call('GET', '/api/c/state')).json.company;

test('server: the setting is kept, line classes must be the company’s, and they stay when the setting is off', async () => {
  const c0 = await company();
  assert.equal(c0.classPerLine, false, 'off by default');
  let r = await call('PUT', '/api/c/settings', { ...c0, classPerLine: 'yes', classes: [{ id: 'k1', name: 'East' }, { id: 'k2', name: 'West' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await company()).classPerLine, true);
  // A journal entry with a class on each line.
  const je = { type: 'journal', date: '2026-03-20', cls: 'k1', lines: [{ account: 'a6000', debit: 300, credit: 0, cls: 'k2' }, { account: 'a6000', debit: 0, credit: 100, cls: null }, { account: 'a1000', debit: 0, credit: 200 }] };
  r = await call('PUT', '/api/c/records/entries/j1', je);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let saved = (await call('GET', '/api/c/state')).json.entries.find(e => e.id === 'j1');
  assert.deepEqual(saved.lines.map(l => l.cls), ['k2', '', undefined]);
  assert.equal(saved.cls, 'k1');
  // A class that isn't the company's is refused, on the ledger lines, an expense's form lines and a bill's lines.
  r = await call('PUT', '/api/c/records/entries/j2', { ...je, lines: [{ ...je.lines[0], cls: 'nope' }, je.lines[1], je.lines[2]] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Line 1 has a class/);
  r = await call('PUT', '/api/c/records/entries/x1', { type: 'expense', date: '2026-03-10', form: { bank: 'a1000', lines: [{ account: 'a6000', amount: 80, cls: 7 }] }, lines: [{ account: 'a6000', debit: 80, credit: 0 }, { account: 'a1000', debit: 0, credit: 80 }] });
  assert.equal(r.status, 400);
  await call('PUT', '/api/c/records/contacts/v1', { name: 'Landlord', kind: 'vendor' });
  const bill = { kind: 'bill', number: 'B1', date: '2026-03-01', contactId: 'v1', total: 1600, sub: 1600, tax: 0, lines: [{ desc: 'East', account: 'a6000', qty: 1, rate: 1000, taxCode: 'none', cls: 'k1' }, { desc: 'West', account: 'a6000', qty: 1, rate: 600, taxCode: 'none', cls: 'k3' }] };
  assert.equal((await call('PUT', '/api/c/records/docs/b1', bill)).status, 400);
  bill.lines[1].cls = 'k2';
  r = await call('PUT', '/api/c/records/docs/b1', bill);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Turning the setting off keeps the line classes, and the entry can still be saved with them.
  const c1 = await company();
  assert.equal((await call('PUT', '/api/c/settings', { ...c1, classPerLine: false })).status, 200);
  assert.equal((await company()).classPerLine, false);
  saved = (await call('GET', '/api/c/state')).json.entries.find(e => e.id === 'j1');
  assert.deepEqual(saved.lines.map(l => l.cls), ['k2', '', undefined]);
  r = await call('PUT', '/api/c/records/entries/j1', { ...saved, memo: 'Edited' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'b1').lines.map(l => l.cls), ['k1', 'k2']);
});
