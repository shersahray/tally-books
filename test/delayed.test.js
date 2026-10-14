'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// Delayed charges and credits (delayed-calc.js and the server), and tags and line classes on recurring templates and
// estimates: what they pass to the transactions made from them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DL = require('../public/delayed-calc.js');
const R = require('../public/recurring-calc.js');
const ROLES = require('../public/roles.js');
const TAGS = require('../public/tags.js');
const { createApp } = require('../src/server/app');

/* ---------- the rules ---------- */
const charge = { id: 'd1', kind: 'charge', contactId: 'c1', date: '2026-09-02', lines: [{ desc: 'Site visit', account: 'a4000', qty: 2, rate: 75, taxCode: 'std' }, { item: 'i1', desc: 'Parts', account: 'a4000', qty: 1, rate: 30.5, taxCode: 'std', cls: 'k2' }], cls: 'k1', status: 'open', invoiceId: '' };
const credit = { id: 'd2', kind: 'credit', contactId: 'c1', date: '2026-09-01', lines: [{ desc: 'Goodwill', account: 'a4000', qty: 1, rate: 20, taxCode: 'std' }], status: 'open', invoiceId: '' };

test('amounts, what a customer can add, and the invoice lines (a credit is negative)', () => {
  assert.equal(DL.total(charge), 180.5);
  assert.equal(DL.total(credit), 20);
  const other = { ...charge, id: 'd3', contactId: 'c2' }, used = { ...charge, id: 'd4', invoiceId: 'inv9' };
  const docs = [{ id: 'inv9' }];
  assert.deepEqual(DL.forInvoice([charge, credit, other, used], docs, 'c1').map(r => r.id), ['d2', 'd1'], 'open ones, oldest first');
  assert.deepEqual(DL.forInvoice([charge, used], docs, 'c1', 'inv9').map(r => r.id), ['d1', 'd4'], 'and those on this invoice when editing it');
  assert.equal(DL.isOpen(used, []), true, 'its invoice is gone');
  assert.deepEqual(DL.invoiceLines(charge), [
    { desc: 'Site visit', account: 'a4000', qty: 2, rate: 75, taxCode: 'std', cls: 'k1', dl: 'd1' },
    { item: 'i1', desc: 'Parts', account: 'a4000', qty: 1, rate: 30.5, taxCode: 'std', cls: 'k2', dl: 'd1' }]);
  assert.deepEqual(DL.invoiceLines(credit), [{ desc: 'Goodwill', account: 'a4000', qty: -1, rate: 20, taxCode: 'std', dl: 'd2' }]);
});

test('linking follows the invoice’s lines: added ones close, removed ones open again, a deleted invoice opens all', () => {
  const list = [charge, credit, { ...charge, id: 'd5', status: 'closed', invoiceId: 'inv1' }];
  let u = DL.sync(list, 'inv1', { kind: 'invoice', lines: [{ dl: 'd1' }, { dl: 'd2' }, { desc: 'x' }] });
  assert.deepEqual(u.map(x => [x.id, x.data.status, x.data.invoiceId]), [['d1', 'closed', 'inv1'], ['d2', 'closed', 'inv1'], ['d5', 'open', '']]);
  assert.ok(!('id' in u[0].data));
  u = DL.sync([{ ...charge, status: 'closed', invoiceId: 'inv1' }], 'inv1', null);
  assert.deepEqual(u.map(x => [x.id, x.data.status, x.data.invoiceId]), [['d1', 'open', '']]);
  assert.deepEqual(DL.sync([charge], 'b1', { kind: 'bill', lines: [{ dl: 'd1' }] }), [], 'only invoices');
});

test('recurring templates carry their class and the tags the company still has', () => {
  assert.deepEqual(R.carry({ cls: 'k1', tags: ['t1', 'gone'] }, ['t1']), { cls: 'k1', tags: ['t1'] });
  assert.deepEqual(R.carry({}, []), {});
  assert.deepEqual(R.journalLines([{ account: 'a', debit: 5, cls: 'k1' }, { account: 'b', credit: 5 }]), [{ account: 'a', debit: 5, credit: 0, memo: '', cls: 'k1' }, { account: 'b', debit: 0, credit: 5, memo: '' }]);
});

test('roles and tags: delayed charges are Sales; a tag on one counts as used', () => {
  assert.equal(ROLES.recordArea('delayed', charge), 'sales');
  assert.equal(TAGS.usage({ delayed: [{ tags: ['t1'] }], estimates: [{ tags: ['t1'] }], recurring: [{ tags: ['t1'] }] }, 't1'), 3);
  assert.deepEqual(['inventory', 'sreceipts', 'credits', 'vcredits'].map(k => ROLES.IMPORT_AREA[k]), ['sales', 'sales', 'sales', 'expenses']);
});

/* ---------- the server ---------- */
let server, base, dir, co, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-delayed-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Delayed Co', province: 'ON' })).json.company.id;
  await call('PUT', '/api/c/records/contacts/c1', { name: 'Ana', kind: 'customer' });
  await call('PUT', '/api/c/records/contacts/c2', { name: 'Ben', kind: 'customer' });
  await call('PUT', '/api/c/records/contacts/v1', { name: 'Landlord', kind: 'vendor' });
  const st = (await call('GET', '/api/c/state')).json;
  assert.equal((await call('PUT', '/api/c/settings', { ...st.company, tags: [{ id: 't1', name: 'Trade show', group: '' }], classes: [{ id: 'k1', name: 'Ottawa', active: true }, { id: 'k2', name: 'Toronto', active: true }] })).status, 200);
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const state = async () => (await call('GET', '/api/c/state')).json;
const strip = r => { const c = { ...r }; delete c.id; return c; };
const invoice = (lines, total) => ({ kind: 'invoice', number: '2001', date: '2026-09-10', due: '2026-10-10', contactId: 'c1', lines, sub: total, tax: 0, total });
const posting = (id, total) => ({ type: 'invoice', date: '2026-09-10', docId: id, lines: [{ account: 'a1200', debit: total, credit: 0 }, { account: 'a4000', debit: 0, credit: total }] });

test('API: delayed charges are checked, kept off the ledger, and closed by the invoice they go on', async () => {
  const dc = { kind: 'charge', date: '2026-09-02', contactId: 'c1', number: 'DC-1', lines: [{ desc: 'Site visit', account: 'a4000', qty: 2, rate: 75, taxCode: 'none', cls: 'k1' }], tags: ['t1'], status: 'closed', invoiceId: 'made-up' };
  let r = await call('PUT', '/api/c/records/delayed/dc1', dc);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const dcr = { kind: 'credit', date: '2026-09-03', contactId: 'c1', lines: [{ desc: 'Goodwill', account: 'a4000', qty: 1, rate: 20, taxCode: 'none' }] };
  assert.equal((await call('PUT', '/api/c/records/delayed/dc2', dcr)).status, 200);
  for (const [bad, why] of [[{ kind: 'other' }, 'kind'], [{ contactId: 'v1' }, 'a vendor'], [{ contactId: 'nope' }, 'no customer'], [{ lines: [] }, 'no lines'],
    [{ lines: [{ account: 'a6000', qty: 1, rate: 5 }] }, 'not an income account'], [{ lines: [{ account: 'a4000', qty: 1, rate: 0 }] }, 'nothing'], [{ date: '2026-02-30x' }, 'date'],
    [{ tags: ['nope'] }, 'unknown tag'], [{ lines: [{ account: 'a4000', qty: 1, rate: 5, cls: 'nope' }] }, 'unknown class'], [{ cls: 'nope' }, 'unknown class at the top']]) {
    assert.equal((await call('PUT', '/api/c/records/delayed/bad', { ...dc, ...bad })).status, 400, why);
  }
  let st = await state();
  let x = st.delayed.find(d => d.id === 'dc1');
  assert.deepEqual([x.status, x.invoiceId, x.amount, x.tags, x.lines[0].cls], ['open', '', 150, ['t1'], 'k1'], 'a link can’t be made up; it’s open');
  assert.equal(st.entries.length, 0, 'not in the books');
  assert.equal((await call('DELETE', '/api/c/records/contacts/c1')).status, 409, 'its customer stays');
  // Ben's invoice can't take Ana's charge.
  r = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'docs', id: 'ib', data: { ...invoice([{ desc: 'x', account: 'a4000', qty: 2, rate: 75, taxCode: 'none', dl: 'dc1' }], 150), contactId: 'c2' } }] });
  assert.equal(r.status, 400);
  // Ana's invoice with both: they close and point at it.
  const lines = [{ desc: 'Site visit', account: 'a4000', qty: 2, rate: 75, taxCode: 'none', cls: 'k1', dl: 'dc1' }, { desc: 'Goodwill', account: 'a4000', qty: -1, rate: 20, taxCode: 'none', dl: 'dc2' }];
  r = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'docs', id: 'i1', data: invoice(lines, 130) }, { op: 'set', collection: 'entries', id: 'd_i1', data: posting('i1', 130) }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  st = await state();
  assert.deepEqual(st.delayed.map(d => [d.id, d.status, d.invoiceId]).sort(), [['dc1', 'closed', 'i1'], ['dc2', 'closed', 'i1']]);
  assert.deepEqual(st.docs.find(d => d.id === 'i1').lines.map(l => l.dl), ['dc1', 'dc2']);
  // While it's on the invoice: no deleting it, no moving it to another customer, no second invoice.
  assert.equal((await call('DELETE', '/api/c/records/delayed/dc1')).status, 409);
  assert.equal((await call('PUT', '/api/c/records/delayed/dc1', { ...strip(st.delayed.find(d => d.id === 'dc1')), contactId: 'c2' })).status, 409);
  r = await call('PUT', '/api/c/records/docs/i2', { ...invoice([{ desc: 'again', account: 'a4000', qty: 2, rate: 75, taxCode: 'none', dl: 'dc1' }], 150), number: '2002' });
  assert.equal(r.status, 409);
  // A plain save keeps the link.
  assert.equal((await call('PUT', '/api/c/records/delayed/dc1', { ...strip(st.delayed.find(d => d.id === 'dc1')), memo: 'note' })).status, 200);
  assert.equal((await state()).delayed.find(d => d.id === 'dc1').invoiceId, 'i1');
  // Taking the credit off the invoice opens it again.
  r = await call('PUT', '/api/c/records/docs/i1', invoice([lines[0]], 150));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  st = await state();
  assert.deepEqual(st.delayed.map(d => [d.id, d.status, d.invoiceId]).sort(), [['dc1', 'closed', 'i1'], ['dc2', 'open', '']]);
  // Deleting the invoice opens the charge again.
  assert.equal((await call('POST', '/api/c/batch', { writes: [{ op: 'delete', collection: 'entries', id: 'd_i1' }, { op: 'delete', collection: 'docs', id: 'i1' }] })).status, 200);
  st = await state();
  assert.deepEqual(st.delayed.map(d => [d.id, d.status, d.invoiceId]).sort(), [['dc1', 'open', ''], ['dc2', 'open', '']]);
  // A tag on a delayed charge can't just vanish from the list.
  const c = st.company;
  assert.equal((await call('PUT', '/api/c/settings', { ...c, tags: [] })).status, 409);
  // The audit log names it.
  const audit = (await call('GET', '/api/c/audit?collection=delayed')).json;
  assert.ok(audit.rows.some(a => /^delayedcharge #DC-1 2026-09-02 \$150\.00/.test(a.summary)), JSON.stringify(audit.rows.map(a => a.summary)));
});

test('API: a backup restores delayed charges still linked to their invoice', async () => {
  const lines = [{ desc: 'Site visit', account: 'a4000', qty: 2, rate: 75, taxCode: 'none', dl: 'dc1' }];
  assert.equal((await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'docs', id: 'i3', data: invoice(lines, 150) }, { op: 'set', collection: 'entries', id: 'd_i3', data: posting('i3', 150) }] })).status, 200);
  const res = await fetch(base + `/api/c/${co}/backup`, { headers: { cookie } });
  const backup = await res.json();
  assert.ok(backup.delayed.length >= 2);
  const r = await call('POST', '/api/c/restore', backup);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const st = await state();
  assert.deepEqual(['dc1', 'dc2'].map(id => { const d = st.delayed.find(x => x.id === id); return [d.status, d.invoiceId]; }), [['closed', 'i3'], ['open', '']]);
});

test('API: recurring templates and estimates keep a class, line classes and tags', async () => {
  const rec = { kind: 'invoice', name: 'Retainer', contactId: 'c1', every: 'month', n: 1, next: '2026-10-01', end: '', mode: 'auto', cls: 'k1', tags: ['t1'],
    lines: [{ desc: 'Retainer', account: 'a4000', qty: 1, rate: 500, taxCode: 'std', cls: 'k2' }] };
  let r = await call('PUT', '/api/c/records/recurring/r1', rec);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let st = await state();
  const saved = st.recurring.find(x => x.id === 'r1');
  assert.deepEqual([saved.cls, saved.tags, saved.lines[0].cls], ['k1', ['t1'], 'k2']);
  assert.equal((await call('PUT', '/api/c/records/recurring/r2', { ...rec, tags: ['nope'] })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/recurring/r2', { ...rec, cls: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/recurring/r2', { ...rec, lines: [{ ...rec.lines[0], cls: 'nope' }] })).status, 400);
  const jr = { kind: 'journal', name: 'Accrual', every: 'month', n: 1, next: '2026-10-31', mode: 'auto', tags: ['t1'], lines: [{ account: 'a6000', debit: 10, credit: 0, cls: 'k1' }, { account: 'a1000', debit: 0, credit: 10 }] };
  r = await call('PUT', '/api/c/records/recurring/r3', jr);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  st = await state();
  assert.deepEqual(st.recurring.find(x => x.id === 'r3').lines.map(l => l.cls), ['k1', undefined]);
  // Estimates
  const est = { number: 'E-1', date: '2026-09-01', contactId: 'c1', cls: 'k2', tags: ['t1'], lines: [{ desc: 'Job', account: 'a4000', qty: 1, rate: 100, taxCode: 'none', cls: 'k1' }], sub: 100, tax: 0, total: 100, status: 'open' };
  r = await call('PUT', '/api/c/records/estimates/e1', est);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  st = await state();
  const e = st.estimates.find(x => x.id === 'e1');
  assert.deepEqual([e.cls, e.tags, e.lines[0].cls], ['k2', ['t1'], 'k1']);
  assert.equal((await call('PUT', '/api/c/records/estimates/e2', { ...est, tags: ['nope'] })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/estimates/e2', { ...est, lines: [{ ...est.lines[0], cls: 'nope' }] })).status, 400);
});

test('custom roles: delayed charges need Sales', async () => {
  const perms = { sales: 'view', expenses: 'edit', banking: 'none', payroll: 'none', reports: 'view', accounting: 'none', salestax: 'none', settings: 'none' };
  const roleId = (await call('POST', '/api/roles', { name: 'AP clerk', perms })).json.role.id;
  assert.equal((await call('POST', '/api/users', { name: 'Pat', username: 'pat@example.com', password: 'temporary pass 123', role: 'staff', customRole: roleId })).status, 200);
  const login = async pw => { const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pat@example.com', password: pw }) }); return res.headers.get('set-cookie').split(';')[0]; };
  let ck = await login('temporary pass 123');
  await fetch(base + '/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: ck }, body: JSON.stringify({ current: 'temporary pass 123', password: 'pat picks a new phrase' }) });
  ck = await login('pat picks a new phrase');
  const res = await fetch(base + `/api/c/${co}/records/delayed/dc9`, { method: 'PUT', headers: { 'Content-Type': 'application/json', cookie: ck },
    body: JSON.stringify({ kind: 'charge', date: '2026-09-02', contactId: 'c1', lines: [{ desc: 'x', account: 'a4000', qty: 1, rate: 5, taxCode: 'none' }] }) });
  assert.equal(res.status, 403);
});
