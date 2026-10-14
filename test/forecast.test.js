'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// Cash flow forecast: the arithmetic (forecast.js) and the server's checks on its settings (planned items, plan).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('../public/forecast.js');
const PLANS = require('../public/plans.js');
const { createApp } = require('../src/server/app');

const today = '2026-10-12', W30 = { today, end: '2026-11-11' };

test('invoices and bills count on their due date; past the window is left out', () => {
  const docs = [
    { key: 'inv:1', kind: 'invoice', due: '2026-10-20', amount: 1000 },
    { key: 'bill:1', kind: 'bill', due: '2026-10-25', amount: 400 },
    { key: 'inv:2', kind: 'invoice', due: '2026-12-01', amount: 999 }, // after 30 days
    { key: 'inv:3', kind: 'invoice', due: '2026-10-15', amount: 0 }, // paid
  ];
  const out = F.docItems(docs, W30);
  assert.deepEqual(out.map(x => [x.key, x.date, x.amount]), [['inv:1', '2026-10-20', 1000], ['bill:1', '2026-10-25', -400]]);
  // Over 60 days, the December invoice comes in.
  assert.equal(F.docItems(docs, { today, end: '2026-12-11' }).length, 3);
});

test('overdue invoices: expected within 7 days, or left out; overdue bills are paid now', () => {
  const docs = [{ key: 'inv:old', kind: 'invoice', due: '2026-09-01', amount: 500 }, { key: 'bill:old', kind: 'bill', due: '2026-09-15', amount: 200 }];
  const week = F.docItems(docs, { ...W30, overdue: 'week' });
  assert.deepEqual(week.map(x => [x.key, x.date, x.amount, x.note]), [['inv:old', '2026-10-19', 500, 'overdue'], ['bill:old', today, -200, 'overdue']]);
  const skip = F.docItems(docs, { ...W30, overdue: 'skip' });
  assert.deepEqual(skip.map(x => x.key), ['bill:old'], 'the toggle only drops invoices');
});

test('a customer’s average days late moves their invoices later', () => {
  const late = F.averageLate([
    { contactId: 'c1', due: '2026-06-01', paid: '2026-06-11' }, { contactId: 'c1', due: '2026-07-01', paid: '2026-07-21' },
    { contactId: 'c2', due: '2026-07-01', paid: '2026-06-25' }, // early: 0, so no entry
  ]);
  assert.deepEqual(late, { c1: 15 });
  const out = F.docItems([{ key: 'i', kind: 'invoice', contactId: 'c1', due: '2026-10-20', amount: 100 }], { ...W30, lateDays: late });
  assert.deepEqual([out[0].date, out[0].note], ['2026-11-04', 'late']);
});

test('recurring items: only the dates inside the window, ended and paused ones skipped', () => {
  const list = [
    { id: 'rent', label: 'Rent', amount: -2000, every: 'month', n: 1, day: 1, next: '2026-11-01' },
    { id: 'wk', label: 'Weekly', amount: 100, every: 'week', n: 1, next: '2026-10-14' },
    { id: 'end', label: 'Ended', amount: -50, every: 'week', n: 1, next: '2026-10-13', end: '2026-10-20' },
    { id: 'off', label: 'Paused', amount: -50, every: 'week', n: 1, next: '2026-10-13', active: false },
    { id: 'yr', label: 'Yearly', amount: -900, every: 'year', n: 1, next: '2027-01-15' },
    { id: 'inv', label: 'Retainer', amount: 1500, lag: 30, every: 'month', n: 1, day: 15, next: '2026-10-15' }, // paid Nov 14: out
    { id: 'due', label: 'Waiting', amount: -10, every: 'month', n: 1, day: 1, next: '2026-10-01' }, // waiting for review
  ];
  const out = F.recurringItems(list, W30);
  const by = id => out.filter(x => x.key.startsWith(`rec:${id}:`)).map(x => x.date);
  assert.deepEqual(by('rent'), ['2026-11-01']);
  assert.deepEqual(by('wk'), ['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04', '2026-11-11']);
  assert.deepEqual(by('end'), ['2026-10-13', '2026-10-20']);
  assert.deepEqual(by('off'), []);
  assert.deepEqual(by('yr'), []);
  assert.deepEqual(by('inv'), [], 'invoice paid after the window');
  assert.deepEqual(by('due'), [today, '2026-11-01'], 'a past date counts as today');
  // Month-end stays month-end (recurring-calc's schedule).
  assert.deepEqual(F.recurringItems([{ id: 'me', amount: -1, every: 'month', n: 1, day: 31, next: '2026-10-31' }], { today, end: '2027-01-10' }).map(x => x.date), ['2026-10-31', '2026-11-30', '2026-12-31']);
});

test('payroll: next pay runs from the last one, and their source deductions on the 15th', () => {
  assert.equal(F.nextPayDate('biweekly', '2026-10-09'), '2026-10-23');
  assert.equal(F.nextPayDate('weekly', '2026-10-09'), '2026-10-16');
  assert.equal(F.nextPayDate('monthly', '2026-09-30'), '2026-10-31');
  assert.equal(F.nextPayDate('monthly', '2026-12-31'), '2027-01-31');
  assert.equal(F.nextPayDate('semimonthly', '2026-10-15'), '2026-10-31');
  assert.equal(F.nextPayDate('semimonthly', '2026-10-31'), '2026-11-15');
  assert.equal(F.nextPayDate('semimonthly', '2026-12-31'), '2027-01-15');
  const out = F.payrollItems({
    schedules: [{ freq: 'biweekly', last: { payDate: '2026-10-09', net: 3000, cra: 1200, rq: 0 } }],
    unpaid: [{ agency: 'cra', key: '2026-10', due: '2026-11-15', amount: 1200 }, { agency: 'cra', key: '2026-09', due: '2026-10-15', amount: 800 }],
    today, end: '2026-12-11',
  });
  const pays = out.filter(x => x.source === 'payroll').map(x => [x.date, x.amount]);
  assert.deepEqual(pays, [['2026-10-23', -3000], ['2026-11-06', -3000], ['2026-11-20', -3000], ['2026-12-04', -3000]]);
  const rem = out.filter(x => x.source === 'remit').map(x => [x.date, x.amount, x.period, !!x.est]);
  // Owed already: September's and October's (from the last run). Estimated: October 23's run, due Nov 15.
  // November's runs are due Dec 15, after the window.
  assert.deepEqual(rem.sort((a, b) => a[0].localeCompare(b[0]) || a[3] - b[3]), [['2026-10-15', -800, '2026-09', false], ['2026-11-15', -1200, '2026-10', false], ['2026-11-15', -1200, '2026-10', true]]);
  // A schedule that stopped months ago isn't estimated.
  assert.deepEqual(F.payrollItems({ schedules: [{ freq: 'weekly', last: { payDate: '2026-05-01', net: 100, cra: 10 } }], today, end: '2026-11-11' }), []);
  // Quarterly remitters: due the 15th after the quarter.
  assert.deepEqual(F.remitPeriod('2026-11-06', 'quarterly'), { key: '2026-Q4', due: '2027-01-15' });
});

test('sales tax: owing is money out on the due date, a refund money in', () => {
  const out = F.taxItems([
    { key: 't1', tax: 'gst', from: '2026-07-01', to: '2026-09-30', due: '2026-10-31', amount: 2500 },
    { key: 't2', tax: 'qst', from: '2026-07-01', to: '2026-09-30', due: '2026-10-31', amount: -300 },
    { key: 't3', tax: 'gst', from: '2026-04-01', to: '2026-06-30', due: '2026-07-31', amount: 100 }, // overdue: today
    { key: 't4', tax: 'gst', from: '2026-10-01', to: '2026-12-31', due: '2027-01-31', amount: 900 },
  ], W30);
  assert.deepEqual(out.map(x => [x.key, x.date, x.amount]), [['t1', '2026-10-31', -2500], ['t2', '2026-10-31', 300], ['t3', today, -100]]);
});

test('planned items: once or repeating, from today on, until their end date', () => {
  const out = F.plannedItems([
    { id: 'loan', name: 'Loan', dir: 'in', amount: 20000, date: '2026-10-20', every: 'once' },
    { id: 'old', name: 'Past', dir: 'in', amount: 5, date: '2026-10-01', every: 'once' },
    { id: 'lease', name: 'Lease', dir: 'out', amount: 750, date: '2026-09-15', every: 'month', n: 1 },
    { id: 'bi', name: 'Cleaner', dir: 'out', amount: 80, date: '2026-10-13', every: 'week', n: 2, end: '2026-11-01' },
  ], W30);
  const by = id => out.filter(x => x.planId === id).map(x => [x.date, x.amount]);
  assert.deepEqual(by('loan'), [['2026-10-20', 20000]]);
  assert.deepEqual(by('old'), []);
  assert.deepEqual(by('lease'), [['2026-10-15', -750]], 'a repeating plan that started earlier continues');
  assert.deepEqual(by('bi'), [['2026-10-13', -80], ['2026-10-27', -80]]);
});

test('the projection: daily balance, weeks, lowest point, below zero, and lines left out', () => {
  const items = [
    { key: 'a', date: '2026-10-14', amount: -1500, source: 'bill' },
    { key: 'b', date: '2026-10-20', amount: 2000, source: 'invoice' },
    { key: 'c', date: '2026-10-14', amount: -100, source: 'planned' },
    { key: 'late', date: '2026-12-01', amount: 5, source: 'invoice' }, // outside 30 days
  ];
  const p = F.project({ start: 1000, items, today, days: 30 });
  assert.equal(p.daily.length, 31);
  assert.equal(p.daily[0].balance, 1000);
  assert.deepEqual(p.low, { date: '2026-10-14', balance: -600 });
  assert.equal(p.below, '2026-10-14');
  assert.equal(p.daily[30].balance, 1400);
  assert.deepEqual([p.totalIn, p.totalOut], [2000, 1600]);
  assert.equal(p.weeks.length, 5);
  assert.deepEqual([p.weeks[0].from, p.weeks[0].to, p.weeks[0].in, p.weeks[0].out, p.weeks[0].end], [today, '2026-10-18', 0, 1600, -600]);
  assert.deepEqual([p.weeks[1].in, p.weeks[1].end], [2000, 1400]);
  assert.equal(p.weeks[4].to, '2026-11-11', 'the last week stops at the window');
  assert.ok(!p.items.some(x => x.key === 'late'));
  // Unticking the bill: never below zero; the line stays in the list, marked off.
  const q = F.project({ start: 1000, items, today, days: 30, off: ['a'] });
  assert.equal(q.below, '');
  assert.deepEqual(q.low, { date: '2026-10-14', balance: 900 });
  assert.equal(q.items.find(x => x.key === 'a').off, true);
  assert.equal(q.weeks[0].out, 100);
  // A bad window falls back to 30 days; 90 days has 13 weeks and a bit.
  assert.equal(F.project({ start: 0, items: [], today, days: 45 }).days, 30);
  assert.equal(F.project({ start: 0, items: [], today, days: 90 }).weeks.length, 13);
  // With nothing coming, the lowest point is today.
  assert.deepEqual(F.project({ start: 50, items: [], today }).low, { date: today, balance: 50 });
});

test('the cash flow forecast is a Plus feature', () => {
  assert.ok(PLANS.FEATURES.cashForecast);
  assert.equal(PLANS.inPlan('plus', 'cashForecast'), true);
  assert.equal(PLANS.inPlan('essentials', 'cashForecast'), false);
});

/* ---------- the server ---------- */
let server, base, dir, co, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-fc-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Forecast Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const company = async () => (await call('GET', '/api/c/state')).json.company;
const plan = { id: 'p1', name: 'Equipment loan', dir: 'in', amount: 20000.004, date: '2026-10-20', every: 'once', junk: 'x' };

test('planned items are checked and cleaned; unknown fields are dropped', async () => {
  const c = await company();
  const ok = await call('PUT', '/api/c/settings', { ...c, cashForecast: { days: 60, overdue: 'skip', late: 1, planned: [plan, { id: 'p2', name: 'Lease', dir: 'out', amount: 750, date: '2026-09-15', every: 'month', n: 2, end: '2027-09-15' }], off: ['inv:abc', 'bad key!', 'inv:abc'], extra: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const f = (await company()).cashForecast;
  assert.deepEqual([f.days, f.overdue, f.late, f.cards, f.off, f.extra], [60, 'skip', true, false, ['inv:abc'], undefined]);
  assert.deepEqual(f.planned[0], { id: 'p1', name: 'Equipment loan', dir: 'in', amount: 20000, date: '2026-10-20', every: 'once' });
  assert.deepEqual(f.planned[1], { id: 'p2', name: 'Lease', dir: 'out', amount: 750, date: '2026-09-15', every: 'month', n: 2, end: '2027-09-15' });
  for (const bad of [{ name: '' }, { dir: 'sideways' }, { amount: 0 }, { amount: -5 }, { date: '2026-13-01' }, { id: '' }, { id: 'a b' }, { every: 'month', n: 13 }, { every: 'week', n: 1.5 }, { every: 'month', end: '2026-01-01' }]) {
    const r = await call('PUT', '/api/c/settings', { ...c, cashForecast: { planned: [{ ...plan, ...bad }] } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('PUT', '/api/c/settings', { ...c, cashForecast: { planned: [plan, plan] } })).status, 400, 'the same id twice');
  assert.equal((await call('PUT', '/api/c/settings', { ...c, cashForecast: { planned: Array.from({ length: 101 }, (_, i) => ({ ...plan, id: 'p' + i })) } })).status, 400, 'too many');
  // A bad window or overdue choice falls back to the defaults.
  await call('PUT', '/api/c/settings', { ...(await company()), cashForecast: { ...f, days: 45, overdue: 'maybe' } });
  assert.deepEqual([(await company()).cashForecast.days, (await company()).cashForecast.overdue], [30, 'week']);
});

test('without the plan, the forecast’s settings can’t be changed; other settings still save', async () => {
  const firms = (await call('GET', '/api/firms')).json;
  assert.equal((await call('PUT', `/api/firms/${firms.myFirm}`, { plan: 'essentials' })).status, 200);
  const c = await company();
  const r = await call('PUT', '/api/c/settings', { ...c, cashForecast: { ...c.cashForecast, planned: [] } });
  assert.equal(r.status, 403); assert.match(r.json.error, /Cash flow forecast/);
  assert.equal((await call('PUT', '/api/c/settings', { ...c, phone: '613-555-0100' })).status, 200, 'saving other settings keeps the forecast as it was');
  assert.equal((await company()).cashForecast.planned.length, 2);
  await call('PUT', `/api/firms/${firms.myFirm}`, { plan: 'plus' });
  // Switched off for the company: refused the same way.
  await call('PUT', '/api/c/settings', { ...(await company()), features: { cashForecast: false } });
  const c2 = await company();
  assert.equal((await call('PUT', '/api/c/settings', { ...c2, cashForecast: { ...c2.cashForecast, days: 90 } })).status, 403);
  await call('PUT', '/api/c/settings', { ...c2, features: {} });
  assert.equal((await call('PUT', '/api/c/settings', { ...(await company()), cashForecast: { ...c2.cashForecast, days: 90 } })).status, 200);
});
