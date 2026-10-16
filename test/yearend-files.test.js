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
  assert.equal((await req(owner, 'PUT', c('/records/engagements/y1'), { ...y, status: 'progress' })).status, 400, 'reopening needs a reason');
  assert.equal((await req(owner, 'PUT', c('/records/engagements/y1'), { ...y, status: 'progress', unlockReason: 'Late invoice' })).status, 200, 'but it can be reopened');
  y = (await req(owner, 'GET', c('/state'))).json.engagements.find(x => x.id === 'y1');
  assert.equal(y.unlocks.length, 1); assert.equal(y.unlocks[0].reason, 'Late invoice'); assert.equal(y.unlocks[0].by, 'Sher');
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

/* ---------- the review layer ---------- */
async function staffMember(name, username) {
  const r = await req(owner, 'POST', '/api/users', { name, username, password: 'temporary pass 123', role: 'staff' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'temporary pass 123' }) });
  const ck = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await req(ck, 'POST', '/api/auth/password', { current: 'temporary pass 123', password: name + ' picks a long phrase' })).status, 200);
  return { id: r.json.user.id, cookie: ck };
}
const getY = async id => (await req(owner, 'GET', c('/state'))).json.engagements.find(x => x.id === id);

test('review: sign-offs carry who and when from the server, and only an owner or the reviewer can finalize', async () => {
  const { rev, closingDate, closingPassword, hasCode, ...co0 } = (await req(owner, 'GET', c('/state'))).json.company;
  await req(owner, 'PUT', c('/settings'), { ...co0, features: { ...(co0.features || {}), yearEndFiles: true } });
  const sam = await staffMember('Sam Staff', 'sam@example.com');
  const team = (await req(sam.cookie, 'GET', c('/state'))).json.team;
  assert.ok(team.some(u => u.id === sam.id) && !team.some(u => u.role === 'client'), 'the team list is the firm’s staff');
  // Sam prepares; a forged sign-off in someone else's name is replaced with Sam's own.
  let r = await req(sam.cookie, 'PUT', c('/records/engagements/r1'), file({ yearEnd: '2023-12-31', team: { preparer: { id: sam.id, name: 'Sam Staff' } },
    wps: { A: { status: 'progress', notes: 'Agreed to bank statement', prepared: { by: 'Owner', id: 'someone', at: 5 } } },
    ajes: [{ id: 'j1', num: 1, memo: 'Accrual', lines: [{ account: rent, debit: 50 }, { account: bank, credit: 50 }], reviewedBy: { by: 'Owner', at: 5 } }] }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let y = await getY('r1');
  assert.equal(y.wps.A.prepared.by, 'Sam Staff'); assert.ok(y.wps.A.prepared.at > 5);
  assert.equal(y.ajes[0].preparedBy.by, 'Sam Staff'); assert.equal(y.ajes[0].reviewedBy, null, 'a new entry starts as a draft');
  // Reviewing the AJE, then changing it, undoes the review.
  await req(owner, 'PUT', c('/records/engagements/r1'), { ...y, ajes: [{ ...y.ajes[0], reviewedBy: { at: 1 } }] });
  y = await getY('r1'); assert.equal(y.ajes[0].reviewedBy.by, 'Sher');
  await req(sam.cookie, 'PUT', c('/records/engagements/r1'), { ...y, ajes: [{ ...y.ajes[0], lines: [{ account: rent, debit: 60 }, { account: bank, credit: 60 }] }] });
  y = await getY('r1'); assert.equal(y.ajes[0].reviewedBy, null);
  // Sam can't sign the file off as reviewed or make it final; an open review note blocks the owner.
  assert.equal((await req(sam.cookie, 'PUT', c('/records/engagements/r1'), { ...y, signoffs: { reviewed: { at: 1 } } })).status, 403);
  assert.equal((await req(sam.cookie, 'PUT', c('/records/engagements/r1'), { ...y, status: 'final' })).status, 403);
  await req(owner, 'PUT', c('/records/engagements/r1'), { ...y, reviewNotes: [{ id: 'n1', num: 1, wp: 'A', text: 'Get the December statement', assignee: sam.id, assigneeName: 'Sam Staff', priority: 'high', status: 'open' }] });
  y = await getY('r1'); assert.equal(y.reviewNotes[0].created.by, 'Sher');
  r = await req(owner, 'PUT', c('/records/engagements/r1'), { ...y, status: 'final' });
  assert.equal(r.status, 409); assert.match(r.json.error, /open review notes/);
  await req(sam.cookie, 'PUT', c('/records/engagements/r1'), { ...y, reviewNotes: [{ ...y.reviewNotes[0], status: 'resolved', resolution: 'Attached' }] });
  y = await getY('r1'); assert.equal(y.reviewNotes[0].resolved.by, 'Sam Staff');
  // Made the reviewer, Sam can finalize.
  await req(owner, 'PUT', c('/records/engagements/r1'), { ...y, team: { ...y.team, reviewer: { id: sam.id, name: 'Sam Staff' } } });
  y = await getY('r1');
  assert.equal((await req(sam.cookie, 'PUT', c('/records/engagements/r1'), { ...y, status: 'final' })).status, 200);
  y = await getY('r1'); assert.equal(y.finalBy, 'Sam Staff');
  // The activity log says what happened in words.
  const log = (await req(owner, 'GET', c('/audit?collection=engagements'))).json.rows.map(x => x.summary).join(' | ');
  for (const words of ['AJE 1 created', 'AJE 1 reviewed', 'AJE 1 changed', 'working paper Cash prepared', 'review note 1 added', 'review note 1 resolved', 'made final']) assert.ok(log.includes(words), `${words} in: ${log}`);
});

test('review: documents on working papers are for staff only, Office files are accepted, and a final file keeps them', async () => {
  const pdf = Buffer.from('%PDF-1.4\n% test\n').toString('base64');
  const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40), Buffer.from('[Content_Types].xml word/document.xml')]).toString('base64');
  let y = await getY('y1');
  let r = await req(owner, 'POST', c('/attachments'), { target: 'engagements', targetId: 'y1', wp: 'A', fileName: 'bank.pdf', data: pdf });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req(owner, 'POST', c('/attachments'), { target: 'engagements', targetId: 'y1', wp: 'C', fileName: 'ar-listing.docx', data: docx });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await req(owner, 'POST', c('/attachments'), { target: 'engagements', targetId: 'y1', wp: 'A', fileName: 'x.exe', data: Buffer.from('MZ.....').toString('base64') })).status, 400);
  assert.equal((await req(client, 'POST', c('/attachments'), { target: 'engagements', targetId: 'y1', wp: 'A', fileName: 'b.pdf', data: pdf })).status, 403);
  const staff = (await req(owner, 'GET', c('/state'))).json.attachments.filter(a => a.target === 'engagements');
  assert.deepEqual(staff.map(a => a.wp).sort(), ['A', 'C']);
  assert.deepEqual((await req(client, 'GET', c('/state'))).json.attachments.filter(a => a.target === 'engagements'), [], 'clients never get them');
  const fileId = staff[0].fileId;
  assert.equal((await fetch(base + c(`/files/${fileId}`), { headers: { cookie: client } })).status, 404);
  assert.equal((await fetch(base + c(`/files/${fileId}`), { headers: { cookie: owner } })).status, 200);
  // Final: documents can't be removed; deleting a (reopened) file takes them with it.
  y = await getY('y1');
  assert.equal((await req(owner, 'PUT', c('/records/engagements/y1'), { ...y, status: 'final' })).status, 200);
  assert.equal((await req(owner, 'DELETE', c(`/records/attachments/${staff[0].id}`))).status, 409);
  y = await getY('y1');
  await req(owner, 'PUT', c('/records/engagements/y1'), { ...y, status: 'progress', unlockReason: 'Tidy up' });
  assert.equal((await req(owner, 'DELETE', c('/records/engagements/y1'))).status, 200);
  assert.equal((await req(owner, 'GET', c('/state'))).json.attachments.filter(a => a.target === 'engagements' && a.targetId === 'y1').length, 0);
});

test('review: the checklist and progress follow the file', () => {
  const f = { id: 'f', snapshot: { lines: [{ account: 'bank', name: 'Chequing', type: 'Asset', detail: 'bank', cur: 100, prior: 0 }, { account: 'sales', name: 'Sales', type: 'Income', cur: -100, prior: 0 }] } };
  let p = E.progress(f, [], []);
  assert.equal(p.unreviewed, 5, 'Cash, Revenue and the three standing sections'); assert.equal(p.noDocs, 1); assert.ok(p.pct < 30);
  const signed = { prepared: { by: 'S', at: 1 }, reviewed: { by: 'S', at: 1 } };
  f.wps = Object.fromEntries(['GEN', 'A', 'R', 'RP', 'SUB'].map(k => [k, signed]));
  f.checklist = Object.fromEntries(E.CHECKLIST.flatMap(g => g.items).filter(i => !i.auto).map(([k]) => [k, { by: 'S', at: 1 }]));
  f.signoffs = signed; f.report = { date: '2026-01-31' };
  p = E.progress(f, [], [{ target: 'engagements', targetId: 'f', wp: 'A' }]);
  assert.deepEqual([p.pct, p.unreviewed, p.noDocs, p.openNotes], [100, 0, 0, 0]);
  f.reviewNotes = [{ status: 'open' }];
  assert.equal(E.progress(f, [], []).openNotes, 1);
});

test('review: bringing in a changed trial balance takes back the review of the working papers it touches, in the log', async () => {
  let y = await getY('r1');
  await req(owner, 'PUT', c('/records/engagements/r1'), { ...y, status: 'progress', unlockReason: 'Books changed' });
  y = await getY('r1');
  await req(owner, 'PUT', c('/records/engagements/r1'), { ...y, wps: { ...y.wps, A: { ...y.wps.A, reviewed: { at: 1 } } } });
  y = await getY('r1'); assert.equal(y.wps.A.reviewed.by, 'Sher');
  const lines = y.snapshot.lines.map(l => (l.account === bank ? { ...l, cur: 1200 } : l.account === sales ? { ...l, cur: -1200 } : l));
  assert.equal((await req(owner, 'PUT', c('/records/engagements/r1'), { ...y, snapshot: { ...y.snapshot, lines }, wps: { ...y.wps, A: { ...y.wps.A, reviewed: null, status: 'progress' } } })).status, 200);
  y = await getY('r1'); assert.equal(y.wps.A.reviewed, null);
  const log = (await req(owner, 'GET', c('/audit?collection=engagements'))).json.rows[0].summary;
  assert.match(log, /trial balance updated from the books \(.*\$1000\.00 → \$1200\.00/); assert.match(log, /working paper Cash review removed/);
});

/* ---------- roll forward, imported trial balances, templates, cash flow, analysis ---------- */
test('roll forward: the prior year is checked against last year’s final figures, and can be taken from them', () => {
  const last = { snapshot: { lines: [{ account: 'bank', name: 'Chequing', type: 'Asset', cur: 1000, prior: 0 }, { account: 'sales', name: 'Sales', type: 'Income', cur: -1000, prior: 0 }] },
    ajes: [{ lines: [{ account: 'rent', debit: 100 }, { account: 'bank', credit: 100 }] }] };
  const accts = [{ id: 'rent', name: 'Rent', type: 'Expense' }];
  const now = { snapshot: { lines: [{ account: 'bank', name: 'Chequing', type: 'Asset', cur: 1500, prior: 1000 }, { account: 'sales', name: 'Sales', type: 'Income', cur: -500, prior: -1000 }, { account: E.RE_OPEN, name: 'RE', type: 'Equity', cur: -1000, prior: 0 }] } };
  // Last year's AJE never reached the books: Chequing and Rent differ.
  assert.deepEqual(E.priorCheck(now, last, accts).map(x => x.account).sort(), ['bank', 'rent']);
  const lines = E.withPriorFrom(now.snapshot.lines, last, accts);
  assert.equal(lines.find(l => l.account === 'bank').prior, 900);
  assert.equal(lines.find(l => l.account === 'rent').prior, 100, 'an account only last year had is added');
  assert.equal(Math.round(lines.reduce((t, l) => t + l.prior, 0) * 100), 0, 'still balances');
  assert.deepEqual(E.priorCheck({ snapshot: { lines } }, last, accts), []);
});

test('report wording comes from one place, by engagement type and date', () => {
  const R = require('../public/report-templates.js');
  assert.equal(R.current('compilation', '2025-12-31').id, 'compilation-v1');
  assert.equal(R.current('internal', '2025-12-31').title, 'Notice to the reader');
  const t = R.render(R.current('compilation', '2025-12-31'), { entity: 'Maple Dental', statements: 'the balance sheet of Maple Dental as at Dec 31, 2025' });
  assert.match(t, /^To the management of Maple Dental/); assert.match(t, /CSRS\) 4200/); assert.ok(!/\{/.test(t));
});

test('cash flow and capital assets continuity add up', () => {
  const f = { snapshot: { lines: [
    { account: 'bank', name: 'Chequing', type: 'Asset', detail: 'bank', cur: 5000, prior: 3000 }, { account: 'ar', name: 'Accounts receivable', type: 'Asset', detail: 'ar', cur: 2000, prior: 1000 },
    { account: 'eq', name: 'Equipment', type: 'Asset', detail: 'capital', cur: 3000, prior: 1000 }, { account: 'acc', name: 'Accumulated amortization', type: 'Asset', cur: -500, prior: -200 },
    { account: 'ap', name: 'Accounts payable', type: 'Liability', detail: 'ap', cur: -1500, prior: -500 }, { account: 'loan', name: 'Bank loan', type: 'Liability', cur: -2000, prior: -1000 },
    { account: 'sh', name: 'Common shares', type: 'Equity', cur: -100, prior: -100 }, { account: E.RE_OPEN, name: 'RE', type: 'Equity', cur: -3200, prior: 0 },
    { account: 'sales', name: 'Sales', type: 'Income', cur: -10000, prior: -8000 }, { account: 'am', name: 'Amortization', type: 'Expense', cur: 300, prior: 200 }, { account: 'rent', name: 'Rent', type: 'Expense', cur: 7000, prior: 4600 }] } };
  const cf = E.cashFlow(f, []);
  assert.deepEqual([cf.operating, cf.inv, cf.fin, cf.change, cf.begin, cf.end, cf.gap], [3000, -2000, 1000, 2000, 3000, 5000, 0]);
  const c = E.continuity(f, [], { eq: { debits: 2500, credits: 500 } });
  assert.deepEqual(c.totals.cost, { open: 1000, up: 2500, down: 500, other: 0, close: 3000 });
  assert.deepEqual(c.totals.accum, { open: 200, up: 300, down: 0, other: 0, close: 500 });
  assert.deepEqual(c.totals.nbv, { open: 800, close: 2500 });
});

test('analysis points out changes, odd balances, missing documents and possible duplicates', () => {
  const f = { id: 'f', snapshot: { lines: [{ account: 'bank', name: 'Chequing', type: 'Asset', detail: 'bank', cur: 5000, prior: 3000 }, { account: 'eq', name: 'Equipment', type: 'Asset', detail: 'capital', cur: 40000, prior: 1500 }, { account: 'ap', name: 'Accounts payable', type: 'Liability', cur: 500, prior: -500 }, { account: 'sales', name: 'Sales', type: 'Income', cur: -45500, prior: -4000 }] } };
  const a = E.analyze(f, [], [{ target: 'engagements', targetId: 'f', wp: 'A' }]);
  const has = (kind, re) => a.some(x => x.kind === kind && re.test(x.text));
  assert.ok(has('variance', /Revenue increased 1037\.5%/));
  assert.ok(has('sign', /Accounts payable has a debit balance/));
  assert.ok(has('docs', /Capital asset additions of \$38,500\.00 have no supporting document/));
  assert.ok(!has('docs', /^Cash/), 'Cash has its bank statement');
  const u = E.unusual([{ entryId: 'a', date: '2026-01-02', account: 'r', name: 'Rent', amount: 100 }, { entryId: 'b', date: '2026-01-02', account: 'r', name: 'Rent', amount: 100 }], '2026-01-01', '2026-12-31');
  assert.equal(u[0].kind, 'duplicate');
});

test('server: an imported trial balance can use the file’s own accounts and be out of balance until it’s final', async () => {
  const lines = [{ account: 'x:1000', code: '1000', name: 'Bank', type: 'Asset', cur: 500, prior: 0 }, { account: 'x:4000', code: '4000', name: 'Sales', type: 'Income', cur: -400, prior: 0 }];
  let r = await req(owner, 'PUT', c('/records/engagements/i1'), file({ yearEnd: '2022-12-31', snapshot: { source: 'import', lines } }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req(owner, 'PUT', c('/records/engagements/i1'), file({ yearEnd: '2022-12-31', snapshot: { source: 'import', lines }, ajes: [{ id: 'j', num: 1, memo: 'x', lines: [{ account: 'x:4000', debit: 10 }, { account: 'x:1000', credit: 10 }] }] }));
  assert.equal(r.status, 200, 'adjusting entries can use the file’s own accounts');
  const y = await getY('i1');
  r = await req(owner, 'PUT', c('/records/engagements/i1'), { ...y, status: 'final' });
  assert.equal(r.status, 400); assert.match(r.json.error, /doesn’t add up to zero \(off by 100\.00\)/);
  // From the books, the file's own accounts aren't allowed.
  assert.equal((await req(owner, 'PUT', c('/records/engagements/i2'), file({ yearEnd: '2021-12-31', snapshot: { lines } }))).status, 400);
});
