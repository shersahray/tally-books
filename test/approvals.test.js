'use strict';
// Bill approvals (Plus): bills over a limit wait for an owner or approver before they can be paid; enforced by the server.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const A = require('../public/approvals.js');

let server, base, dir, owner, co, staff, staffId, clerk, roleId, myFirm;
const PW = 'correct horse battery staple';
async function req(cookie, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const c = url => `/api/c/${co}${url}`;
const bill = (number, total, contactId = 've') => ({ kind: 'bill', number, contactId, date: '2026-09-01', due: '2026-10-01', lines: [{ desc: 'Work', account: 'a6500', qty: 1, rate: total, taxCode: 'none' }], sub: total, tax: 0, total });
const pay = (docId, amount) => ({ type: 'billpayment', date: '2026-09-10', contactId: 've', applyTo: docId, amount, bank: 'a1000', lines: [{ account: 'a2000', debit: amount, credit: 0 }, { account: 'a1000', debit: 0, credit: amount }] });
const getDoc = async (who, id) => (await req(who, 'GET', c('/state'))).json.docs.find(d => d.id === id);
async function settings(patch) {
  const { rev, closingDate, closingPassword, hasCode, ...co0 } = (await req(owner, 'GET', c('/state'))).json.company;
  return req(owner, 'PUT', c('/settings'), { ...co0, ...patch });
}
async function person(name, username, extra) {
  const r = await req(owner, 'POST', '/api/users', { name, username, password: 'temporary pass 123', role: 'staff', ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const login = await req(null, 'POST', '/api/auth/login', { username, password: 'temporary pass 123' });
  assert.equal((await req(login.cookie, 'POST', '/api/auth/password', { current: 'temporary pass 123', password: name + ' picks a long phrase' })).status, 200);
  return { id: r.json.user.id, cookie: login.cookie };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-approvals-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await req(null, 'POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Bookkeeping' })).cookie;
  co = (await req(owner, 'POST', '/api/companies', { name: 'Maple Dental', province: 'ON' })).json.company.id;
  myFirm = (await req(owner, 'GET', '/api/firms')).json.myFirm;
  assert.equal((await req(owner, 'PUT', c('/records/contacts/ve'), { kind: 'vendor', name: 'Big Supplier' })).status, 200);
  assert.equal((await req(owner, 'PUT', c('/records/contacts/v2'), { kind: 'vendor', name: 'Small Supplier' })).status, 200);
  ({ id: staffId, cookie: staff } = await person('Sam Staff', 'sam@example.com'));
  roleId = (await req(owner, 'POST', '/api/roles', { name: 'AP lead', approveBills: true, perms: { expenses: 'edit', reports: 'view' } })).json.role.id;
  ({ cookie: clerk } = await person('Ada Approver', 'ada@example.com', { customRole: roleId }));
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('rules: over the limit, chosen vendors, changes send it back', () => {
  const s = { on: true, over: 1000, vendors: [], approvers: [] };
  assert.equal(A.required(s, bill('1', 1500)), true);
  assert.equal(A.required(s, bill('1', 1000)), false, 'at the limit: not over it');
  assert.equal(A.required({ ...s, over: 0 }, bill('1', 5)), true, '0 = every bill');
  assert.equal(A.required({ ...s, vendors: ['v2'] }, bill('1', 5000)), false, 'only chosen vendors');
  assert.equal(A.required({ ...s, on: false }, bill('1', 5000)), false);
  assert.equal(A.required(s, { ...bill('1', 5000), kind: 'invoice' }), false);
  const u = { username: 'a', name: 'A' };
  const a = A.onSave(null, bill('1', 1500), s, true, u, 1);
  assert.equal(a.status, 'waiting');
  assert.equal(A.onSave(null, bill('1', 1500), s, false, u, 1), undefined, 'feature off: nothing');
  const approved = { ...bill('1', 1500), approval: { ...a, status: 'approved' } };
  assert.equal(A.onSave(approved, { ...approved, memo: 'note' }, s, true, u).status, 'approved', 'a memo isn’t a change');
  assert.equal(A.onSave(approved, bill('1', 1600), s, true, u).status, 'waiting');
  assert.equal(A.onSave(approved, { ...bill('1', 1500), contactId: 'v2' }, s, true, u).status, 'waiting', 'a new vendor');
  assert.equal(A.cleanApproval({ status: 'waiting', history: [{ action: 'hacked', at: 1 }] }).history[0].action, 'changed');
  assert.throws(() => A.cleanApproval({ status: 'yes' }));
  assert.match(A.whyNot({ username: 'a', role: 'owner' }, s, { ...bill('1', 2000), approval: a }, 2), /someone else/);
  assert.equal(A.whyNot({ username: 'a', role: 'owner' }, s, { ...bill('1', 2000), approval: a }, 1), '', 'the only owner can approve their own');
  assert.match(A.whyNot({ id: 'u1', username: 'b', role: 'staff' }, s, { ...bill('1', 2000), approval: a }, 1), /owner or an approver/);
  assert.equal(A.whyNot({ id: 'u1', username: 'b', role: 'staff' }, { ...s, approvers: ['u1'] }, { ...bill('1', 2000), approval: a }, 1), '');
});

test('feature off (not turned on): bills are paid as before', async () => {
  assert.equal((await req(staff, 'PUT', c('/records/docs/b0'), bill('B0', 5000))).status, 200);
  assert.equal((await getDoc(owner, 'b0')).approval, undefined);
  assert.equal((await req(staff, 'PUT', c('/records/entries/p0'), pay('b0', 5000))).status, 200);
});

test('only owners turn approvals on; settings are cleaned', async () => {
  const { rev, closingDate, closingPassword, hasCode, ...co0 } = (await req(owner, 'GET', c('/state'))).json.company;
  let r = await req(staff, 'PUT', c('/settings'), { ...co0, approvals: { on: true, over: 1000 } });
  assert.equal(r.status, 403);
  r = await settings({ approvals: { on: true, over: '1000', vendors: [], approvers: [staffId, 'u_nobody'], extra: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ap = (await req(owner, 'GET', c('/state'))).json.company.approvals;
  assert.deepEqual(ap, { on: true, over: 1000, vendors: [], approvers: [staffId] }, 'only people in the firm');
  // Owners can name approvers back to none.
  assert.equal((await settings({ approvals: { on: true, over: 1000, vendors: [], approvers: [] } })).status, 200);
  const st = (await req(staff, 'GET', c('/approvers'))).json.people;
  assert.ok(st.some(p => p.name === 'Ada Approver' && p.approveBills), 'a role with Approve bills');
});

test('a bill over the limit waits; paying it is refused until it’s approved', async () => {
  // Under the limit: not affected.
  assert.equal((await req(staff, 'PUT', c('/records/docs/b1'), bill('B1', 500))).status, 200);
  assert.equal((await getDoc(owner, 'b1')).approval, undefined);
  assert.equal((await req(staff, 'PUT', c('/records/entries/p1'), pay('b1', 500))).status, 200);
  // Over the limit: waiting. Whatever the browser says about approval is ignored.
  let r = await req(staff, 'PUT', c('/records/docs/b2'), { ...bill('B2', 2500), approval: { status: 'approved' } });
  assert.equal(r.status, 200);
  let d = await getDoc(owner, 'b2');
  assert.equal(d.approval.status, 'waiting');
  assert.equal(d.approval.enteredBy, 'sam@example.com');
  // Paying it: refused, one way or another (a payment, or a batch like Banking's "Pay bill" match).
  r = await req(staff, 'PUT', c('/records/entries/p2'), pay('b2', 2500));
  assert.equal(r.status, 409);
  assert.match(r.json.error, /waiting for approval/);
  r = await req(staff, 'POST', c('/batch'), { writes: [{ op: 'set', collection: 'entries', id: 'p2', data: pay('b2', 100) }] });
  assert.equal(r.status, 409);
  // A non-approver can't approve; the person who entered it can't either.
  r = await req(staff, 'POST', c('/approvals/b2'), { action: 'approve' });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /owner or an approver/);
  // Rejecting needs a reason.
  assert.equal((await req(owner, 'POST', c('/approvals/b2'), { action: 'reject' })).status, 400);
  r = await req(owner, 'POST', c('/approvals/b2'), { action: 'reject', comment: 'The quote was $2,000' });
  assert.equal(r.status, 200);
  d = await getDoc(staff, 'b2');
  assert.equal(d.approval.status, 'rejected');
  assert.equal(d.approval.history.at(-1).comment, 'The quote was $2,000', 'the person who entered it sees why');
  assert.equal((await req(staff, 'PUT', c('/records/entries/p2'), pay('b2', 2500))).status, 409, 'rejected: still can’t be paid');
  assert.match((await req(staff, 'PUT', c('/records/entries/p2'), pay('b2', 2500))).json.error, /rejected/);
  // Corrected: back to waiting, then approved by the role with Approve bills.
  assert.equal((await req(staff, 'PUT', c('/records/docs/b2'), bill('B2', 2000))).status, 200);
  d = await getDoc(owner, 'b2');
  assert.equal(d.approval.status, 'waiting');
  assert.equal(d.approval.history.at(-1).action, 'resubmitted');
  r = await req(clerk, 'POST', c('/approvals/b2'), { action: 'approve', comment: 'OK' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await req(clerk, 'POST', c('/approvals/b2'), { action: 'approve' })).status, 409, 'not waiting any more');
  // Approved: it can be paid.
  assert.equal((await req(staff, 'PUT', c('/records/entries/p2'), pay('b2', 1000))).status, 200);
  // Every decision is in the activity log, with who.
  const log = (await req(owner, 'GET', c('/audit'))).json.rows;
  assert.ok(log.some(x => x.action === 'reject' && x.username === 'sher@example.com' && /B2.*rejected: The quote/.test(x.summary)));
  assert.ok(log.some(x => x.action === 'approve' && x.username === 'ada@example.com'));
});

test('editing an approved bill’s amount sends it back; a payment already made stays', async () => {
  assert.equal((await req(staff, 'PUT', c('/records/docs/b2'), { ...(await getDoc(owner, 'b2')), id: undefined, memo: 'just a note' })).status, 200);
  assert.equal((await getDoc(owner, 'b2')).approval.status, 'approved', 'a memo doesn’t reset it');
  assert.equal((await req(staff, 'PUT', c('/records/docs/b2'), bill('B2', 2200))).status, 200);
  const d = await getDoc(owner, 'b2');
  assert.equal(d.approval.status, 'waiting');
  assert.equal(d.approval.history.at(-1).action, 'changed');
  // The earlier payment can still be ticked as cleared, but not raised.
  const p2 = (await req(owner, 'GET', c('/state'))).json.entries.find(e => e.id === 'p2');
  const { id, ...p } = p2;
  assert.equal((await req(staff, 'PUT', c('/records/entries/p2'), { ...p, clear: { a1000: 'c' } })).status, 200);
  assert.equal((await req(staff, 'PUT', c('/records/entries/p2'), pay('b2', 1500))).status, 409);
});

test('approving your own bill: only the only owner, and they’re told', async () => {
  assert.equal((await req(owner, 'PUT', c('/records/docs/b3'), bill('B3', 3000))).status, 200);
  let r = await req(owner, 'POST', c('/approvals/b3'), { action: 'approve' });
  assert.equal(r.status, 200, 'the only owner approves their own bill');
  assert.equal((await getDoc(owner, 'b3')).approval.history.at(-1).self, true);
  // With a second owner, the person who entered it can't.
  const o2 = await req(owner, 'POST', '/api/users', { name: 'Olive Owner', username: 'olive@example.com', password: 'temporary pass 123', role: 'owner' });
  assert.equal(o2.status, 200);
  assert.equal((await req(owner, 'PUT', c('/records/docs/b4'), bill('B4', 3000))).status, 200);
  r = await req(owner, 'POST', c('/approvals/b4'), { action: 'approve' });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /someone else has to approve it/);
  // A named approver (plain staff) can.
  assert.equal((await settings({ approvals: { on: true, over: 1000, vendors: [], approvers: [staffId] } })).status, 200);
  assert.equal((await req(staff, 'POST', c('/approvals/b4'), { action: 'approve' })).status, 200);
});

test('only chosen vendors; turning approvals off frees held bills', async () => {
  assert.equal((await settings({ approvals: { on: true, over: 0, vendors: ['v2'], approvers: [] } })).status, 200);
  assert.equal((await req(staff, 'PUT', c('/records/docs/b5'), bill('B5', 9000, 've'))).status, 200);
  assert.equal((await getDoc(owner, 'b5')).approval, undefined, 'another vendor: not affected');
  assert.equal((await req(staff, 'PUT', c('/records/docs/b6'), bill('B6', 10, 'v2'))).status, 200);
  assert.equal((await getDoc(owner, 'b6')).approval.status, 'waiting', '0 = every bill from the chosen vendor');
  const p6 = { ...pay('b6', 10), contactId: 'v2' };
  assert.equal((await req(staff, 'PUT', c('/records/entries/p6'), p6)).status, 409);
  assert.equal((await settings({ approvals: { on: false, over: 0, vendors: ['v2'], approvers: [] } })).status, 200);
  assert.equal((await req(staff, 'PUT', c('/records/entries/p6'), p6)).status, 200, 'approvals off: it can be paid');
  assert.equal((await req(owner, 'POST', c('/approvals/b4'), { action: 'approve' })).status, 409, 'nothing to approve with approvals off');
});

test('a plan without bill approvals: no effect, and they can’t be turned on', async () => {
  assert.equal((await settings({ approvals: { on: true, over: 100, vendors: [], approvers: [] } })).status, 200);
  assert.equal((await req(owner, 'PUT', `/api/firms/${myFirm}`, { plan: 'essentials' })).status, 200);
  try {
    assert.equal((await req(staff, 'PUT', c('/records/docs/b7'), bill('B7', 5000))).status, 200);
    assert.equal((await getDoc(owner, 'b7')).approval, undefined);
    assert.equal((await req(staff, 'PUT', c('/records/entries/p7'), pay('b7', 5000))).status, 200);
    assert.equal((await req(owner, 'POST', c('/approvals/b7'), { action: 'approve' })).status, 403);
    assert.equal((await settings({ approvals: { on: false, over: 0, vendors: [], approvers: [] } })).status, 200);
    const r = await settings({ approvals: { on: true, over: 0, vendors: [], approvers: [] } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /Bill approvals/);
  } finally {
    await req(owner, 'PUT', `/api/firms/${myFirm}`, { plan: 'plus' });
  }
});
