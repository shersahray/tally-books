'use strict';
// Deposits on estimates: the shared sums (deposits-calc.js) and the server's rules, with a stand-in for Stripe.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DEP = require('../public/deposits-calc.js');
const { createApp } = require('../src/server/app');

test('deposits-calc: requested, received, used, refunded and held', () => {
  assert.equal(DEP.requested({ total: 1130, deposit: { kind: 'percent', value: 25 } }), 282.5);
  assert.equal(DEP.requested({ total: 1130, deposit: { kind: 'amount', value: 500 } }), 500);
  assert.equal(DEP.requested({ total: 1130 }), 0);
  const entries = [
    { id: 'a', type: 'custdeposit', estimateId: 'e1', amount: 300, date: '2026-09-01' },
    { id: 'b', type: 'custdeposit', estimateId: 'e1', amount: 200, date: '2026-09-02' },
    { id: 'c', type: 'depapply', estimateId: 'e1', amount: 350, date: '2026-09-10' },
    { id: 'd', type: 'deprefund', estimateId: 'e1', amount: 50, date: '2026-09-11' },
    { id: 'x', type: 'payment', estimateId: 'e1', amount: 999 }, // not a deposit
    { id: 'y', type: 'custdeposit', estimateId: 'e2', amount: 40, date: '2026-09-01' },
  ];
  const s = DEP.forEstimate('e1', entries);
  assert.deepEqual([s.received, s.applied, s.refunded, s.available, s.list.length], [500, 350, 50, 100, 4]);
  assert.equal(DEP.forEstimate('e1', entries, 'b').available, -100, 'leaving one out (when it is being edited)');
  assert.equal(DEP.outstanding({ id: 'e1', total: 2000, deposit: { kind: 'amount', value: 800 } }, entries), 300);
  assert.equal(DEP.outstanding({ id: 'e1', total: 2000, deposit: { kind: 'amount', value: 400 } }, entries), 0);
  assert.deepEqual(DEP.byCustomer([{ id: 'e1', contactId: 'c1' }, { id: 'e2', contactId: 'c1' }, { id: 'e3', contactId: 'c2' }], entries), { c1: 140 });
  assert.deepEqual(DEP.lines('custdeposit', 'dep', 'bank', 10), [{ account: 'bank', debit: 10, credit: 0 }, { account: 'dep', debit: 0, credit: 10 }]);
  assert.deepEqual(DEP.lines('depapply', 'dep', 'ar', 10), [{ account: 'dep', debit: 10, credit: 0 }, { account: 'ar', debit: 0, credit: 10 }]);
});

let server, base, dir, co, cookie;
const stripe = { links: {}, sessions: {} };
async function fakeStripe(url, init) {
  const u = new URL(url), method = init.method || 'GET';
  const body = method === 'GET' ? u.searchParams : new URLSearchParams(init.body || '');
  const json = (status, j) => ({ ok: status < 400, status, json: async () => j });
  if (u.pathname === '/v1/payment_links' && method === 'GET') return json(200, { data: [] });
  if (u.pathname === '/v1/prices') return json(200, { id: 'price_' + body.get('unit_amount'), unit_amount: +body.get('unit_amount') });
  if (u.pathname === '/v1/payment_links' && method === 'POST') {
    const id = 'plink_' + (Object.keys(stripe.links).length + 1);
    stripe.links[id] = { active: true, price: body.get('line_items[0][price]'), doc: body.get('metadata[sumlora_doc]'), name: body.get('payment_intent_data[description]') };
    return json(200, { id, url: 'https://buy.stripe.com/test_' + id });
  }
  const m = u.pathname.match(/^\/v1\/payment_links\/(.+)$/);
  if (m) { stripe.links[m[1]].active = body.get('active') !== 'false'; return json(200, { id: m[1] }); }
  if (u.pathname === '/v1/checkout/sessions') return json(200, { data: stripe.sessions[body.get('payment_link')] || [] });
  return json(404, { error: { message: 'not found' } });
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-deposits-'));
  server = createApp({ dataDir: dir, autoBackup: false, stripeFetch: fakeStripe });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Deposit Co', province: 'ON' })).json.company.id;
  await call('PUT', '/api/c/records/contacts/c1', { name: 'Ana', kind: 'customer' });
  await call('PUT', '/api/c/records/contacts/c2', { name: 'Ben', kind: 'customer' });
  await call('PUT', '/api/c/records/accounts/dep', { code: '2345', name: 'Customer deposits', type: 'Liability', detail: 'custdep' });
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const state = async () => (await call('GET', '/api/c/state')).json;
const est = (id, total, extra = {}) => call('PUT', `/api/c/records/estimates/${id}`, { number: 'E-' + id, date: '2026-09-01', contactId: 'c1', lines: [{ desc: 'Job', account: 'a4000', qty: 1, rate: total, taxCode: 'none' }], sub: total, tax: 0, total, status: 'open', ...extra });
const received = (id, estId, amount, extra = {}) => call('PUT', `/api/c/records/entries/${id}`, { type: 'custdeposit', date: '2026-09-05', estimateId: estId, amount, bank: 'a1000', method: 'etransfer', lines: DEP.lines('custdeposit', 'dep', 'a1000', amount), ...extra });
const used = (id, estId, invId, amount, extra = {}) => call('PUT', `/api/c/records/entries/${id}`, { type: 'depapply', date: '2026-09-20', estimateId: estId, applyTo: invId, amount, lines: DEP.lines('depapply', 'dep', 'a1200', amount), ...extra });
const refunded = (id, estId, amount) => call('PUT', `/api/c/records/entries/${id}`, { type: 'deprefund', date: '2026-09-25', estimateId: estId, amount, bank: 'a1000', lines: DEP.lines('deprefund', 'dep', 'a1000', amount) });
const invoice = (id, total, contactId = 'c1') => call('POST', '/api/c/batch', { writes: [
  { op: 'set', collection: 'docs', id, data: { kind: 'invoice', number: 'I-' + id, date: '2026-09-20', due: '2026-10-20', contactId, lines: [{ desc: 'Job', account: 'a4000', qty: 1, rate: total, taxCode: 'none' }], sub: total, tax: 0, total } },
  { op: 'set', collection: 'entries', id: 'd_' + id, data: { type: 'invoice', date: '2026-09-20', docId: id, lines: [{ account: 'a1200', debit: total, credit: 0 }, { account: 'a4000', debit: 0, credit: total }] } }] });
const bal = (st, acct) => Math.round(st.entries.flatMap(e => e.lines).filter(l => l.account === acct).reduce((s, l) => s + l.debit - l.credit, 0) * 100) / 100;
const settled = (st, docId) => st.entries.filter(e => e.applyTo === docId).reduce((s, e) => s + e.amount, 0);

test('deposit requested on an estimate is checked', async () => {
  assert.equal((await est('r1', 1000, { deposit: { kind: 'percent', value: 25 } })).status, 200);
  assert.deepEqual((await state()).estimates.find(e => e.id === 'r1').deposit, { kind: 'percent', value: 25 });
  assert.equal((await est('r2', 1000, { deposit: { kind: 'percent', value: 120 } })).status, 400);
  assert.equal((await est('r2', 1000, { deposit: { kind: 'amount', value: 1500 } })).status, 400, 'more than the total');
  assert.equal((await est('r2', 1000, { deposit: { kind: 'amount', value: -5 } })).status, 400);
  assert.equal((await est('r2', 1000, { deposit: { kind: 'amount', value: 0 } })).status, 200, 'zero = none');
  assert.equal((await state()).estimates.find(e => e.id === 'r2').deposit, undefined);
});

test('a deposit received posts Dr bank, Cr Customer deposits, with no sales tax', async () => {
  await est('e1', 1000, { deposit: { kind: 'amount', value: 400 } });
  assert.equal((await received('dp1', 'e1', 400)).status, 200);
  const st = await state();
  const e = st.entries.find(x => x.id === 'dp1');
  assert.deepEqual(e.lines.map(l => [l.account, l.debit, l.credit]), [['a1000', 400, 0], ['dep', 0, 400]]);
  assert.equal(e.contactId, 'c1', 'the customer comes from the estimate');
  assert.equal(bal(st, 'dep'), -400); assert.equal(bal(st, 'a1000'), 400);
  assert.ok(!e.lines.some(l => l.taxCode), 'no tax lines');
  // The rules: amount above zero, not past the estimate's total, through the Customer deposits account, lines that match.
  assert.equal((await received('bad', 'e1', 0)).status, 400);
  assert.equal((await received('bad', 'e1', 700)).status, 400, '400 + 700 is more than the 1000 total');
  assert.equal((await received('bad', 'nope', 10)).status, 400, 'estimate must exist');
  assert.equal((await received('bad', 'e1', 10, { lines: DEP.lines('custdeposit', 'a4000', 'a1000', 10) })).status, 400, 'must use Customer deposits');
  assert.equal((await received('bad', 'e1', 10, { lines: DEP.lines('custdeposit', 'dep', 'a1000', 12) })).status, 400, 'lines match the amount');
  assert.equal((await received('bad', 'e1', 10, { lines: [{ account: 'a1000', debit: 10, credit: 0 }, { account: 'dep', debit: 0, credit: 9 }] })).status, 400, 'balanced');
  assert.equal((await received('bad', 'e1', 10, { method: 'bitcoin' })).status, 400);
  // The estimate can't drop below what was received, change customer, or be deleted while it has deposits.
  assert.equal((await est('e1', 300)).status, 409);
  assert.equal((await est('e1', 1000, { contactId: 'c2' })).status, 409);
  assert.equal((await call('DELETE', '/api/c/records/estimates/e1')).status, 409);
});

test('making the invoice applies the deposit; status and balance reflect it', async () => {
  assert.equal((await invoice('i1', 1000)).status, 200);
  await est('e1', 1000, { invoiceId: 'i1', status: 'accepted', deposit: { kind: 'amount', value: 400 } });
  assert.equal((await used('ap1', 'e1', 'i1', 400)).status, 200);
  const st = await state();
  assert.deepEqual(st.entries.find(e => e.id === 'ap1').lines.map(l => [l.account, l.debit, l.credit]), [['dep', 400, 0], ['a1200', 0, 400]]);
  assert.equal(bal(st, 'dep'), 0, 'nothing held any more');
  assert.equal(settled(st, 'i1'), 400, 'counts as settled on the invoice (docStatus: partial, 600 owing)');
  // Can't use more than is held, nor on another customer's invoice; can't delete the deposit once it's used.
  assert.equal((await used('bad', 'e1', 'i1', 1)).status, 400);
  assert.equal((await invoice('i9', 50, 'c2')).status, 200);
  await received('dp9', 'e1', 50);
  assert.equal((await used('bad', 'e1', 'i9', 50)).status, 400, 'another customer');
  assert.equal((await used('bad', 'e1', 'i1', 50, { lines: DEP.lines('depapply', 'dep', 'a1000', 50) })).status, 400, 'comes off A/R');
  assert.equal((await call('DELETE', '/api/c/records/entries/dp1')).status, 409, 'used already');
  assert.equal((await call('DELETE', '/api/c/records/entries/dp9')).status, 200, 'not used: can go');
  // The pay link for the invoice is for what's left after the deposit.
  await call('PUT', '/api/c/pay', { key: 'rk_test_abcdefghijklmnop' });
  assert.equal((await call('POST', '/api/c/pay/link', { docId: 'i1' })).status, 200);
  assert.equal(stripe.links.plink_1.price, 'price_60000');
});

test('a deposit over the invoice stays as a credit for the customer, then is refunded', async () => {
  await est('e2', 1500);
  assert.equal((await received('dp2', 'e2', 1500)).status, 200);
  assert.equal((await invoice('i2', 1200)).status, 200);
  await est('e2', 1500, { invoiceId: 'i2', status: 'accepted' });
  assert.equal((await used('ap2', 'e2', 'i2', 1300)).status, 400, 'more than the invoice owes');
  assert.equal((await used('ap2', 'e2', 'i2', 1200)).status, 200);
  let st = await state();
  assert.equal(settled(st, 'i2'), 1200, 'invoice paid');
  assert.equal(bal(st, 'dep'), -300, '300 still held');
  assert.deepEqual(DEP.byCustomer(st.estimates, st.entries), { c1: 300 });
  // The company list counts it against receivables (600 left on i1 and 50 on Ben's i9, less the 300 held).
  const co1 = (await call('GET', '/api/companies')).json.companies.find(c => c.id === co);
  assert.equal(co1.receivable, 350);
  // Refund: Dr Customer deposits, Cr bank. Never more than is held.
  assert.equal((await refunded('rf1', 'e2', 301)).status, 400);
  assert.equal((await refunded('rf1', 'e2', 300)).status, 200);
  st = await state();
  assert.deepEqual(st.entries.find(e => e.id === 'rf1').lines.map(l => [l.account, l.debit, l.credit]), [['dep', 300, 0], ['a1000', 0, 300]]);
  assert.equal(bal(st, 'dep'), 0);
  assert.equal(DEP.forEstimate('e2', st.entries).available, 0);
});

test('a cancelled job: the whole deposit refunded', async () => {
  await est('e3', 800);
  await received('dp3', 'e3', 200);
  assert.equal((await refunded('rf3', 'e3', 200)).status, 200);
  const st = await state();
  assert.equal(DEP.forEstimate('e3', st.entries).available, 0);
  assert.equal((await call('DELETE', '/api/c/records/entries/dp3')).status, 409, 'refund first');
});

test('the books closed: a deposit dated in the closed period is refused', async () => {
  await est('e4', 500);
  assert.equal((await call('PUT', '/api/c/closing', { date: '2026-08-31' })).status, 200);
  const r = await received('dp4', 'e4', 100, { date: '2026-08-15', });
  assert.equal(r.status, 423); assert.match(r.json.error, /closed through 2026-08-31/);
  assert.equal((await received('dp4', 'e4', 100)).status, 200, 'after the closing date is fine');
  assert.equal((await call('PUT', '/api/c/closing', { date: '' })).status, 200);
});

test('Stripe: a link for the deposit on an estimate, and a payment there becomes a deposit received', async () => {
  await est('e5', 2000, { deposit: { kind: 'percent', value: 25 } });
  const l = await call('POST', '/api/c/pay/link', { estimateId: 'e5' });
  assert.equal(l.status, 200);
  const id = l.json.url.split('test_')[1];
  assert.equal(stripe.links[id].price, 'price_50000'); assert.equal(stripe.links[id].doc, 'e5');
  assert.match(stripe.links[id].name, /Deposit on estimate E-e5/);
  assert.equal((await call('POST', '/api/c/pay/link', { estimateId: 'e1' })).status, 409, 'nothing more asked for');
  stripe.sessions[id] = [{ id: 'cs_dep1', payment_status: 'paid', status: 'complete', amount_total: 50000, currency: 'cad', created: Math.floor(Date.parse('2026-09-12T15:00:00Z') / 1000) }];
  const s = await call('POST', '/api/c/pay/sync');
  assert.deepEqual(s.json.added, [{ docId: 'e5', number: 'E-e5', amount: 500, estimate: true }]);
  const st = await state();
  const e = st.entries.find(x => x.stripeSession === 'cs_dep1');
  assert.equal(e.type, 'custdeposit'); assert.equal(e.estimateId, 'e5'); assert.equal(e.method, 'card');
  assert.equal(e.lines[0].account, st.accounts.find(a => a.stripe).id); assert.equal(e.lines[1].account, 'dep');
  assert.equal(st.estimates.find(x => x.id === 'e5').payLink.active, false);
  assert.deepEqual((await call('POST', '/api/c/pay/sync')).json.added, [], 'once');
});

test('Stripe: the Customer deposits account is made when there is none', async () => {
  const co2 = (await call('POST', '/api/companies', { name: 'Fresh Co', province: 'ON' })).json.company.id;
  const c2 = (m, u, b) => fetch(base + u.replace('/c/', `/c/${co2}/`), { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b && JSON.stringify(b) }).then(async r => ({ status: r.status, json: await r.json() }));
  await c2('PUT', '/api/c/records/contacts/c1', { name: 'Ana', kind: 'customer' });
  await c2('PUT', '/api/c/records/estimates/e1', { number: 'E-1', date: '2026-09-01', contactId: 'c1', lines: [{ desc: 'Job', account: 'a4000', qty: 1, rate: 100, taxCode: 'none' }], sub: 100, tax: 0, total: 100, deposit: { kind: 'amount', value: 100 } });
  await c2('PUT', '/api/c/pay', { key: 'rk_test_abcdefghijklmnop' });
  const id = (await c2('POST', '/api/c/pay/link', { estimateId: 'e1' })).json.url.split('test_')[1];
  stripe.sessions[id] = [{ id: 'cs_dep2', payment_status: 'paid', status: 'complete', amount_total: 10000, currency: 'cad', created: Math.floor(Date.parse('2026-09-12T15:00:00Z') / 1000) }];
  assert.equal((await c2('POST', '/api/c/pay/sync')).json.added.length, 1);
  const st = (await c2('GET', '/api/c/state')).json;
  const dep = st.accounts.find(a => a.detail === 'custdep');
  assert.ok(dep); assert.equal(dep.type, 'Liability'); assert.equal(dep.code, '2345'); assert.equal(dep.gifi, '2961');
});
