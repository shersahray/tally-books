'use strict';
// Report filters, the profit and loss by customer and the transaction list (public/report-filters.js), the
// Reports page code that uses them (public/reports.js, run with the few app globals it needs), and saved reports.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const RF = require('../public/report-filters.js');
const { createApp } = require('../src/server/app');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100 + 0;
/* ---------- a small set of books ---------- */
const ACCTS = [
  { id: 'bank', name: 'Chequing', type: 'Asset', detail: 'bank' }, { id: 'ar', name: 'Accounts receivable', type: 'Asset', detail: 'ar' },
  { id: 'ap', name: 'Accounts payable', type: 'Liability', detail: 'ap' }, { id: 'hst', name: 'HST payable', type: 'Liability', detail: 'tax' },
  { id: 'sales', name: 'Sales', type: 'Income' }, { id: 'svc', name: 'Services', type: 'Income' },
  { id: 'cogs', name: 'Materials', type: 'Cost of Goods Sold' }, { id: 'rent', name: 'Rent', type: 'Expense' }, { id: 'subs', name: 'Subcontractors', type: 'Expense' },
  { id: 'eq', name: 'Owner equity', type: 'Equity' },
];
const CONTACTS = [
  ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id, i) => ({ id, name: 'Customer ' + (i + 1), kind: 'customer' })),
  { id: 'v1', name: 'Landlord', kind: 'vendor' }, { id: 'v2', name: 'Lumber Co', kind: 'vendor' },
];
const PROJECTS = [{ id: 'p1', name: 'Kitchen', contactId: 'c2' }];
const L = (account, debit, credit = 0) => ({ account, debit, credit });
const ENTRIES = [
  { id: 'i1', type: 'invoice', date: '2026-01-10', ref: '1001', contactId: 'c1', cls: 'k1', lines: [L('ar', 1130), L('sales', 0, 1000), L('hst', 0, 130)] },
  { id: 'i2', type: 'invoice', date: '2026-01-15', ref: '1002', contactId: 'c2', proj: 'p1', lines: [L('ar', 565), L('svc', 0, 500), L('hst', 0, 65)] },
  { id: 'i3', type: 'invoice', date: '2026-02-01', ref: '1003', contactId: 'c3', cls: 'k2', lines: [L('ar', 339), L('sales', 0, 300), L('hst', 0, 39)] },
  { id: 's1', type: 'salesreceipt', date: '2026-02-03', ref: 'SR1', contactId: 'c4', lines: [L('bank', 226), L('sales', 0, 200), L('hst', 0, 26)] },
  { id: 's2', type: 'salesreceipt', date: '2026-02-04', contactId: 'c5', lines: [L('bank', 113), L('sales', 0, 100), L('hst', 0, 13)] },
  { id: 'b1', type: 'bill', date: '2026-01-20', contactId: 'v2', proj: 'p1', memo: 'Cabinets', lines: [L('cogs', 200), L('hst', 26), L('ap', 0, 226)] },
  { id: 'x1', type: 'expense', date: '2026-01-31', contactId: 'v1', cls: 'k1', memo: 'January rent', lines: [L('rent', 800), L('bank', 0, 800)] },
  { id: 'x2', type: 'expense', date: '2026-02-10', memo: 'Helper', lines: [L('subs', 150), L('rent', 50), L('bank', 0, 200)] },
  { id: 'p9', type: 'payment', date: '2026-02-12', contactId: 'c1', applyTo: 'i1', amount: 1130, lines: [L('bank', 1130), L('ar', 0, 1130)] },
  { id: 'old', type: 'invoice', date: '2025-12-15', contactId: 'c1', lines: [L('ar', 50), L('sales', 0, 50)] },
];
const postings = entries => { const out = []; for (const e of entries) for (const l of e.lines) out.push({ e, account: l.account, debit: l.debit, credit: l.credit, memo: '', date: e.date }); return out; };
const ctxOf = () => { const k = new Map(CONTACTS.map(c => [c.id, c.kind])), pc = new Map(PROJECTS.map(p => [p.id, p.contactId])); return { kind: id => k.get(id) || '', projCust: id => pc.get(id) || '' }; };
const TYPE = new Map(ACCTS.map(a => [a.id, a.type]));

/* ---------- the pure logic ---------- */
test('clean keeps only known kinds of filter, as sorted unique ids, and nothing set is null', () => {
  assert.equal(RF.clean(null), null);
  assert.equal(RF.clean({ cust: [], acct: 'x' }), null);
  assert.deepEqual(RF.clean({ cust: ['b', 'a', 'a', 7, ''], evil: ['x'], acct: ['r'] }), { cust: ['a', 'b'], acct: ['r'] });
  assert.equal(RF.key({ acct: ['r'], cust: ['b', 'a'] }), RF.key({ cust: ['a', 'b'], acct: ['r'] }), 'same filter, same key');
  assert.equal(RF.key(null), '');
  assert.deepEqual(RF.without({ cust: ['a'], cls: ['k'] }, 'cls'), { cust: ['a'] });
  assert.equal(RF.clean({ cust: Array.from({ length: 500 }, (_, i) => 'c' + i) }).cust.length, 200);
});

test('a customer is the name on the transaction, else its project’s customer', () => {
  const ctx = ctxOf(), e = id => ENTRIES.find(x => x.id === id);
  assert.equal(RF.custOf(e('i1'), ctx), 'c1');
  assert.equal(RF.custOf(e('b1'), ctx), 'c2', 'a bill for a project goes to the project’s customer');
  assert.equal(RF.custOf(e('x1'), ctx), '', 'a vendor isn’t a customer');
  assert.equal(RF.vendOf(e('x1'), ctx), 'v1');
  assert.equal(RF.custOf(e('x2'), ctx), '');
});

test('filters stack: customer, account, class; customers and vendors together mean either', () => {
  const ps = postings(ENTRIES), ctx = ctxOf(), ids = f => [...new Set(RF.apply(ps, f, ctx).map(p => p.e.id))].sort();
  assert.equal(RF.apply(ps, null, ctx), ps, 'no filter, the same list');
  assert.deepEqual(ids({ cust: ['c2'] }), ['b1', 'i2']);
  assert.deepEqual(ids({ cust: ['c1'], acct: ['sales'] }), ['i1', 'old']);
  assert.deepEqual(ids({ cust: ['c1'], acct: ['sales'], cls: ['k1'] }), ['i1']);
  assert.deepEqual(ids({ cls: ['__none'], acct: ['rent'] }), ['x2']);
  assert.deepEqual(ids({ vend: ['v1'], cust: ['c3'] }), ['i3', 'x1']);
  assert.deepEqual(ids({ cust: ['__none'], acct: ['rent', 'subs'] }), ['x1', 'x2']);
  assert.deepEqual(ids({ tag: ['t1'] }), [], 'no transaction has tags yet');
  assert.deepEqual(ids({ tag: ['t1'], acct: ['rent'] }), []);
  const tagged = postings([{ ...ENTRIES[6], tags: ['t1'] }]);
  assert.equal(RF.apply(tagged, { tag: ['t1'] }, ctx).length, 2, 'tags work once transactions have them');
  // Only the filtered account's lines are kept, not the whole transaction.
  assert.deepEqual(RF.apply(ps, { acct: ['rent'] }, ctx).map(p => p.account), ['rent', 'rent']);
});

test('customers are ranked by sales; the rest share Other; costs without a customer are Not specified', () => {
  const rk = RF.rankCustomers(postings(ENTRIES), { from: '2026-01-01', to: '2026-12-31', types: id => TYPE.get(id), ctx: ctxOf(), top: 3 });
  assert.deepEqual(rk.top, ['c1', 'c2', 'c3']);
  assert.deepEqual(rk.other, ['c4', 'c5']);
  assert.equal(rk.none, true);
  const rk2 = RF.rankCustomers(postings(ENTRIES.filter(e => e.contactId === 'c1')), { from: '2026-01-01', to: '2026-12-31', types: id => TYPE.get(id), ctx: ctxOf() });
  assert.deepEqual(rk2, { top: ['c1'], other: [], none: false });
});

test('profit and loss by customer adds up to the whole profit and loss, account by account', () => {
  const ps = postings(ENTRIES), ctx = ctxOf(), span = { from: '2026-01-01', to: '2026-12-31' };
  const all = RF.sums(ps, span);
  const rk = RF.rankCustomers(ps, { ...span, types: id => TYPE.get(id), ctx, top: 2 });
  const cols = [...rk.top, rk.other, '__none'].map(sel => RF.sums(ps, { ...span, test: RF.custTest(sel, ctx) }));
  for (const a of ACCTS.filter(x => ['Income', 'Expense', 'Cost of Goods Sold'].includes(x.type))) {
    assert.equal(r2(cols.reduce((s, m) => s + (m.get(a.id) || 0), 0)), r2(all.get(a.id) || 0), a.name);
  }
  // The project's bill goes to its customer; the helper (no name) to Not specified.
  assert.equal(cols[1].get('cogs'), 200);
  assert.equal(cols[3].get('subs'), 150);
});

test('transaction list: one row per transaction, its bank or A/R side, the split and the total', () => {
  const main = new Set(['bank', 'ar', 'ap']), rows = RF.txRows(postings(ENTRIES), { from: '2026-01-01', to: '2026-12-31', isMain: id => main.has(id) });
  assert.equal(rows.length, 9, 'the 2025 invoice is outside the period');
  const x2 = rows.find(r => r.e.id === 'x2');
  assert.deepEqual(x2.accounts, ['bank']);
  assert.deepEqual(x2.split.sort(), ['rent', 'subs']);
  assert.equal(x2.amount, 200);
  // With an account filter, the account shown is the filtered one and the amount its net change.
  const ps = RF.apply(postings(ENTRIES), { acct: ['rent'] }, ctxOf());
  const fr = RF.txRows(ps, { from: '2026-01-01', to: '2026-12-31', filter: { acct: ['rent'] }, isMain: id => main.has(id) });
  assert.deepEqual(fr.map(r => [r.e.id, r.accounts, r.amount]), [['x1', ['rent'], 800], ['x2', ['rent'], 50]]);
  assert.deepEqual(fr.find(r => r.e.id === 'x2').split.sort(), ['bank', 'subs']);
  // Sorting: by amount both ways, by text, ties in date order.
  const by = (col, dir) => RF.sortRows(rows, r => (col === 'amt' ? r.amount : r.e[col] || ''), dir).map(r => r.e.id);
  assert.equal(by('amt', 'desc')[0], 'i1');
  assert.equal(by('amt', 'asc')[0], 's2');
  assert.deepEqual(by('memo', 'asc').slice(-3), ['b1', 'x2', 'x1']);
  assert.deepEqual(RF.sortRows([{ date: '2026-02-01', v: 'a' }, { date: '2026-01-01', v: 'a' }], r => r.v, 'asc').map(r => r.date), ['2026-01-01', '2026-02-01']);
});

/* ---------- the Reports page code itself ---------- */
function loadReports(company = {}, top) {
  const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const ctx = {
    console, TallyRepFilter: RF, TallyCash: require('../public/cashbasis.js'),
    S: { accounts: ACCTS, entries: ENTRIES, docs: [], contacts: CONTACTS, projects: PROJECTS, company: { name: 'Test', classes: [{ id: 'k1', name: 'East' }, { id: 'k2', name: 'West' }], ...company }, rep: { tab: 'pl', period: 'custom', from: '2026-01-01', to: '2026-12-31' }, more: {} },
  };
  vm.createContext(ctx);
  vm.runInContext(`
    const r2=n=>Math.round(((+n)||0)*100+Number.EPSILON*100)/100;
    const pad=n=>String(n).padStart(2,'0'),iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()),pd=s=>new Date(s+'T12:00:00');
    const addDays=(s,n)=>{const d=pd(s);d.setDate(d.getDate()+n);return iso(d)},daysBetween=(a,b)=>Math.round((pd(b)-pd(a))/864e5),monthEnd=(y,m)=>iso(new Date(y,m,0));
    function fyStartOf(s){return s.slice(0,4)+'-01-01'}
    const TYPES=['Asset','Liability','Equity','Income','Cost of Goods Sold','Expense'];
    const isPL=t=>t==='Income'||t==='Expense'||t==='Cost of Goods Sold';
    const debitNormal=t=>t==='Asset'||t==='Expense'||t==='Cost of Goods Sold';
    let PCX=null;const postings=()=>PCX||(PCX=(()=>{const o=[];for(const e of S.entries)for(const l of e.lines)o.push({e,account:l.account,debit:+l.debit||0,credit:+l.credit||0,memo:'',date:e.date});return o})());
    const acct=id=>S.accounts.find(a=>a.id===id);const acctName=id=>(acct(id)||{}).name||'';
    const sortAccts=a=>a.slice().sort((x,y)=>TYPES.indexOf(x.type)-TYPES.indexOf(y.type)||x.name.localeCompare(y.name));
    const contactName=id=>(S.contacts.find(c=>c.id===id)||{}).name||'';
    const T=s=>s,W=s=>s,esc=s=>String(s??''),money=n=>String(n),mcell=n=>String(n),LOC=()=>'en-CA',fmtDate=d=>d;
    const clsWords=()=>({one:'Class',many:'Classes',by:'By class',none:'No class',slug:'class'});
    const clsName=id=>((S.company.classes||[]).find(c=>c.id===id)||{}).name||'';
    const rh=(t,s)=>t+' '+s;const shownCount=(k,n,p)=>Math.min(n,p||100);const moreRow=()=>'';
    const TLABEL={invoice:'Invoice',bill:'Bill',expense:'Expense',salesreceipt:'Sales receipt',payment:'Payment received'};
    const tbReport=()=>null;
    ${top ? pub('reports.js').replace(/const PL_TOP_CUSTOMERS=\d+/, 'const PL_TOP_CUSTOMERS=' + top) : pub('reports.js')}
    this.rPL=rPL;this.rTxList=rTxList;this.rSalesByCustomer=rSalesByCustomer;this.rExpensesByVendor=rExpensesByVendor;this.repFilter=repFilter;this.rix=rix;`, ctx);
  return ctx;
}
const J = x => JSON.parse(JSON.stringify(x));
const plRow = (r, label) => J(r.rows.find(x => x.label === label));

test('the P&L by customer has a column per top customer, and its Total column is the unfiltered P&L', () => {
  const c = loadReports();
  const plain = c.rPL();
  c.S.rep.compare = 'bycustomer';
  const by = c.rPL();
  assert.match(by.title, /By customer/);
  assert.deepEqual(J(by.head), ['Customer 1', 'Customer 2', 'Customer 3', 'Customer 4', 'Customer 5', 'Not specified', 'Total']);
  for (const label of ['Sales', 'Services', 'Materials', 'Rent', 'Subcontractors', 'Total income', 'Gross profit', 'Net income']) {
    const p = plRow(plain, label), b = plRow(by, label);
    assert.ok(p && b, label);
    assert.equal(b.cells[b.cells.length - 1], p.cells[0], `${label}: Total column = the P&L`);
  }
  assert.deepEqual(plRow(by, 'Net income').cells, [1000, 300, 300, 200, 100, -1000, 900]);
});

test('more customers than columns: the rest share Other customers, and totals still agree', () => {
  const c = loadReports({}, 2);
  const plain = c.rPL();
  c.S.rep.compare = 'bycustomer';
  const by = c.rPL();
  assert.deepEqual(J(by.head), ['Customer 1', 'Customer 2', 'Other customers (3)', 'Not specified', 'Total']);
  assert.deepEqual(plRow(by, 'Net income').cells, [1000, 300, 600, -1000, 900]);
  for (const label of ['Sales', 'Rent', 'Net income']) assert.equal(plRow(by, label).cells.at(-1), plRow(plain, label).cells[0], label);
});

test('filters stack with the class choice, the comparison and the cash basis', () => {
  const c = loadReports();
  c.S.rep.flt = { cust: ['c1'] };
  assert.deepEqual(plRow(c.rPL(), 'Total income').cells, [1000], 'Customer 1 in 2026');
  c.S.rep.cls = 'k1';
  assert.deepEqual(plRow(c.rPL(), 'Total income').cells, [1000]);
  c.S.rep.cls = 'k2';
  assert.equal(plRow(c.rPL(), 'Total income').cells[0], 0);
  c.S.rep.cls = ''; c.S.rep.flt = { acct: ['rent'] };
  assert.deepEqual(plRow(c.rPL(), 'Net income').cells, [-850]);
  c.S.rep.compare = 'months';
  assert.deepEqual(plRow(c.rPL(), 'Net income').cells.slice(0, 2), [-800, -50]);
  // Cash basis: the unpaid invoices' income drops out, Customer 1's paid invoice stays (paid Feb 12).
  c.S.rep.compare = ''; c.S.rep.basis = 'cash'; c.S.rep.flt = { cust: ['c1', 'c2'] };
  c.S.docs = [{ id: 'i1', kind: 'invoice', date: '2026-01-10', total: 1130 }, { id: 'i2', kind: 'invoice', date: '2026-01-15', total: 565 }];
  c.S.entries = ENTRIES.map(e => (e.id === 'i1' || e.id === 'i2' ? { ...e, docId: e.id } : e));
  vm.runInContext('PCX=null', c);
  assert.deepEqual(plRow(c.rPL(), 'Total income').cells, [1000]);
  // A P&L by class ignores a class filter (it has a column for each class).
  const d = loadReports();
  d.S.rep.flt = { cls: ['k1'] }; d.S.rep.compare = 'byclass';
  assert.equal(d.repFilter(), null);
  d.S.rep.compare = '';
  assert.deepEqual(J(d.repFilter()), { cls: ['k1'] });
  assert.deepEqual(plRow(d.rPL(), 'Total income').cells, [1000]);
});

test('sales by customer, expenses by vendor and the transaction list follow the filter', () => {
  const c = loadReports();
  c.S.rep.tab = 'sc'; c.S.rep.flt = { cls: ['k2'] };
  assert.deepEqual(J(c.rSalesByCustomer().csv).slice(1).map(r => [r[0], r[2]]), [['Customer 3', 300], ['Total', 300]]);
  c.S.rep.tab = 'ev'; c.S.rep.flt = { acct: ['rent'] };
  assert.deepEqual(J(c.rExpensesByVendor().csv).slice(1).map(r => [r[0], r[2]]), [['Landlord', 800], ['No vendor', 50], ['Total', 850]]);
  c.S.rep.tab = 'tl'; c.S.rep.flt = null;
  let t = J(c.rTxList());
  assert.deepEqual(t.csv[0], ['Date', 'Type', 'No.', 'Name', 'Memo', 'Account', 'Other accounts', 'Class', 'Amount']);
  assert.equal(t.csv.length, 11, 'heading, 9 transactions, total');
  const x2 = t.csv.find(r => r[4] === 'Helper');
  assert.deepEqual([x2[5], x2[6], x2[8]], ['Chequing', 'Subcontractors, Rent', 200]);
  c.S.rep.tlSort = { col: 'amt', dir: 'desc' };
  t = J(c.rTxList());
  assert.equal(t.csv[1][8], 1130);
  c.S.rep.flt = { vend: ['v1', 'v2'] };
  t = J(c.rTxList());
  assert.deepEqual(t.csv.slice(1, -1).map(r => r[3]).sort(), ['Landlord', 'Lumber Co']);
  assert.match(t.sub, /Filtered/);
});

/* ---------- saved reports keep the filters ---------- */
let server, base, dir, co, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-rf-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Filter Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('saved reports keep filters, the P&L by customer, the transaction list and its sort; junk is dropped', async () => {
  const c0 = (await call('GET', '/api/c/state')).json.company;
  const r = await call('PUT', '/api/c/settings', { ...c0, savedReports: [
    { id: 'r1', name: 'Rent by vendor', tab: 'ev', period: 'fy', flt: { acct: ['a1'], vend: ['v1', 'v1', 'v2'], bogus: ['x'] } },
    { id: 'r2', name: 'P&L by customer', tab: 'pl', period: 'ytd', compare: 'bycustomer' },
    { id: 'r3', name: 'Big ones', tab: 'tl', period: 'fy', sort: { col: 'amt', dir: 'desc' }, flt: { cust: ['__none'] } },
    { id: 'r4', name: 'Junk', tab: 'tl', period: 'fy', sort: { col: '<script>', dir: 'up' }, flt: { cust: 'c1', acct: [{}], tag: ['x'.repeat(200)] } },
  ] });
  assert.equal(r.status, 200);
  const saved = (await call('GET', '/api/c/state')).json.company.savedReports;
  assert.deepEqual(saved[0].flt, { acct: ['a1'], vend: ['v1', 'v2'] });
  assert.equal(saved[1].compare, 'bycustomer');
  assert.equal(saved[2].tab, 'tl');
  assert.deepEqual(saved[2].sort, { col: 'amt', dir: 'desc' });
  assert.deepEqual(saved[2].flt, { cust: ['__none'] });
  assert.equal(saved[3].flt, undefined);
  assert.equal(saved[3].sort, undefined);
});
