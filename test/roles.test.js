'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// Custom roles: a firm's own roles for staff (None / View / Edit per area), enforced by the server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const R = require('../public/roles.js');

let server, base, dir, owner, co, staff, staffId, roleId;
const PW = 'correct horse battery staple';
async function req(cookie, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const c = url => `/api/c/${co}${url}`;
const perms = { sales: 'edit', expenses: 'view', banking: 'none', payroll: 'none', reports: 'view', accounting: 'none', salestax: 'none', settings: 'none' };

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-roles-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await req(null, 'POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Bookkeeping' })).cookie;
  co = (await req(owner, 'POST', '/api/companies', { name: 'Maple Dental', province: 'ON' })).json.company.id;
  const w = (collection, id, data) => ({ op: 'set', collection, id, data });
  const r = await req(owner, 'POST', c('/batch'), { writes: [
    w('contacts', 'cu', { kind: 'customer', name: 'Pat Customer' }),
    w('contacts', 've', { kind: 'vendor', name: 'Office Supply Co' }),
    w('employees', 'em', { name: 'Erin Employee', prov: 'ON', payType: 'salary', rate: 52000, freq: 'biweekly', payMethod: 'deposit', sin: '046454286', bank: { inst: '001', transit: '12345', account: '1234567' } }),
    w('docs', 'b1', { kind: 'bill', number: 'B1', contactId: 've', date: '2026-09-01', due: '2026-10-01', lines: [{ desc: 'Paper', account: 'a5100', qty: 1, rate: 50, taxCode: 'none' }], sub: 50, tax: 0, total: 50 }),
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('areas: collections and transaction types map to the right area', () => {
  assert.equal(R.recordArea('entries', { type: 'payment' }), 'sales');
  assert.equal(R.recordArea('entries', { type: 'invoice' }), 'sales');
  assert.equal(R.recordArea('entries', { type: 'expense' }), 'expenses');
  assert.equal(R.recordArea('entries', { type: 'journal' }), 'accounting');
  assert.equal(R.recordArea('entries', { type: 'payrun' }), 'payroll');
  assert.equal(R.recordArea('entries', { type: 'transfer' }), 'banking');
  assert.equal(R.recordArea('entries', { type: 'taxpayment' }), 'salestax');
  assert.equal(R.recordArea('docs', { kind: 'invoice' }), 'sales');
  assert.equal(R.recordArea('docs', { kind: 'vcredit' }), 'expenses');
  assert.equal(R.recordArea('contacts', { kind: 'vendor' }), 'expenses');
  assert.equal(R.recordArea('employees', {}), 'payroll');
  assert.equal(R.recordArea('rules', {}), 'banking');
  // Ticking a transaction as cleared is banking work, whatever the transaction is.
  assert.deepEqual(R.writeAreas('entries', { type: 'invoice', lines: [], clear: { a1000: 'c' } }, { type: 'invoice', lines: [] }), ['banking']);
  assert.deepEqual(R.writeAreas('entries', { type: 'journal', lines: [1] }, { type: 'invoice', lines: [] }).sort(), ['accounting', 'sales']);
  assert.equal(R.can(null, 'payroll', 'edit'), true, 'no role: not limited');
  assert.equal(R.can({ payroll: 'view' }, 'payroll', 'edit'), false);
  assert.equal(R.can({ payroll: 'view' }, 'payroll', 'view'), true);
  assert.throws(() => R.cleanRole({ name: ' ' }), /name/);
  assert.deepEqual(R.cleanRole({ name: 'Clerk', perms: { sales: 'edit', payroll: 'admin' } }).perms.payroll, 'none');
});

test('owners define roles; only owners, and names are unique', async () => {
  let r = await req(owner, 'POST', '/api/roles', { name: 'AR clerk', perms });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  roleId = r.json.role.id;
  assert.equal(r.json.role.perms.sales, 'edit');
  assert.equal((await req(owner, 'POST', '/api/roles', { name: 'ar CLERK', perms })).status, 400);
  assert.equal((await req(owner, 'POST', '/api/roles', { name: '', perms })).status, 400);
  const u = await req(owner, 'GET', '/api/users');
  assert.equal(u.json.customRoles, true);
  assert.deepEqual(u.json.roles.map(x => x.name), ['AR clerk']);
  assert.equal(u.json.firm.roles, undefined, 'roles come on their own, not inside the firm');
  // A staff member with this role.
  r = await req(owner, 'POST', '/api/users', { name: 'Cleo Clerk', username: 'cleo@example.com', password: 'temporary pass 123', role: 'staff', customRole: roleId });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  staffId = r.json.user.id;
  assert.equal(r.json.user.roleName, 'AR clerk');
  assert.equal((await req(owner, 'POST', '/api/users', { name: 'X', username: 'x@example.com', password: 'temporary pass 123', role: 'client', companies: [co], customRole: roleId })).status, 400, 'only staff get a custom role');
  assert.equal((await req(owner, 'POST', '/api/users', { name: 'Y', username: 'y@example.com', password: 'temporary pass 123', role: 'staff', customRole: 'r_nope' })).status, 404);
  const login = await req(null, 'POST', '/api/auth/login', { username: 'cleo@example.com', password: 'temporary pass 123' });
  assert.equal((await req(login.cookie, 'POST', '/api/auth/password', { current: 'temporary pass 123', password: 'cleo picks her own phrase' })).status, 200);
  staff = login.cookie;
  const me = await req(staff, 'GET', '/api/auth/me');
  assert.deepEqual(me.json.user.perms, perms);
  assert.equal((await req(staff, 'GET', '/api/roles')).status, 403, 'staff can’t see or change roles');
  assert.equal((await req(staff, 'POST', '/api/roles', { name: 'Mine', perms })).status, 403);
});

test('Sales=Edit, Expenses=View, Payroll=None: invoices yes, bills no, no employees', async () => {
  const inv = { kind: 'invoice', number: '1001', contactId: 'cu', date: '2026-09-15', due: '2026-10-15', lines: [{ desc: 'Cleaning', account: 'a4000', qty: 1, rate: 100, taxCode: 'none' }], sub: 100, tax: 0, total: 100 };
  let r = await req(staff, 'POST', c('/batch'), { writes: [
    { op: 'set', collection: 'docs', id: 'i1', data: inv },
    { op: 'set', collection: 'entries', id: 'd_i1', data: { type: 'invoice', date: '2026-09-15', ref: '1001', docId: 'i1', contactId: 'cu', lines: [{ account: 'a1200', debit: 100, credit: 0 }, { account: 'a4000', debit: 0, credit: 100 }] } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await req(staff, 'PUT', c('/records/entries/p1'), { type: 'payment', date: '2026-09-20', contactId: 'cu', applyTo: 'i1', amount: 100, bank: 'a1000', lines: [{ account: 'a1000', debit: 100, credit: 0 }, { account: 'a1200', debit: 0, credit: 100 }] });
  assert.equal(r.status, 200, 'a payment received is Sales');

  r = await req(staff, 'PUT', c('/records/docs/b2'), { kind: 'bill', number: 'B2', contactId: 've', date: '2026-09-01', due: '2026-10-01', lines: [{ desc: 'Paper', account: 'a5100', qty: 1, rate: 20, taxCode: 'none' }], sub: 20, tax: 0, total: 20 });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /Expenses/);
  assert.equal((await req(staff, 'DELETE', c('/records/docs/b1'))).status, 403, 'can’t delete a bill either');
  assert.equal((await req(staff, 'PUT', c('/records/docs/b1'), { kind: 'invoice', number: 'B1', contactId: 'cu', date: '2026-09-01', due: '2026-10-01', lines: [], sub: 0, tax: 0, total: 0 })).status, 403, 'can’t turn a bill into an invoice');
  assert.equal((await req(staff, 'PUT', c('/records/contacts/v2'), { kind: 'vendor', name: 'New vendor' })).status, 403);
  assert.equal((await req(staff, 'PUT', c('/records/contacts/c2'), { kind: 'customer', name: 'New customer' })).status, 200);
  assert.equal((await req(staff, 'PUT', c('/records/entries/j1'), { type: 'journal', date: '2026-09-01', lines: [{ account: 'a1000', debit: 5, credit: 0 }, { account: 'a4000', debit: 0, credit: 5 }] })).status, 403, 'journal entries are Accounting');
  assert.equal((await req(staff, 'PUT', c('/records/employees/e2'), { name: 'Sneaky', prov: 'ON', payType: 'salary', rate: 1, freq: 'monthly' })).status, 403);
  // A batch is all or nothing: one bill in it refuses the whole batch.
  r = await req(staff, 'POST', c('/batch'), { writes: [{ op: 'set', collection: 'contacts', id: 'c3', data: { kind: 'customer', name: 'Three' } }, { op: 'set', collection: 'docs', id: 'b3', data: { kind: 'bill', number: 'B3', contactId: 've', date: '2026-09-01', due: '2026-10-01', lines: [], sub: 0, tax: 0, total: 0 } }] });
  assert.equal(r.status, 403);

  const st = (await req(staff, 'GET', c('/state'))).json;
  assert.deepEqual(st.employees, [], 'no payroll: no employees');
  assert.deepEqual(st.payruns, []);
  assert.ok(Array.isArray(st.bankTxns) && Array.isArray(st.rules), 'every list is still there');
  assert.deepEqual(st.bankTxns, []);
  assert.ok(st.docs.some(d => d.id === 'b1'), 'Expenses=View: bills are there to look at');
  assert.ok(st.docs.some(d => d.id === 'i1'));
  assert.ok(st.entries.some(e => e.id === 'p1'), 'Reports=View: the whole ledger, for report totals');
  assert.equal(st.company.payroll, undefined);
  assert.equal(st.accounts.length > 0, true);
  // Things that need other areas.
  assert.equal((await req(staff, 'GET', c('/audit'))).status, 403, 'activity log is Settings');
  assert.equal((await req(staff, 'GET', c('/backup'))).status, 403, 'a backup is the whole books');
  assert.equal((await req(staff, 'POST', c('/bank/import'), { account: 'a1000', rows: [] })).status, 403);
  // The owner, plain staff and the readOnly flag work as before.
  const ost = (await req(owner, 'GET', c('/state'))).json;
  assert.equal(ost.employees.length, 1);
  assert.equal(ost.employees[0].sin, '046454286');
});

test('company settings: only the areas the role can change', async () => {
  const s0 = (await req(owner, 'GET', c('/state'))).json.company;
  assert.equal((await req(owner, 'PUT', c('/settings'), { ...s0, payroll: { craAccount: '123456789RP0001' } })).status, 200);
  const before = (await req(owner, 'GET', c('/state'))).json.company;
  const { rev, closingDate, closingPassword, hasCode, ...co0 } = before;
  // No Settings: changing the business name is refused; the hidden payroll settings aren't wiped.
  let r = await req(staff, 'PUT', c('/settings'), { ...co0, payroll: undefined, name: 'Renamed' });
  assert.equal(r.status, 200, 'settings it can’t see are kept as they were');
  let now = (await req(owner, 'GET', c('/state'))).json.company;
  assert.equal(now.name, before.name);
  // Sales=Edit: the invoice note can change.
  r = await req(staff, 'PUT', c('/settings'), { ...co0, payroll: undefined, invoiceNote: 'Thanks!' });
  assert.equal(r.status, 200);
  now = (await req(owner, 'GET', c('/state'))).json.company;
  assert.equal(now.invoiceNote, 'Thanks!');
  assert.equal(now.payroll.craAccount, '123456789RP0001', 'payroll settings it can’t see aren’t wiped');
});

test('payroll at View hides SINs and bank account numbers; changing a role is logged', async () => {
  let r = await req(owner, 'PUT', `/api/roles/${roleId}`, { name: 'AR clerk', perms: { ...perms, payroll: 'view' } });
  assert.equal(r.status, 200);
  const st = (await req(staff, 'GET', c('/state'))).json;
  assert.equal(st.employees.length, 1);
  assert.equal(st.employees[0].sin, '•••••286');
  assert.equal(st.employees[0].bank.account, '••••567');
  assert.equal((await req(staff, 'PUT', c('/records/employees/em'), { ...st.employees[0] })).status, 403, 'View can’t save');

  // Give the clerk plain staff, then the role again: both role changes are in the sign-in activity.
  assert.equal((await req(owner, 'PUT', `/api/users/${staffId}`, { customRole: '' })).status, 200);
  assert.equal((await req(staff, 'GET', '/api/auth/me')).json.user.perms, null);
  assert.equal((await req(staff, 'GET', c('/state'))).json.employees[0].sin, '046454286', 'plain staff: everything, as before');
  assert.equal((await req(owner, 'PUT', `/api/users/${staffId}`, { customRole: roleId })).status, 200);
  const log = (await req(owner, 'GET', '/api/security/log')).json.log;
  assert.ok(log.some(e => e.event === 'role-added' && e.role === 'AR clerk' && /Sales: edit/.test(e.perms)));
  assert.ok(log.some(e => e.event === 'role-changed' && /Payroll: view/.test(e.perms) && /Payroll: none/.test(e.before)));
  assert.ok(log.some(e => e.event === 'user-changed' && e.roleWas === 'AR clerk' && e.roleNow === 'Staff'));
  assert.ok(log.some(e => e.event === 'user-changed' && e.roleWas === 'Staff' && e.roleNow === 'AR clerk'));
  // Owners and clients never keep a custom role.
  assert.equal((await req(owner, 'PUT', `/api/users/${staffId}`, { role: 'owner', customRole: roleId })).status, 400);
  // A role in use can't be removed.
  assert.equal((await req(owner, 'DELETE', `/api/roles/${roleId}`)).status, 409);
});

test('a plan without custom roles refuses them', async () => {
  const firms = (await req(owner, 'GET', '/api/firms')).json;
  assert.equal((await req(owner, 'PUT', `/api/firms/${firms.myFirm}`, { plan: 'essentials' })).status, 200);
  try {
    assert.equal((await req(owner, 'POST', '/api/roles', { name: 'Payables', perms })).status, 403);
    const r = await req(owner, 'POST', '/api/users', { name: 'Dee', username: 'dee@example.com', password: 'temporary pass 123', role: 'staff', customRole: roleId });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Custom roles/);
    const other = (await req(owner, 'POST', '/api/users', { name: 'Ed', username: 'ed@example.com', password: 'temporary pass 123', role: 'staff' })).json.user;
    assert.equal((await req(owner, 'PUT', `/api/users/${other.id}`, { customRole: roleId })).status, 403, 'can’t assign one');
    assert.equal((await req(owner, 'GET', '/api/users')).json.customRoles, false);
    // Someone who already has a role keeps its limits (never more access than before).
    assert.deepEqual((await req(staff, 'GET', c('/state'))).json.payruns, []);
    assert.equal((await req(staff, 'PUT', c('/records/docs/b9'), { kind: 'bill', number: 'B9', contactId: 've', date: '2026-09-01', due: '2026-10-01', lines: [], sub: 0, tax: 0, total: 0 })).status, 403);
    // Taking the role away still works.
    assert.equal((await req(owner, 'PUT', `/api/users/${staffId}`, { customRole: '' })).status, 200);
  } finally {
    await req(owner, 'PUT', `/api/firms/${firms.myFirm}`, { plan: 'plus' });
  }
});

test('areas for this batch’s settings and records: payroll settings, workflows, delayed charges', () => {
  // Overtime, EHT, WSIB, transmitter, employer address, stub emails and Revenu Québec's frequency all live in `payroll`.
  assert.equal(R.settingArea('payroll'), 'payroll');
  assert.equal(R.settingArea('workflows'), 'settings');
  assert.equal(R.settingArea('reminders'), 'settings');
  assert.equal(R.recordArea('delayed', { kind: 'charge' }), 'sales');
  assert.equal(R.recordArea('delayed', { kind: 'credit' }), 'sales');
  assert.equal(R.recordArea('payruns', { void: { date: '2026-10-01' } }), 'payroll');
  assert.equal(R.recordArea('entries', { type: 'payremit' }), 'payroll');
});
