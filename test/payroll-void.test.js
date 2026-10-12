'use strict';
// Correcting pay runs: voiding with a reversing entry, when deleting is still allowed, and the new pay-run fields
// (overtime, non-discretionary bonus, workers' compensation premium) and payroll settings (overtime, EHT, WSIB).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const P = require('../public/payroll-calc.js');

let server, base, dir, co, owner;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-void-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  owner = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Void Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie: owner }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const batch = writes => call('POST', '/api/c/batch', { writes });
const state = async () => (await call('GET', '/api/c/state')).json;
const r2 = P.r2;

// One pay run for one Ontario employee: the line and its balanced journal entry.
function payrun(id, payDate, { gross = 2000, extra = {}, wsib } = {}) {
  const r = P.calc({ date: payDate, prov: 'ON', P: 26, gross });
  const ded = r.employee, er = r.employer;
  const net = r2(gross - Object.values(ded).reduce((s, v) => s + v, 0));
  const split = P.remitSplit(ded, er), erT = r2(Object.values(er).reduce((s, v) => s + v, 0));
  const line = { employeeId: 'e1', name: 'Pat', prov: 'ON', gross, rrsp: 0, union: 0, ded, er, net, ...extra, ...(wsib ? { wsib } : {}) };
  const lines = [{ account: 'a7100', debit: gross, credit: 0 }, { account: 'a7110', debit: erT, credit: 0 }, { account: 'a2300', debit: 0, credit: split.cra }, { account: 'a1000', debit: 0, credit: net }];
  if (wsib) lines.push({ account: 'a7155', debit: wsib.premium, credit: 0 }, { account: 'a2335', debit: 0, credit: wsib.premium });
  return {
    entry: { op: 'set', collection: 'entries', id: 'pr_' + id, data: { type: 'payrun', date: payDate, lines, payrunId: id } },
    run: { op: 'set', collection: 'payruns', id, data: { payDate, freq: 'biweekly', bank: 'a1000', entryId: 'pr_' + id, created: Date.parse(payDate), lines: [line] } },
    lines,
  };
}
const voidWrites = (id, p, date, { lines } = {}) => [
  { op: 'set', collection: 'entries', id: 'prv_' + id, data: { type: 'payrun', date, memo: 'Void', reversalOf: 'pr_' + id, lines: lines || P.reverseLines(p.lines) } },
  { op: 'set', collection: 'payruns', id, data: { ...p.run.data, void: { date, reason: 'Wrong hours', entryId: 'prv_' + id } } },
];

test('setup: accounts and an Ontario employee', async () => {
  const acct = (id, code, name, type, detail) => call('PUT', `/api/c/records/accounts/${id}`, { code, name, type, detail });
  for (const a of [['a2300', '2300', 'Payroll liabilities – CRA', 'Liability', 'payroll_cra'], ['a7110', '7110', 'Employer payroll taxes', 'Expense', 'payroll_tax'],
    ['a2335', '2335', 'Workers’ compensation payable', 'Liability', 'wsib_payable'], ['a7155', '7155', 'Workers’ compensation premiums', 'Expense', 'wsib']]) {
    assert.equal((await acct(...a)).status, 200, a[0]);
  }
  assert.equal((await call('PUT', '/api/c/records/employees/e1', { name: 'Pat', prov: 'ON', freq: 'biweekly', payType: 'hourly', rate: 25, hours: 80, otEligible: true, wsibGroup: 'g1' })).status, 200);
  const e = (await state()).employees.find(x => x.id === 'e1');
  assert.equal(e.otEligible, true); assert.equal(e.wsibGroup, 'g1');
});

test('void a pay run: a balanced reversing entry, the run kept and marked void', async () => {
  const p1 = payrun('run1', '2026-09-04'), p2 = payrun('run2', '2026-09-18');
  assert.equal((await batch([p1.entry, p1.run])).status, 200);
  assert.equal((await batch([p2.entry, p2.run])).status, 200);
  // Deleting is only for the latest pay run: run2 used run1's year-to-date amounts.
  const del = await batch([{ op: 'delete', collection: 'payruns', id: 'run1' }, { op: 'delete', collection: 'entries', id: 'pr_run1' }]);
  assert.equal(del.status, 409); assert.match(del.json.error, /Void it instead/);
  // A void needs its reversing entry, which has to undo the original exactly, dated the void date, not before the pay date.
  let r = await batch([{ op: 'set', collection: 'payruns', id: 'run1', data: { ...p1.run.data, void: { date: '2026-10-01', entryId: '' } } }]);
  assert.equal(r.status, 400); assert.match(r.json.error, /reversing entry/);
  // Balanced, but to the wrong account (the net pay back to wages instead of the bank).
  const half = P.reverseLines(p1.lines).map(l => (l.account === 'a1000' ? { ...l, account: 'a7100' } : l));
  r = await batch(voidWrites('run1', p1, '2026-10-01', { lines: half }));
  assert.equal(r.status, 400); assert.match(r.json.error, /doesn’t undo/);
  r = await batch(voidWrites('run1', p1, '2026-09-01'));
  assert.equal(r.status, 400); assert.match(r.json.error, /before the pay date/);
  // An unbalanced reversing entry is refused by the journal entry rules.
  const off = P.reverseLines(p1.lines); off[0] = { ...off[0], credit: off[0].credit + 1 };
  r = await batch(voidWrites('run1', p1, '2026-10-01', { lines: off }));
  assert.equal(r.status, 400); assert.match(r.json.error, /balance/);
  // Changing the pay run while voiding it isn't allowed.
  const w = voidWrites('run1', p1, '2026-10-01'); w[1].data = { ...w[1].data, payDate: '2026-09-05' };
  assert.equal((await batch(w)).status, 400);
  r = await batch(voidWrites('run1', p1, '2026-10-01'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const st = await state();
  const run1 = st.payruns.find(x => x.id === 'run1');
  assert.equal(run1.void.date, '2026-10-01'); assert.equal(run1.void.entryId, 'prv_run1'); assert.equal(run1.void.reason, 'Wrong hours');
  const rev = st.entries.find(e => e.id === 'prv_run1');
  assert.equal(rev.reversalOf, 'pr_run1');
  assert.ok(Math.abs(rev.lines.reduce((t, l) => t + l.debit - l.credit, 0)) < 0.005, 'balanced');
  // The original and reversing entries cancel out, account by account.
  const net = {};
  for (const e of [st.entries.find(x => x.id === 'pr_run1'), rev]) for (const l of e.lines) net[l.account] = r2((net[l.account] || 0) + l.debit - l.credit);
  assert.ok(Object.values(net).every(v => Math.abs(v) < 0.005), JSON.stringify(net));
});

test('a void pay run can’t be changed, brought back or deleted, nor its reversing entry', async () => {
  const run1 = (await state()).payruns.find(x => x.id === 'run1');
  const { id, ...data } = run1;
  assert.equal((await batch([{ op: 'set', collection: 'payruns', id: 'run1', data: { ...data, void: null } }])).status, 409);
  assert.equal((await batch([{ op: 'set', collection: 'payruns', id: 'run1', data: { ...data, void: { ...data.void, date: '2026-10-02' } } }])).status, 409);
  assert.equal((await batch([{ op: 'delete', collection: 'payruns', id: 'run1' }])).status, 409);
  assert.equal((await call('DELETE', '/api/c/records/entries/prv_run1')).status, 409);
  // Saving it back unchanged (with only its reason edited) is fine.
  assert.equal((await batch([{ op: 'set', collection: 'payruns', id: 'run1', data: { ...data, void: { ...data.void, reason: 'Paid twice' } } }])).status, 200);
});

test('only a posted pay run can be voided; the latest one can still be deleted unless reconciled', async () => {
  const p9 = payrun('run9', '2026-10-02');
  const w = voidWrites('run9', p9, '2026-10-03');
  assert.equal((await batch([p9.entry, w[1]])).status, 400, 'not posted yet');
  // run2 is now the latest (run1 is void, so it doesn't count): it can be deleted.
  const p2 = payrun('run2', '2026-09-18');
  assert.equal((await batch([{ op: 'delete', collection: 'payruns', id: 'run2' }, { op: 'delete', collection: 'entries', id: 'pr_run2' }])).status, 200);
  // A reconciled pay run can't be deleted, even the latest.
  assert.equal((await batch([p2.entry, p2.run])).status, 200);
  const e = (await state()).entries.find(x => x.id === 'pr_run2');
  const { id, ...ed } = e;
  assert.equal((await call('PUT', '/api/c/records/entries/pr_run2', { ...ed, clear: { a1000: 'r' } })).status, 200);
  const del = await batch([{ op: 'delete', collection: 'payruns', id: 'run2' }]);
  assert.equal(del.status, 409); assert.match(del.json.error, /reconciled/);
});

test('voiding a pay run in a closed period: the run can be marked void, the reversing entry must be in an open period', async () => {
  const p3 = payrun('run3', '2026-10-16');
  assert.equal((await batch([p3.entry, p3.run])).status, 200);
  assert.equal((await call('PUT', '/api/c/closing', { date: '2026-10-31' })).status, 200);
  const closed = await batch(voidWrites('run3', p3, '2026-10-20'));
  assert.equal(closed.status, 423, 'the reversing entry is in the closed period');
  const ok = await batch(voidWrites('run3', p3, '2026-11-02'));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await call('PUT', '/api/c/closing', { date: '' })).status, 200);
});

test('pay-run lines: overtime adds up to gross, hours by week, bonus flag and the WSIB premium are checked', async () => {
  const ok = payrun('run4', '2026-11-13', { gross: 2180, extra: { regular: 2000, overtime: 180, hours: 86, otHours: 6, weekHours: [50, 36], bonusVac: true },
    wsib: { group: 'g1', rate: 1.23, insurable: 2180, premium: 26.81 } });
  const r = await batch([ok.entry, ok.run]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const line = (await state()).payruns.find(x => x.id === 'run4').lines[0];
  assert.deepEqual([line.overtime, line.otHours, line.weekHours, line.bonusVac, line.wsib.premium], [180, 6, [50, 36], true, 26.81]);
  for (const [extra, wsib, msg] of [
    [{ regular: 2000, overtime: 100 }, null, /add up to gross/],
    [{ regular: 2000, overtime: 180, hours: 5, otHours: 6 }, null, /overtime hours/],
    [{ weekHours: [50, 200] }, null, /hours by week/],
    [{ weekHours: 'x' }, null, /hours by week/],
    [{}, { group: 'g1', rate: 1.23, insurable: 2180, premium: 99 }, /doesn’t match/],
    [{}, { group: 'g1', rate: 1.23, insurable: 9999, premium: 122.99 }, /more than pay/],
    [{}, { group: 'g1', rate: -1, insurable: 100, premium: 0 }, /rate/],
  ]) {
    const p = payrun('run5', '2026-11-27', { gross: 2180, extra, wsib });
    const res = await batch([p.entry, p.run]);
    assert.equal(res.status, 400, JSON.stringify(extra)); assert.match(res.json.error, msg);
  }
});

test('payroll settings: overtime threshold, EHT and workers’ compensation are validated and kept', async () => {
  const s = (await state()).company;
  const put = payroll => call('PUT', '/api/c/settings', { ...s, payroll: { ...s.payroll, ...payroll } });
  assert.equal((await put({ eht: { eligible: true, exemption: 2000000 } })).status, 400, 'the exemption is at most $1,000,000');
  assert.equal((await put({ wsib: { on: true, groups: [] } })).status, 400, 'a rate group is needed');
  assert.equal((await put({ wsib: { on: true, groups: [{ id: 'g1', rate: 150 }] } })).status, 400);
  assert.equal((await put({ wsib: { on: true, groups: [{ id: 'g1', rate: 1 }, { id: 'g1', rate: 2 }] } })).status, 400, 'duplicate ids');
  const r = await put({ otThreshold: 40, eht: { eligible: false, exemption: 250000, groupPayroll: 1000 }, wsib: { on: true, account: '1234567', freq: 'monthly', max: 121700, groups: [{ id: 'g1', name: 'Retail', code: '7', rate: 1.23 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = (await state()).company.payroll;
  assert.equal(p.otThreshold, 40);
  assert.deepEqual(p.eht, { eligible: false, exemption: 250000, groupPayroll: 1000 });
  assert.deepEqual(p.wsib, { on: true, account: '1234567', freq: 'monthly', max: 121700, groups: [{ id: 'g1', name: 'Retail', code: '7', rate: 1.23 }] });
  assert.equal((await put({ otThreshold: '' })).status, 200);
  assert.equal((await state()).company.payroll.otThreshold, '', 'blank = the province’s rule');
});
