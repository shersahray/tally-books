'use strict';
// Paying for Sumlora on an online server, with a stand-in for Stripe's API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

const KEY = 'sk_test_' + 'a'.repeat(24);
let server, base, dir, admin;
const st = { calls: [], prices: 0, sessions: {}, subs: {}, n: 0 };
async function fakeStripe(url, init) {
  const u = new URL(url), method = init.method || 'GET';
  const body = method === 'GET' ? u.searchParams : new URLSearchParams(init.body || '');
  const p = u.pathname.replace('/v1/', '');
  st.calls.push({ method, p, body: Object.fromEntries(body) });
  const json = (status, j) => ({ ok: status < 400, status, json: async () => j });
  if (init.headers.Authorization !== `Bearer ${KEY}`) return json(401, { error: { message: 'Invalid API Key provided' } });
  if (p === 'prices' && method === 'GET') return json(200, { data: [] });
  if (p === 'prices') return json(200, { id: 'price_' + (++st.prices), unit_amount: +body.get('unit_amount') });
  if (p === 'checkout/sessions' && method === 'POST') {
    const id = 'cs_test_' + (++st.n) + 'abcdefgh';
    st.sessions[id] = { ref: body.get('client_reference_id'), qty: +body.get('line_items[0][quantity]'), trial: body.get('subscription_data[trial_period_days]'), plan: body.get('subscription_data[metadata][sumlora_plan]') };
    return json(200, { id, url: 'https://checkout.stripe.com/c/pay/' + id });
  }
  let m = p.match(/^checkout\/sessions\/(.+)$/);
  if (m) {
    const s = st.sessions[m[1]];
    if (!s) return json(404, { error: { message: 'No such session' } });
    const subId = 'sub_' + m[1];
    st.subs[subId] = st.subs[subId] || { id: subId, status: s.trial ? 'trialing' : 'active', customer: 'cus_' + m[1], trial_end: s.trial ? 1900000000 : null, current_period_end: 1900000000, cancel_at_period_end: false, metadata: { sumlora_plan: s.plan }, items: { data: [{ id: 'si_' + m[1], quantity: s.qty }] } };
    return json(200, { id: m[1], status: 'complete', client_reference_id: s.ref, customer: 'cus_' + m[1], subscription: st.subs[subId] });
  }
  m = p.match(/^subscriptions\/(.+)$/);
  if (m) {
    const sub = st.subs[m[1]];
    if (method === 'POST') sub.items.data[0].quantity = +body.get('items[0][quantity]');
    return json(200, sub);
  }
  if (p === 'billing_portal/sessions') return json(200, { url: 'https://billing.stripe.com/p/session/x' });
  return json(404, { error: { message: 'not found' } });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-billing-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, billingFetch: fakeStripe });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple', firmName: 'Sher Books' })).cookie;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const after402 = r => { assert.equal(r.status, 402); return r.json; };
let firmOwner, firmCo;

test('billing: off until the administrator adds a key; the key is checked and never shown', async () => {
  assert.deepEqual((await call('GET', '/api/billing/me', undefined, admin)).json, { configured: false });
  assert.equal((await call('PUT', '/api/billing', { key: 'not-a-key' }, admin)).status, 400);
  assert.equal((await call('PUT', '/api/billing', { key: 'sk_test_' + 'b'.repeat(24) }, admin)).status, 400, 'Stripe refuses it');
  assert.equal((await call('PUT', '/api/billing', { amounts: { essentials: 0.5 } }, admin)).status, 400);
  const s = (await call('PUT', '/api/billing', { key: KEY, amounts: { essentials: 15, plus: 30 }, trialDays: 14 }, admin)).json;
  assert.deepEqual([s.configured, s.mode, s.amounts.essentials, s.amounts.plus, s.trialDays], [true, 'test', 1500, 3000, 14]);
  assert.ok(!JSON.stringify(s).includes(KEY));
  assert.equal(fs.statSync(path.join(dir, 'billing.json')).mode & 0o077, 0);
  // The server owner's own firm never pays.
  const me = (await call('GET', '/api/billing/me', undefined, admin)).json;
  assert.deepEqual([me.firm.exempt, me.firm.needs], [true, false]);
  assert.equal((await call('GET', '/api/companies', undefined, admin)).status, 200);
});

test('billing: a firm that signs up starts a trial on Stripe, then pays per company', async () => {
  await call('PUT', '/api/firms/settings', { signups: 'open' }, admin);
  firmOwner = (await call('POST', '/api/auth/signup', { firmName: 'Maple Firm', name: 'Ana', username: 'ana@maple.example', password: 'another long phrase here' })).cookie;
  const blocked = after402(await call('GET', '/api/companies', undefined, firmOwner));
  assert.equal(blocked.billing, 'firm');
  const me = (await call('GET', '/api/billing/me', undefined, firmOwner)).json;
  assert.deepEqual([me.firm.needs, me.firm.canPay, me.firm.companies, me.offer.trialDays], [true, true, 1, 14]);

  const co = await call('POST', '/api/billing/checkout', { kind: 'firm', plan: 'essentials' }, firmOwner);
  assert.match(co.json.url, /^https:\/\/checkout\.stripe\.com\//);
  const sess = st.calls.filter(c => c.p === 'checkout/sessions').at(-1).body;
  assert.equal(sess.mode, 'subscription'); assert.equal(sess['line_items[0][quantity]'], '1'); assert.equal(sess['subscription_data[trial_period_days]'], '14');
  assert.match(sess.success_url, /\?billing=done&session=\{CHECKOUT_SESSION_ID\}$/); assert.equal(sess.customer_email, 'ana@maple.example');
  assert.equal(st.calls.find(c => c.p === 'prices' && c.method === 'POST').body.unit_amount, '1500');

  const id = Object.keys(st.sessions).at(-1);
  assert.equal((await call('POST', '/api/billing/finish', { session: id }, admin)).status, 403, 'someone else can’t claim it');
  const fin = (await call('POST', '/api/billing/finish', { session: id }, firmOwner)).json;
  assert.equal(fin.state, 'trialing');
  assert.equal((await call('GET', '/api/companies', undefined, firmOwner)).status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, firmOwner)).json.user.firmPlan, 'essentials', 'the plan they chose');

  // Adding companies raises the count; archiving lowers it.
  firmCo = (await call('POST', '/api/companies', { name: 'One', province: 'ON' }, firmOwner)).json.company.id;
  const two = (await call('POST', '/api/companies', { name: 'Two', province: 'ON' }, firmOwner)).json.company.id;
  const sub = st.subs['sub_' + id];
  assert.equal(sub.items.data[0].quantity, 2);
  await call('PUT', `/api/companies/${two}`, { archived: true }, firmOwner);
  assert.equal(sub.items.data[0].quantity, 1);
  assert.equal((await call('POST', '/api/billing/checkout', { kind: 'firm' }, firmOwner)).status, 400, 'already running');
  assert.match((await call('POST', '/api/billing/portal', { kind: 'firm' }, firmOwner)).json.url, /billing\.stripe\.com/);

  // Cancelled at Stripe: read again when stale, and the firm is asked to start again, without a new trial.
  sub.status = 'canceled';
  const f = server.auth.data.firms.find(x => x.name === 'Maple Firm'); f.billing.checked = 0;
  assert.equal((await call('GET', '/api/billing/me', undefined, firmOwner)).json.firm.state, 'stopped');
  after402(await call('GET', '/api/companies', undefined, firmOwner));
  await call('POST', '/api/billing/checkout', { kind: 'firm', plan: 'plus' }, firmOwner);
  const again = st.calls.filter(c => c.p === 'checkout/sessions').at(-1).body;
  assert.equal(again['subscription_data[trial_period_days]'], undefined, 'no second trial');
  assert.equal(again.customer, 'cus_' + id, 'same Stripe customer');
  // A payment that failed: a week of grace, then blocked.
  const id2 = Object.keys(st.sessions).at(-1);
  await call('POST', '/api/billing/finish', { session: id2 }, firmOwner);
  st.subs['sub_' + id2].status = 'past_due'; f.billing.checked = 0;
  assert.equal((await call('GET', '/api/billing/me', undefined, firmOwner)).json.firm.state, 'pastdue');
  assert.equal((await call('GET', '/api/companies', undefined, firmOwner)).status, 200, 'still in during the grace week');
  f.billing.pastDueSince = Date.now() - 8 * 864e5;
  after402(await call('GET', '/api/companies', undefined, firmOwner));
  st.subs['sub_' + id2].status = 'active'; f.billing.checked = 0;
  await call('GET', '/api/billing/me', undefined, firmOwner);
  assert.equal((await call('GET', '/api/companies', undefined, firmOwner)).status, 200);
});

test('billing: a client who pays for their own company starts a trial before opening it; the bookkeeper isn’t held up', async () => {
  const co = (await call('POST', '/api/companies', { name: 'ABC Inc.', province: 'ON' }, admin)).json.company.id;
  const link = (await call('POST', '/api/users', { name: 'Client', username: 'client@abc.example', role: 'client', companies: [co], invite: true, clientPays: true, clientPlan: 'essentials' }, admin)).json.user.link;
  const cl = (await call('POST', '/api/auth/link/accept', { token: link, password: 'client long phrase' })).cookie;
  const b = after402(await call('GET', `/api/c/${co}/state`, undefined, cl));
  assert.deepEqual([b.billing, b.companyId], ['company', co]);
  assert.equal((await call('GET', `/api/c/${co}/state`, undefined, admin)).status, 200, 'the bookkeeper keeps working');
  const me = (await call('GET', '/api/billing/me', undefined, cl)).json;
  assert.deepEqual(me.companies.map(c => [c.id, c.needs]), [[co, true]]);
  assert.equal((await call('POST', '/api/billing/checkout', { kind: 'firm' }, cl)).status, 403, 'a client can’t start the firm’s subscription');
  assert.equal((await call('POST', '/api/billing/checkout', { kind: 'company', id: firmCo }, cl)).status, 404, 'nor another firm’s company');
  await call('POST', '/api/billing/checkout', { kind: 'company', id: co }, cl);
  const sess = st.calls.filter(c => c.p === 'checkout/sessions').at(-1).body;
  assert.deepEqual([sess.client_reference_id, sess['line_items[0][quantity]'], sess['subscription_data[trial_period_days]'], sess['subscription_data[metadata][sumlora_plan]']], [`company:${co}`, '1', '14', 'essentials'], 'the plan the bookkeeper chose for them');
  await call('POST', '/api/billing/finish', { session: Object.keys(st.sessions).at(-1) }, cl);
  assert.equal((await call('GET', `/api/c/${co}/state`, undefined, cl)).status, 200);
  // The company list shows who pays, without Stripe's ids.
  const list = (await call('GET', '/api/companies', undefined, admin)).json.companies.find(c => c.id === co);
  assert.equal(list.payer, 'client'); assert.equal(list.billing.state, 'trialing');
  assert.ok(!JSON.stringify(list).includes('cus_') && !JSON.stringify(list).includes('sub_'));
  // Turning subscriptions off lets everyone in again.
  await call('PUT', '/api/billing', { key: '' }, admin);
  assert.equal((await call('GET', '/api/companies', undefined, firmOwner)).status, 200);
});
