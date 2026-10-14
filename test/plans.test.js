'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// Seed, Grow and Thrive; the Payroll add-on (a base fee plus each employee paid in a month); moving firms over from Essentials and Plus.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('../public/plans.js');
const L = require('../src/server/licence');
const { Billing, recordOf } = require('../src/server/billing');
const { createApp } = require('../src/server/app');

/* ---------- the plans themselves ---------- */
test('plans: Seed has no extras, Grow adds bank feeds and the rest, Thrive has everything; prices and French names', () => {
  assert.deepEqual(Object.keys(P.PLANS), ['seed', 'grow', 'thrive']);
  assert.deepEqual([P.PLANS.seed.cents, P.PLANS.grow.cents, P.PLANS.thrive.cents], [1800, 4000, 5500]);
  assert.deepEqual([P.planLabel('seed', 'fr'), P.planLabel('grow', 'fr'), P.planLabel('thrive', 'fr'), P.planLabel('grow')], ['Semis', 'Croissance', 'Prospérité', 'Grow']);
  for (const k of Object.keys(P.FEATURES)) assert.equal(P.inPlan('seed', k), false, `${k} isn’t in Seed`);
  for (const k of ['bankFeeds', 'ai', 'advancedReports', 'projects', 'fixedAssets', 'specialTax', 'budgets']) assert.ok(P.inPlan('grow', k) && P.inPlan('thrive', k), k);
  for (const k of ['inventory', 'multiCurrency', 'classes', 'customRoles', 'billApprovals', 'emailReceipts', 'cashForecast', 'payroll']) assert.ok(!P.inPlan('grow', k) && P.inPlan('thrive', k), k);
  for (const k of Object.keys(P.FEATURES)) assert.ok(P.inPlan('thrive', k), `Thrive has ${k}`);
  assert.deepEqual([P.planFor('bankFeeds'), P.planFor('classes'), P.planFor('payroll')], ['grow', 'thrive', 'thrive']);
  // Old names and unknown plans.
  assert.deepEqual([P.planOf('essentials'), P.planOf('plus'), P.planOf(undefined), P.planOf('gold')], ['seed', 'thrive', 'thrive', 'thrive']);
  assert.ok(P.inPlan('plus', 'payroll') && !P.inPlan('essentials', 'payroll'));
});

test('plans: payroll comes with Thrive, or with the add-on on Seed and Grow; a company can still switch it off', () => {
  assert.equal(P.hasFeature('seed', 'payroll'), false);
  assert.equal(P.hasFeature('seed', 'payroll', { payroll: true }), true);
  assert.equal(P.hasFeature('grow', 'payroll', { payroll: true }), true);
  assert.equal(P.hasFeature('grow', 'inventory', { payroll: true }), false, 'the add-on brings payroll only');
  assert.equal(P.hasFeature('thrive', 'payroll', {}), true);
  assert.equal(P.featureOn('seed', { payroll: false }, 'payroll', { payroll: true }), false, 'switched off for this company');
  assert.equal(P.featureOn('grow', {}, 'payroll', { payroll: true }), true);
  assert.equal(P.addonIncluded('thrive', 'payroll'), true);
  assert.equal(P.addonIncluded('grow', 'payroll'), false);
  assert.equal(P.addonIncluded('thrive', 'assistant'), false);
  assert.deepEqual([P.ADDONS.payroll.cents, P.UNITS.payrollEmployees.cents], [2000, 400]);
});

test('plans: employees paid in a month are counted once each, leaving out void pay runs and other months', () => {
  const run = (payDate, ids, extra = {}) => ({ payDate, lines: ids.map(employeeId => ({ employeeId })), ...extra });
  const runs = [run('2026-09-05', ['a', 'b']), run('2026-09-19', ['a', 'c']), run('2026-09-26', ['d'], { void: true }), run('2026-09-30', ['e'], { status: 'void' }), run('2026-10-03', ['f']), run('2026-08-31', ['g']), null];
  assert.equal(P.employeesPaid(runs, '2026-09'), 3, 'a, b and c; a twice counts once');
  assert.equal(P.employeesPaid(runs, '2026-10'), 1);
  assert.equal(P.employeesPaid([], '2026-09'), 0);
  assert.deepEqual([P.prevMonth('2026-10-12'), P.prevMonth('2026-01-03'), P.prevMonth('2026-03')], ['2026-09', '2025-12', '2026-02']);
});

test('plans: Essentials moves to Seed and Plus to Thrive, each keeping its old price', () => {
  assert.deepEqual(P.migratePlan('essentials'), { plan: 'seed', legacy: 'essentials' });
  assert.deepEqual(P.migratePlan('plus'), { plan: 'thrive', legacy: 'plus' });
  assert.deepEqual(P.migratePlan('grow'), { plan: 'grow', legacy: '' });
  assert.deepEqual(P.migratePlan('thrive', 'plus'), { plan: 'thrive', legacy: 'plus' }, 'already moved: kept as it is');
  assert.equal(P.priceKey('thrive', 'plus'), 'plus');
  assert.equal(P.priceKey('thrive', ''), 'thrive');
  assert.equal(P.priceKey('plus', ''), 'thrive');
});

test('licence codes: Seed, Grow and Thrive; codes with the old names still work', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x;
  const mk = plan => L.makeCode({ id: 'x1', name: 'Maple', plan, until: '2030-01-01', issued: '2026-01-01' }, privateKey);
  assert.equal(L.readCode(mk('grow'), [pub]).plan, 'grow');
  assert.equal(L.readCode(mk('seed'), [pub]).plan, 'seed');
  assert.equal(L.readCode(mk('thrive'), [pub]).plan, 'thrive');
  assert.equal(L.readCode(mk('plus'), [pub]).plan, 'thrive', 'a code made as Plus reads as Thrive');
  assert.equal(L.readCode(mk('essentials'), [pub]).plan, 'seed');
  // Same letters as before for Seed and Thrive, so older copies of the app still read those codes.
  const letter = code => JSON.parse(Buffer.from(code.slice(4).split('.')[0], 'base64url').toString()).p;
  assert.deepEqual([letter(mk('seed')), letter(mk('grow')), letter(mk('thrive'))], ['e', 'g', 'p']);
});

/* ---------- billing: the plan's line, add-on lines, and employees charged after the month ---------- */
test('billing: checkout has the plan, the add-ons and an old price kept; employees are charged once a month', async () => {
  const calls = [];
  const ok = j => ({ ok: true, status: 200, json: async () => j });
  const sub = { id: 'sub_1', status: 'active', customer: 'cus_1', current_period_end: 1900000000, metadata: { sumlora_plan: 'thrive' }, items: { data: [{ id: 'si_plan', quantity: 3, price: { id: 'price_plus', metadata: { sumlora_plan: 'plus' } } }] } };
  const fakeFetch = async (url, o) => {
    const p = new URL(url).pathname.replace('/v1/', ''), body = Object.fromEntries(new URLSearchParams(o.body || ''));
    calls.push({ p, body });
    if (p === 'prices') return ok({ id: 'price_' + (body['metadata[sumlora_addon]'] || body['metadata[sumlora_plan]'] || body['metadata[sumlora_unit]']) });
    if (p === 'checkout/sessions') return ok({ id: 'cs_1', url: 'https://checkout.example/cs_1' });
    if (p === 'invoiceitems') return ok({ id: 'ii_1' });
    if (p === 'subscriptions/sub_1') { if (body['items[0][price]'] && body['items[0][id]']) sub.items.data[0].price = { id: body['items[0][price]'], metadata: {} }; return ok(sub); }
    return ok({});
  };
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-plans-bill-'));
  try {
    const b = new Billing(bdir, { fetch: fakeFetch });
    assert.deepEqual(['seed', 'grow', 'thrive', 'essentials', 'plus', 'payroll', 'payrollEmployees'].map(k => b.data.amounts[k]), [1800, 4000, 5500, 1500, 3000, 2000, 400]);
    b.data.key = 'sk_test_' + 'x'.repeat(24);
    await assert.rejects(b.update({ amounts: { payrollEmployees: 0 } }), /price/);
    await b.update({ amounts: { grow: 50, payrollEmployees: 5 } });
    assert.deepEqual([b.data.amounts.grow, b.data.amounts.payrollEmployees], [5000, 500]);

    await b.checkout({ kind: 'firm', id: 'f1', plan: 'grow', quantity: 4, addons: { assistant: 0, scrapyard: 0, payroll: 2 }, base: 'http://x' });
    let s = calls.filter(c => c.p === 'checkout/sessions').at(-1).body;
    assert.deepEqual([s['line_items[0][price]'], s['line_items[0][quantity]'], s['line_items[1][price]'], s['line_items[1][quantity]'], s['line_items[2][price]']], ['price_grow', '4', 'price_payroll', '2', undefined]);
    assert.equal(calls.find(c => c.p === 'prices' && c.body['metadata[sumlora_plan]'] === 'grow').body.unit_amount, '5000');
    // A firm keeping its old price pays it on its plan's line.
    await b.checkout({ kind: 'firm', id: 'f1', plan: 'thrive', legacy: 'plus', quantity: 2, base: 'http://x' });
    s = calls.filter(c => c.p === 'checkout/sessions').at(-1).body;
    assert.equal(s['line_items[0][price]'], 'price_plus'); assert.equal(s['subscription_data[metadata][sumlora_plan]'], 'thrive');
    assert.equal(calls.find(c => c.p === 'prices' && c.body['metadata[sumlora_plan]'] === 'plus').body.unit_amount, '3000');

    // Moving to the plan's price changes the plan line's price.
    let rec = recordOf(sub, 'cus_1');
    assert.equal(rec.price, 'price_plus');
    rec = await b.setPlan(rec, 'thrive', 'thrive');
    assert.equal(rec.price, 'price_thrive');
    const n = calls.length; await b.setPlan(rec, 'thrive', 'thrive'); assert.equal(calls.length, n, 'no change, no call');

    // Employees paid in September go on the next invoice, once.
    rec = await b.chargeEmployees(rec, '2026-09', 7);
    const ii = calls.filter(c => c.p === 'invoiceitems');
    assert.equal(ii.length, 1);
    assert.deepEqual([ii[0].body.customer, ii[0].body.subscription, ii[0].body.price, ii[0].body.quantity, ii[0].body['metadata[sumlora_month]']], ['cus_1', 'sub_1', 'price_payrollEmployees', '7', '2026-09']);
    assert.equal(calls.find(c => c.p === 'prices' && c.body['metadata[sumlora_unit]']).body.unit_amount, '500');
    assert.equal(calls.find(c => c.p === 'prices' && c.body['metadata[sumlora_unit]']).body['recurring[interval]'], undefined, 'a one-time price');
    assert.deepEqual([rec.employeesBilled, rec.employees], ['2026-09', { month: '2026-09', count: 7 }]);
    rec = await b.chargeEmployees(rec, '2026-09', 7);
    assert.equal(calls.filter(c => c.p === 'invoiceitems').length, 1, 'never twice for a month');
    rec = await b.chargeEmployees(rec, '2026-10', 0);
    assert.equal(calls.filter(c => c.p === 'invoiceitems').length, 1, 'nobody paid: nothing charged');
    assert.equal(rec.employeesBilled, '2026-10');
    // Reading the subscription again keeps the month charged.
    assert.equal(recordOf(sub, 'cus_1', rec).employeesBilled, '2026-10');
  } finally { fs.rmSync(bdir, { recursive: true, force: true }); }
});

/* ---------- a server: migration, gating and the add-on ---------- */
let server, base, dir;
const PW = 'correct horse battery staple';
async function req(cookie, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const start = async () => { server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false }); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; };
const emp = { name: 'Pat Payroll', prov: 'ON', freq: 'biweekly', payType: 'salary', rate: 52000, td1Fed: '' };
let admin, owner, oldFirm, oldCo, plainCo, plusFirm;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-plans-'));
  await start();
  admin = (await req(null, 'POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Books' })).cookie;
  await req(admin, 'PUT', '/api/firms/settings', { signups: 'open' });
  owner = (await req(null, 'POST', '/api/auth/signup', { firmName: 'Old Firm', name: 'Ana', username: 'ana@old.example', password: PW, acceptTerms: true })).cookie;
  await req(null, 'POST', '/api/auth/signup', { firmName: 'Plus Firm', name: 'Bo', username: 'bo@plus.example', password: PW, acceptTerms: true });
  oldCo = (await req(owner, 'POST', '/api/companies', { name: 'Has Payroll', province: 'ON' })).json.company.id;
  plainCo = (await req(owner, 'POST', '/api/companies', { name: 'No Payroll', province: 'ON' })).json.company.id;
  // Write books as they were before Seed, Grow and Thrive: an employee on Has Payroll, firms on the old plans.
  server.registry.store(oldCo).put('employees', 'e1', { ...emp, active: true });
  const users = path.join(dir, 'users.json'), comps = path.join(dir, 'companies.json');
  await server.shutdown();
  const u = JSON.parse(fs.readFileSync(users, 'utf8'));
  oldFirm = u.firms.find(f => f.name === 'Old Firm').id; plusFirm = u.firms.find(f => f.name === 'Plus Firm').id;
  for (const f of u.firms) f.plan = f.name === 'Old Firm' ? 'essentials' : f.name === 'Plus Firm' ? 'plus' : 'plus';
  u.settings.defaultPlan = 'essentials';
  fs.writeFileSync(users, JSON.stringify(u));
  const c = JSON.parse(fs.readFileSync(comps, 'utf8'));
  delete c.payrollAddonDone; for (const x of c.companies) delete x.payroll;
  fs.writeFileSync(comps, JSON.stringify(c));
  await start();
  admin = (await req(null, 'POST', '/api/auth/login', { username: 'sher@example.com', password: PW })).cookie;
  owner = (await req(null, 'POST', '/api/auth/login', { username: 'ana@old.example', password: PW })).cookie;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('migration: Essentials → Seed and Plus → Thrive with their old price; companies with payroll get the add-on', async () => {
  const firms = (await req(admin, 'GET', '/api/firms')).json;
  const of = id => firms.firms.find(f => f.id === id);
  assert.deepEqual([of(oldFirm).plan, of(oldFirm).legacy], ['seed', 'essentials']);
  assert.deepEqual([of(plusFirm).plan, of(plusFirm).legacy], ['thrive', 'plus']);
  assert.deepEqual([of(firms.myFirm).plan, of(firms.myFirm).legacy], ['thrive', ''], 'the administrator’s own firm doesn’t pay, so no old price');
  assert.equal(firms.defaultPlan, 'seed');
  assert.equal(of(oldFirm).payrollCompanies, 1);
  assert.equal(server.registry.get(oldCo).payroll, true, 'had an employee: Payroll add-on on');
  assert.ok(!server.registry.get(plainCo).payroll);
  // Payroll keeps working on Seed through the add-on.
  const st = (await req(owner, 'GET', `/api/c/${oldCo}/state`)).json;
  assert.deepEqual([st.addons.payroll, st.featureAddons.payroll], [true, true]);
  assert.equal((await req(owner, 'PUT', `/api/c/${oldCo}/records/employees/e2`, { ...emp, name: 'Sam' })).status, 200);
  assert.equal((await req(owner, 'GET', '/api/auth/me')).json.user.firmPlan, 'seed');
});

test('gating: Seed refuses payroll without the add-on, new bank connections, budgets and new classes; existing classes still work', async () => {
  let r = await req(owner, 'PUT', `/api/c/${plainCo}/records/employees/e1`, emp);
  assert.equal(r.status, 403); assert.match(r.json.error, /Payroll add-on/);
  // Bank feeds: a new connection needs Grow (the plan is checked before Plaid is even asked).
  r = await req(owner, 'POST', `/api/c/${plainCo}/feeds/link`, {});
  assert.equal(r.status, 403); assert.match(r.json.error, /Automatic bank feeds isn’t part/);
  assert.equal((await req(owner, 'POST', `/api/c/${plainCo}/feeds`, { publicToken: 'public-sandbox-x' })).status, 403);
  const feeds = (await req(owner, 'GET', `/api/c/${plainCo}/feeds`)).json;
  assert.deepEqual([feeds.canConnect, feeds.inPlan], [false, false]);
  // Budgets.
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/records/budgets/b1`, { name: 'FY', start: '2026-01-01', amounts: {} })).status, 403);
  // Classes: none can be made on Seed…
  const s0 = (await req(owner, 'GET', `/api/c/${plainCo}/state`)).json.company;
  r = await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s0, classes: [{ id: 'k1', name: 'Ottawa' }] });
  assert.equal(r.status, 403); assert.match(r.json.error, /Classes isn’t part/);
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s0, classPerLine: true })).status, 403);
  // …but classes made before stay: renamed, turned off, and picked on transactions.
  const store = server.registry.store(plainCo);
  store.putSetting('company', { ...store.getSetting('company'), classes: [{ id: 'k1', name: 'Ottawa', active: true }, { id: 'k2', name: 'Toronto', active: true }] });
  const s1 = (await req(owner, 'GET', `/api/c/${plainCo}/state`)).json.company;
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s1, classes: [{ id: 'k1', name: 'Ottawa office', active: true }, { id: 'k2', name: 'Toronto', active: false }] })).status, 200);
  const acc = (await req(owner, 'GET', `/api/c/${plainCo}/state`)).json.accounts;
  const bank = acc.find(a => a.detail === 'bank'), exp = acc.find(a => a.type === 'Expense');
  r = await req(owner, 'PUT', `/api/c/${plainCo}/records/entries/j1`, { type: 'journal', date: '2026-10-01', cls: 'k1', lines: [{ account: exp.id, debit: 10, credit: 0 }, { account: bank.id, debit: 0, credit: 10 }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Grow opens bank feeds and budgets but not classes; Thrive opens classes.
  await req(admin, 'PUT', `/api/firms/${oldFirm}`, { plan: 'grow' });
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/records/budgets/b1`, { name: 'FY', start: '2026-01-01', amounts: {} })).status, 200);
  assert.equal((await req(owner, 'GET', `/api/c/${plainCo}/feeds`)).json.canConnect, true);
  r = await req(owner, 'POST', `/api/c/${plainCo}/feeds/link`, {});
  assert.notEqual(r.status, 403, 'past the plan check (Plaid isn’t set up in this test)');
  const s2 = (await req(owner, 'GET', `/api/c/${plainCo}/state`)).json.company;
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s2, classes: [...s2.classes, { id: 'k3', name: 'Kingston' }] })).status, 403);
  await req(admin, 'PUT', `/api/firms/${oldFirm}`, { plan: 'thrive' });
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s2, classes: [...s2.classes, { id: 'k3', name: 'Kingston' }], classPerLine: true })).status, 200);
});

test('gating this batch: delayed charges on every plan; workflows need Thrive; payroll settings and pay stub emails need payroll', async () => {
  await req(admin, 'PUT', `/api/firms/${oldFirm}`, { plan: 'seed' });
  const s = (await req(owner, 'GET', `/api/c/${plainCo}/state`)).json;
  const income = s.accounts.find(a => a.type === 'Income');
  const cust = await req(owner, 'PUT', `/api/c/${plainCo}/records/contacts/c1`, { kind: 'customer', name: 'Client' });
  assert.equal(cust.status, 200);
  let r = await req(owner, 'PUT', `/api/c/${plainCo}/records/delayed/d1`, { kind: 'charge', date: '2026-09-02', contactId: 'c1', lines: [{ desc: 'Visit', account: income.id, qty: 1, rate: 50, taxCode: 'none' }] });
  assert.equal(r.status, 200, 'delayed charges are in Seed: ' + JSON.stringify(r.json));
  r = await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s.company, workflows: { rules: { billDue: { on: true, days: 3 } } } });
  assert.equal(r.status, 403); assert.match(r.json.error, /Workflow reminders isn’t part/);
  assert.equal((await req(owner, 'POST', `/api/c/${plainCo}/workflows/check`, {})).status, 403);
  // Payroll settings (overtime, EHT, WSIB, Revenu Québec frequency, stub emails) need payroll; other settings still save.
  for (const payroll of [{ otThreshold: 40 }, { remitFreq: 'accel1' }, { remitFreqRq: 'quarterly' }, { wsib: { on: true, groups: [{ id: 'g1', rate: 1 }] } }, { eht: { eligible: false } }, { stubMail: { en: { subject: 'Pay', text: '' } } }]) {
    r = await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s.company, payroll });
    assert.equal(r.status, 403, JSON.stringify(payroll)); assert.match(r.json.error, /Payroll add-on/);
  }
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s.company, phone: '613-555-0000' })).status, 200, 'saving other settings keeps the payroll defaults');
  // The pay stub email checks payroll before anything else about the stub.
  r = await req(owner, 'POST', `/api/c/${plainCo}/mail/send`, { to: 'a@example.com', subject: 'x', text: 'x', what: 'paystub', payrunId: 'r1', employeeId: 'e1' });
  assert.ok([403, 409].includes(r.status), 'refused: ' + r.status);
  // With the add-on on, payroll settings save.
  server.registry.update(plainCo, { payroll: true });
  r = await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s.company, payroll: { otThreshold: 40, remitFreq: 'accel1' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  server.registry.update(plainCo, { payroll: false });
  await req(admin, 'PUT', `/api/firms/${oldFirm}`, { plan: 'thrive' });
  r = await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...(await req(owner, 'GET', `/api/c/${plainCo}/state`)).json.company, workflows: { rules: { billDue: { on: true, days: 3 } } } });
  assert.equal(r.status, 200, 'Thrive has workflows');
});

test('firms page: choosing a plan ends the old price; payroll billing for an old-price firm is the administrator’s choice', async () => {
  let f = (await req(admin, 'GET', '/api/firms')).json.firms.find(x => x.id === plusFirm);
  assert.equal(f.legacy, 'plus');
  assert.equal((await req(admin, 'PUT', `/api/firms/${plusFirm}`, { legacy: 'essentials' })).status, 400, 'an old price can’t be given back');
  assert.equal((await req(admin, 'PUT', `/api/firms/${plusFirm}`, { billPayroll: true })).status, 200);
  f = (await req(admin, 'GET', '/api/firms')).json.firms.find(x => x.id === plusFirm);
  assert.deepEqual([f.billPayroll, f.legacy], [true, 'plus']);
  assert.equal((await req(admin, 'PUT', `/api/firms/${plusFirm}`, { legacy: '' })).status, 200);
  f = (await req(admin, 'GET', '/api/firms')).json.firms.find(x => x.id === plusFirm);
  assert.deepEqual([f.plan, f.legacy], ['thrive', '']);
  // Old plan names are still understood.
  assert.equal((await req(admin, 'PUT', `/api/firms/${plusFirm}`, { plan: 'essentials' })).status, 200);
  f = (await req(admin, 'GET', '/api/firms')).json.firms.find(x => x.id === plusFirm);
  assert.deepEqual([f.plan, f.legacy], ['seed', ''], 'a plan chosen now is at its own price');
  assert.equal((await req(admin, 'PUT', `/api/firms/${plusFirm}`, { plan: 'gold' })).status, 400);
});

test('payroll add-on: an owner turns it on for a Seed or Grow company; only owners', async () => {
  await req(admin, 'PUT', `/api/firms/${oldFirm}`, { plan: 'seed' });
  const staffLink = (await req(owner, 'POST', '/api/users', { name: 'Stu', username: 'stu@old.example', role: 'staff', companies: [plainCo], password: PW })).json;
  assert.ok(staffLink.user);
  const staff = (await req(null, 'POST', '/api/auth/login', { username: 'stu@old.example', password: PW })).cookie;
  assert.equal((await req(staff, 'PUT', `/api/companies/${plainCo}`, { payroll: true })).status, 403, 'staff can’t buy add-ons');
  assert.equal((await req(owner, 'PUT', `/api/companies/${plainCo}`, { payroll: true })).status, 200);
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/records/employees/e1`, emp)).status, 200);
  // Switched off in Settings → Features: refused again, records kept.
  const s = (await req(owner, 'GET', `/api/c/${plainCo}/state`)).json.company;
  await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s, features: { payroll: false } });
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/records/employees/e3`, emp)).status, 403);
  await req(owner, 'PUT', `/api/c/${plainCo}/settings`, { ...s, features: {} });
  // Removing the add-on hides payroll and keeps the employee.
  assert.equal((await req(owner, 'PUT', `/api/companies/${plainCo}`, { payroll: false })).status, 200);
  assert.equal((await req(owner, 'PUT', `/api/c/${plainCo}/records/employees/e3`, emp)).status, 403);
  assert.ok((await req(owner, 'GET', `/api/c/${plainCo}/state`)).json.employees.some(e => e.id === 'e1'));
});

test('monthly invoicing: each firm’s price (old or new), add-ons billed only when due, and employees paid last month', async () => {
  // Has Payroll pays an employee last month; the firm keeps its old price, so payroll isn't billed until the administrator says so.
  const lastMonth = P.prevMonth(new Date().toISOString().slice(0, 10));
  server.registry.store(oldCo).put('payruns', 'r1', { payDate: lastMonth + '-15', lines: [{ employeeId: 'e1' }, { employeeId: 'e2' }] });
  server.registry.store(oldCo).put('payruns', 'r2', { payDate: lastMonth + '-28', lines: [{ employeeId: 'e1' }], void: true });
  const u = server.auth.data.firms.find(f => f.id === oldFirm); u.legacy = 'essentials'; u.billPayroll = false;
  let cu = (await req(admin, 'GET', '/api/invoicing')).json.customers.find(c => c.key === 'firm:' + oldFirm);
  assert.deepEqual([cu.plan, cu.priceKey, cu.addons.payroll, cu.employees, cu.employeesMonth], ['seed', 'essentials', 0, 0, lastMonth], 'kept free on the old price');
  await req(admin, 'PUT', `/api/firms/${oldFirm}`, { billPayroll: true });
  cu = (await req(admin, 'GET', '/api/invoicing')).json.customers.find(c => c.key === 'firm:' + oldFirm);
  assert.deepEqual([cu.addons.payroll, cu.employees], [1, 2], 'one company with the add-on; two employees paid (the void run left out)');
  // On Thrive the base fee is included; employees are still billed.
  await req(admin, 'PUT', `/api/firms/${oldFirm}`, { plan: 'thrive' });
  cu = (await req(admin, 'GET', '/api/invoicing')).json.customers.find(c => c.key === 'firm:' + oldFirm);
  assert.deepEqual([cu.priceKey, cu.addons.payroll, cu.employees], ['thrive', 0, 2]);
});

test('Stripe: the twice-daily check charges last month’s employees once, and never during a trial', async () => {
  const calls = [];
  const ok = j => ({ ok: true, status: 200, json: async () => j });
  await server.shutdown();
  const fakeStripe = async (url, o) => {
    const p = new URL(url).pathname.replace('/v1/', ''), body = Object.fromEntries(new URLSearchParams(o.body || ''));
    calls.push({ p, body });
    if (p === 'prices') return ok({ id: 'price_' + calls.length, data: [] });
    if (p === 'invoiceitems') return ok({ id: 'ii' });
    return ok({ data: [] });
  };
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, billingFetch: fakeStripe });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await req(null, 'POST', '/api/auth/login', { username: 'sher@example.com', password: PW })).cookie;
  assert.equal((await req(admin, 'PUT', '/api/billing', { key: 'sk_test_' + 'q'.repeat(24) })).status, 200);
  const f = server.auth.data.firms.find(x => x.id === oldFirm);
  const now = new Date(), month = P.prevMonth(now.toISOString().slice(0, 10));
  f.billing = { customer: 'cus_9', sub: 'sub_9', item: 'si_9', quantity: 2, status: 'active', checked: Date.now(), addons: {}, employeesBilled: '' };
  await server.chargePayrollEmployees(now);
  let ii = calls.filter(c => c.p === 'invoiceitems');
  assert.equal(ii.length, 1); assert.equal(ii[0].body.quantity, '2'); assert.equal(ii[0].body.subscription, 'sub_9');
  assert.equal(server.auth.firm(oldFirm).billing.employeesBilled, month);
  await server.chargePayrollEmployees(now);
  assert.equal(calls.filter(c => c.p === 'invoiceitems').length, 1, 'once a month');
  // A subscription from before this charge existed starts counting next month; a trial doesn't pay.
  const fresh = { customer: 'cus_9', sub: 'sub_9', item: 'si_9', quantity: 2, status: 'trialing', checked: Date.now(), addons: {} };
  server.auth.setFirmBilling(oldFirm, { ...fresh });
  await server.chargePayrollEmployees(now);
  assert.equal(server.auth.firm(oldFirm).billing.employeesBilled, month);
  server.auth.setFirmBilling(oldFirm, { ...fresh, employeesBilled: '' });
  await server.chargePayrollEmployees(now);
  ii = calls.filter(c => c.p === 'invoiceitems');
  assert.equal(ii.length, 1, 'trial: nothing charged');
  assert.deepEqual(server.auth.firm(oldFirm).billing.employees, { month, count: 0 });
});
