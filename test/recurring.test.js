'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// Recurring expenses, deposits, transfers and journal entries: the schedule (recurring-calc.js) and the server's checks.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../public/recurring-calc.js');
const { createApp } = require('../src/server/app');

/* ---------- the schedule ---------- */
test('next dates: weeks, months, quarters, years, and every few', () => {
  assert.equal(R.after({ every: 'week', n: 1 }, '2026-12-28'), '2027-01-04');
  assert.equal(R.after({ every: 'week', n: 2 }, '2026-03-02'), '2026-03-16');
  assert.equal(R.after({ every: 'month', n: 1 }, '2026-01-15'), '2026-02-15');
  assert.equal(R.after({ every: 'month', n: 3 }, '2026-11-10'), '2027-02-10');
  assert.equal(R.after({ every: 'quarter', n: 1 }, '2026-10-01'), '2027-01-01');
  assert.equal(R.after({ every: 'year', n: 1 }, '2026-06-30'), '2027-06-30');
  // Across a daylight saving change, a week is still seven days.
  assert.equal(R.after({ every: 'week', n: 1 }, '2026-03-05'), '2026-03-12');
  assert.equal(R.after({ every: 'week', n: 1 }, '2026-10-29'), '2026-11-05');
});

test('month-end stays month-end; a short month keeps the template day after', () => {
  const day = R.dayFor('2026-04-30');
  assert.equal(day, 31, 'the last day of April means month-end');
  let r = { every: 'month', n: 1, day }, d = '2026-04-30', seen = [];
  for (let i = 0; i < 4; i++) { d = R.after(r, d); seen.push(d); }
  assert.deepEqual(seen, ['2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31']);
  // The 31st through February: Feb 28 (or 29), then back to the 31st.
  r = { every: 'month', n: 1, day: R.dayFor('2026-01-31') };
  assert.equal(R.after(r, '2026-01-31'), '2026-02-28');
  assert.equal(R.after(r, '2026-02-28'), '2026-03-31');
  assert.equal(R.after({ every: 'month', n: 1, day: 31 }, '2028-01-31'), '2028-02-29', 'leap year');
  // The 30th isn't month-end in January, so it stays the 30th (and Feb 28 in February).
  r = { every: 'month', n: 1, day: R.dayFor('2026-01-30') };
  assert.equal(r.day, 30);
  assert.equal(R.after(r, '2026-01-30'), '2026-02-28');
  assert.equal(R.after(r, '2026-02-28'), '2026-03-30');
  assert.equal(R.after({ every: 'quarter', n: 1, day: 31 }, '2026-03-31'), '2026-06-30');
  // Older templates without a day keep the date's own day.
  assert.equal(R.after({ every: 'month', n: 1 }, '2026-03-15'), '2026-04-15');
});

test('due, catching up, end dates, pausing and closed periods', () => {
  const r = { every: 'month', n: 1, day: 1, next: '2026-07-01', end: '', active: true };
  assert.equal(R.isDue(r, '2026-06-30'), false);
  assert.equal(R.isDue(r, '2026-07-01'), true);
  assert.equal(R.isDue({ ...r, active: false }, '2026-10-01'), false, 'paused');
  assert.equal(R.isDue({ ...r, end: '2026-06-01' }, '2026-10-01'), false, 'ended');
  // Opened on October 11 after months away: July to October, with July and August in a closed period.
  const p = R.plan(r, '2026-10-11', '2026-08-31');
  assert.deepEqual(p.dates.map(x => [x.date, x.closed]), [['2026-07-01', true], ['2026-08-01', true], ['2026-09-01', false], ['2026-10-01', false]]);
  assert.equal(p.next, '2026-11-01');
  // An end date stops it; a long gap is capped.
  assert.deepEqual(R.plan({ ...r, end: '2026-08-15' }, '2026-10-11', '').dates.map(x => x.date), ['2026-07-01', '2026-08-01']);
  assert.equal(R.plan({ every: 'week', n: 1, next: '2020-01-01' }, '2026-10-11', '', 60).dates.length, 60);
  assert.deepEqual(R.plan({ ...r, active: false }, '2026-10-11').dates, []);
  assert.deepEqual(R.plan(r, '2026-06-01').dates, [], 'not yet');
});

test('journal lines must balance', () => {
  const ok = [{ account: 'a6000', debit: 100.1, credit: '' }, { account: 'a2000', debit: '', credit: 100.1 }];
  assert.equal(R.journalProblem(ok), '');
  assert.deepEqual(R.journalLines(ok), [{ account: 'a6000', debit: 100.1, credit: 0, memo: '' }, { account: 'a2000', debit: 0, credit: 100.1, memo: '' }]);
  assert.equal(R.total({ kind: 'journal', lines: ok }), 100.1);
  assert.match(R.journalProblem([{ account: 'a6000', debit: 100 }, { account: 'a2000', credit: 90 }]), /out by 10\.00/);
  assert.match(R.journalProblem([{ account: 'a6000', debit: 100 }]), /at least one debit and one credit/);
  assert.match(R.journalProblem([{ account: 'a6000', debit: 100 }, { account: 'a2000', debit: 100 }]), /at least one debit and one credit/);
  assert.match(R.journalProblem([{ account: 'a6000', debit: 100, credit: 100 }, { account: 'a2000', credit: 0 }]), /either Debit or Credit/);
  assert.match(R.journalProblem([{ account: '', debit: 100 }, { account: 'a2000', credit: 100 }]), /needs an account/);
  assert.match(R.journalProblem([{ account: 'a6000', debit: -5 }, { account: 'a2000', credit: -5 }]), /positive amounts/);
  // Cents add up without floating-point drift.
  assert.equal(R.journalProblem([{ account: 'a', debit: 0.1 }, { account: 'b', debit: 0.2 }, { account: 'c', credit: 0.3 }]), '');
  assert.deepEqual(R.transferLines({ from: 'a1000', to: 'a1010', amount: 500 }), [{ account: 'a1010', debit: 500, credit: 0 }, { account: 'a1000', debit: 0, credit: 500 }]);
});

/* ---------- the server ---------- */
let server, base, dir, co, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-recur-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Recurring Co', province: 'ON' })).json.company.id;
  await call('PUT', '/api/c/records/contacts/v1', { name: 'Telco', kind: 'vendor' });
  await call('PUT', '/api/c/records/accounts/sav', { name: 'Savings', type: 'Asset', detail: 'bank' });
  await call('PUT', '/api/c/records/accounts/usd', { name: 'US account', type: 'Asset', detail: 'bank', currency: 'USD' });
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const sched = { every: 'month', n: 1, next: '2026-11-30', day: 31, end: '', mode: 'remind' };

test('recurring journal entries: an unbalanced one is refused', async () => {
  const jn = { ...sched, kind: 'journal', name: 'Monthly accrual', memo: 'Accrued wages', ref: 'AJE', lines: [{ account: 'a6000', debit: 1200, credit: 0, memo: 'Wages' }, { account: 'a2000', debit: 0, credit: 1200 }] };
  const ok = await call('PUT', '/api/c/records/recurring/j1', jn);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const saved = (await call('GET', '/api/c/state')).json.recurring.find(r => r.id === 'j1');
  assert.deepEqual([saved.kind, saved.mode, saved.day, saved.lines.length, saved.lines[0].memo, saved.ref], ['journal', 'remind', 31, 2, 'Wages', 'AJE']);
  const off = await call('PUT', '/api/c/records/recurring/j2', { ...jn, lines: [{ account: 'a6000', debit: 1200 }, { account: 'a2000', credit: 1100 }] });
  assert.equal(off.status, 400); assert.match(off.json.error, /out by 100\.00/);
  assert.equal((await call('PUT', '/api/c/records/recurring/j2', { ...jn, lines: [{ account: 'a6000', debit: 1200 }] })).status, 400, 'one line');
  assert.equal((await call('PUT', '/api/c/records/recurring/j2', { ...jn, lines: [{ account: 'nope', debit: 5 }, { account: 'a2000', credit: 5 }] })).status, 400, 'unknown account');
  assert.equal((await call('PUT', '/api/c/records/recurring/j2', { ...jn, day: 40 })).status, 400, 'day of month');
  assert.equal((await call('DELETE', '/api/c/records/accounts/a2000')).status, 409, 'account used by a template');
});

test('recurring expenses, deposits and transfers are checked', async () => {
  const ex = { ...sched, kind: 'expense', name: 'Internet', bank: 'a1000', contactId: 'v1', lines: [{ account: 'a6800', desc: 'Fibre', amount: 95, taxCode: 'std' }], mode: 'auto' };
  assert.equal((await call('PUT', '/api/c/records/recurring/e1', ex)).status, 200);
  assert.equal((await call('PUT', '/api/c/records/recurring/e1', { ...ex, contactId: '' })).status, 200, 'payee is optional');
  for (const bad of [{ bank: '' }, { bank: 'a6800' }, { bank: 'usd' }, { lines: [] }, { lines: [{ account: 'a6800', amount: 0 }] }, { lines: [{ account: 'a1000', amount: 5 }] }, { contactId: 'ghost' }, { kind: 'payment' }]) {
    assert.equal((await call('PUT', '/api/c/records/recurring/e2', { ...ex, ...bad })).status, 400, JSON.stringify(bad));
  }
  const dep = { ...ex, kind: 'deposit', name: 'Tenant rent', lines: [{ account: 'a4100', amount: 1500, taxCode: 'none' }] };
  assert.equal((await call('PUT', '/api/c/records/recurring/d1', dep)).status, 200);
  const tf = { ...sched, kind: 'transfer', name: 'To savings', from: 'a1000', to: 'sav', amount: 250.555, lines: [{ junk: 1 }] };
  assert.equal((await call('PUT', '/api/c/records/recurring/t1', tf)).status, 200);
  const t1 = (await call('GET', '/api/c/state')).json.recurring.find(r => r.id === 't1');
  assert.equal(t1.amount, 250.56); assert.equal(t1.lines, undefined);
  for (const bad of [{ to: 'a1000' }, { amount: 0 }, { from: 'a6000' }, { to: 'usd' }]) {
    assert.equal((await call('PUT', '/api/c/records/recurring/t2', { ...tf, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('DELETE', '/api/c/records/accounts/sav')).status, 409, 'transfer account used by a template');
  // Invoices and bills still need their customer or vendor.
  assert.equal((await call('PUT', '/api/c/records/recurring/b1', { ...sched, kind: 'bill', name: 'Rent', contactId: '', lines: [{ account: 'a6600', qty: 1, rate: 10 }] })).status, 400);
});

test('an entry made from a template is made once per date, and not in a closed period', async () => {
  const entry = { type: 'journal', date: '2026-09-30', memo: 'Accrued wages', recurringId: 'j1', recurringNew: true, lines: [{ account: 'a6000', debit: 1200, credit: 0 }, { account: 'a2000', debit: 0, credit: 1200 }] };
  const w = { op: 'set', collection: 'entries', id: 'rc_j1_2026-09-30', data: entry };
  assert.equal((await call('POST', '/api/c/batch', { writes: [w] })).status, 200);
  const made = (await call('GET', '/api/c/state')).json.entries.find(e => e.id === 'rc_j1_2026-09-30');
  assert.equal(made.recurringId, 'j1'); assert.equal(made.recurringNew, undefined, 'flag not stored');
  assert.equal((await call('POST', '/api/c/batch', { writes: [w] })).status, 409, 'a second window making the same date');
  // Closed through September: a date in it can't be made.
  assert.equal((await call('PUT', '/api/c/closing', { date: '2026-09-30' })).status, 200);
  const closed = await call('POST', '/api/c/batch', { writes: [{ ...w, id: 'rc_j1_2026-08-31', data: { ...entry, date: '2026-08-31' } }] });
  assert.equal(closed.status, 423);
});
