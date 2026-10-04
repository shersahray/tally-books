'use strict';
// Estimates, recurring invoices and bills, and online payments through Stripe (with a stand-in for Stripe's API).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, co, cookie;
// The stand-in Stripe: remembers prices and links, and returns sessions we add by hand.
const stripe = { calls: [], prices: 0, links: {}, sessions: {}, reject: false };
async function fakeStripe(url, init) {
  const u = new URL(url), method = init.method || 'GET';
  const body = method === 'GET' ? u.searchParams : new URLSearchParams(init.body || '');
  stripe.calls.push({ method, path: u.pathname, body: Object.fromEntries(body), auth: init.headers.Authorization });
  const json = (status, j) => ({ ok: status < 400, status, json: async () => j });
  if (stripe.reject) return json(401, { error: { message: 'Invalid API Key provided' } });
  if (u.pathname === '/v1/payment_links' && method === 'GET') return json(200, { data: [] });
  if (u.pathname === '/v1/prices') { stripe.prices++; return json(200, { id: 'price_' + stripe.prices, unit_amount: +body.get('unit_amount') }); }
  if (u.pathname === '/v1/payment_links' && method === 'POST') {
    const id = 'plink_' + (Object.keys(stripe.links).length + 1);
    stripe.links[id] = { active: true, price: body.get('line_items[0][price]'), limit: body.get('restrictions[completed_sessions][limit]'), doc: body.get('metadata[sumlora_doc]') };
    return json(200, { id, url: 'https://buy.stripe.com/test_' + id });
  }
  const m = u.pathname.match(/^\/v1\/payment_links\/(.+)$/);
  if (m) { stripe.links[m[1]].active = body.get('active') !== 'false'; return json(200, { id: m[1] }); }
  if (u.pathname === '/v1/checkout/sessions') return json(200, { data: (stripe.sessions[body.get('payment_link')] || []) });
  return json(404, { error: { message: 'not found' } });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-sales-'));
  server = createApp({ dataDir: dir, autoBackup: false, stripeFetch: fakeStripe });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Sales Co', province: 'ON' })).json.company.id;
  await call('PUT', '/api/c/records/contacts/c1', { name: 'Ana', kind: 'customer', email: 'ana@example.com' });
  await call('PUT', '/api/c/records/contacts/v1', { name: 'Landlord', kind: 'vendor' });
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const invoice = (number, total) => ({ kind: 'invoice', number, date: '2026-09-01', due: '2026-10-01', contactId: 'c1', lines: [{ desc: 'Work', account: 'a4000', qty: 1, rate: total, taxCode: 'none' }], sub: total, tax: 0, total });
const posting = (id, total) => ({ type: 'invoice', date: '2026-09-01', docId: id, lines: [{ account: 'a1200', debit: total, credit: 0 }, { account: 'a4000', debit: 0, credit: total }] });

test('estimates: validated, kept off the ledger, linked to the invoice made from them', async () => {
  const est = { number: 'E-1001', date: '2026-09-01', expires: '2026-10-01', contactId: 'c1', lines: [{ desc: 'Website', account: 'a4000', qty: 2, rate: 500, taxCode: 'std' }], sub: 1000, tax: 130, total: 1130, status: 'open' };
  assert.equal((await call('PUT', '/api/c/records/estimates/e1', est)).status, 200);
  assert.equal((await call('PUT', '/api/c/records/estimates/e2', { ...est, contactId: 'nobody' })).status, 400, 'needs a customer');
  assert.equal((await call('PUT', '/api/c/records/estimates/e2', { ...est, invoiceId: 'missing' })).status, 400, 'invoice must exist');
  assert.equal((await call('PUT', '/api/c/records/estimates/e2', { ...est, status: 'weird' })).status, 200);
  let st = (await call('GET', '/api/c/state')).json;
  assert.equal(st.estimates.find(e => e.id === 'e2').status, 'open', 'unknown status becomes open');
  assert.equal(st.entries.length, 0, 'nothing posted');
  // Turn it into an invoice: the invoice and the link in one batch.
  const r = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'docs', id: 'i1', data: invoice('1001', 1130) }, { op: 'set', collection: 'entries', id: 'd_i1', data: posting('i1', 1130) },
    { op: 'set', collection: 'estimates', id: 'e1', data: { ...est, status: 'accepted', invoiceId: 'i1' } }] });
  assert.equal(r.status, 200);
  // A contact on an estimate can't be deleted; an account on one can't either.
  assert.equal((await call('DELETE', '/api/c/records/contacts/c1')).status, 409);
  // Deleting the invoice frees the estimate to be invoiced again.
  assert.equal((await call('POST', '/api/c/batch', { writes: [{ op: 'delete', collection: 'entries', id: 'd_i1' }, { op: 'delete', collection: 'docs', id: 'i1' }] })).status, 200);
  st = (await call('GET', '/api/c/state')).json;
  assert.equal(st.estimates.find(e => e.id === 'e1').invoiceId, '');
  assert.equal(st.estimates.find(e => e.id === 'e1').status, 'accepted');
});

test('recurring templates: schedule and lines are checked', async () => {
  const rec = { kind: 'bill', name: 'Office rent', contactId: 'v1', every: 'month', n: 1, next: '2026-10-01', end: '', lines: [{ desc: 'Rent', account: 'a6600', qty: 1, rate: 2000, taxCode: 'std' }], mode: 'auto', email: true };
  assert.equal((await call('PUT', '/api/c/records/recurring/r1', rec)).status, 200);
  const saved = (await call('GET', '/api/c/state')).json.recurring.find(r => r.id === 'r1');
  assert.equal(saved.email, false, 'only invoices can be emailed');
  assert.equal(saved.active, true); assert.equal(saved.made, 0);
  for (const bad of [{ every: 'daily' }, { n: 13 }, { next: '2026-13-01' }, { lines: [] }, { lines: [{ account: 'nope', qty: 1, rate: 1 }] }, { kind: 'expense' }, { name: ' ' }, { contactId: 'x' }]) {
    assert.equal((await call('PUT', '/api/c/records/recurring/r2', { ...rec, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('DELETE', '/api/c/records/accounts/a6600')).status, 409, 'account used by a template');
  assert.equal((await call('DELETE', '/api/c/records/recurring/r1')).status, 200);
});

test('Stripe: key checked and kept on the server, a link per balance, payments recorded once', async () => {
  assert.equal((await call('PUT', '/api/c/pay', { key: 'hello' })).status, 400);
  stripe.reject = true;
  const bad = await call('PUT', '/api/c/pay', { key: 'rk_test_abcdefghijklmnop' });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /didn’t accept the key/);
  stripe.reject = false;
  const ok = await call('PUT', '/api/c/pay', { key: 'rk_test_abcdefghijklmnop' });
  assert.equal(ok.status, 200); assert.deepEqual([ok.json.configured, ok.json.mode, ok.json.ending], [true, 'test', 'mnop']);
  const st = (await call('GET', '/api/c/state')).json;
  assert.ok(!JSON.stringify(st).includes('rk_test_abcdefghijklmnop'), 'key never sent to the browser');
  assert.ok(!JSON.stringify((await call('GET', '/api/c/pay')).json).includes('abcdefghijkl'));

  await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'docs', id: 'i2', data: invoice('1002', 250.5) }, { op: 'set', collection: 'entries', id: 'd_i2', data: posting('i2', 250.5) }] });
  const l1 = await call('POST', '/api/c/pay/link', { docId: 'i2' });
  assert.equal(l1.status, 200); assert.equal(l1.json.url, 'https://buy.stripe.com/test_plink_1');
  assert.equal(stripe.calls.find(c => c.path === '/v1/prices').body.unit_amount, '25050');
  assert.equal(stripe.calls.find(c => c.path === '/v1/prices').body.currency, 'cad');
  assert.equal(stripe.links.plink_1.limit, '1'); assert.equal(stripe.links.plink_1.doc, 'i2');
  assert.match(stripe.calls[stripe.calls.length - 1].auth, /^Bearer rk_test_/);
  // Same balance: same link. A partial payment changes the balance: a new link, and the old one is turned off.
  assert.equal((await call('POST', '/api/c/pay/link', { docId: 'i2' })).json.url, l1.json.url);
  await call('PUT', '/api/c/records/entries/p1', { type: 'payment', date: '2026-09-05', applyTo: 'i2', amount: 50.5, bank: 'a1000', lines: [{ account: 'a1000', debit: 50.5, credit: 0 }, { account: 'a1200', debit: 0, credit: 50.5 }] });
  const l2 = await call('POST', '/api/c/pay/link', { docId: 'i2' });
  assert.equal(l2.json.url, 'https://buy.stripe.com/test_plink_2');
  assert.equal(stripe.links.plink_1.active, false);
  // The customer pays 200 on Stripe; a sync records it into a new Stripe account, once.
  stripe.sessions.plink_2 = [{ id: 'cs_test_1', payment_status: 'paid', status: 'complete', amount_total: 20000, currency: 'cad', created: Math.floor(Date.parse('2026-09-10T15:00:00Z') / 1000) },
    { id: 'cs_test_2', payment_status: 'unpaid', status: 'complete', amount_total: 20000, currency: 'cad', created: 0 }];
  const s1 = await call('POST', '/api/c/pay/sync');
  assert.equal(s1.status, 200); assert.deepEqual(s1.json.added, [{ docId: 'i2', number: '1002', amount: 200 }]);
  const after1 = (await call('GET', '/api/c/state')).json;
  const acc = after1.accounts.find(a => a.stripe);
  assert.equal(acc.name, 'Stripe'); assert.equal(acc.detail, 'bank');
  const pay = after1.entries.find(e => e.stripeSession === 'cs_test_1');
  assert.equal(pay.type, 'payment'); assert.equal(pay.applyTo, 'i2'); assert.equal(pay.amount, 200); assert.equal(pay.bank, acc.id);
  assert.equal(after1.docs.find(d => d.id === 'i2').payLink.active, false, 'a used link is done');
  assert.deepEqual((await call('POST', '/api/c/pay/sync')).json.added, [], 'not recorded twice');
  assert.equal((await call('POST', '/api/c/pay/link', { docId: 'i2' })).status, 409, 'nothing left to pay');
  // An old link paid after the balance changed: the payment is found (old links are still checked), and because it's
  // more than what's owing it's kept on the invoice as a problem, not dropped.
  await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'docs', id: 'i3', data: invoice('1003', 100) }, { op: 'set', collection: 'entries', id: 'd_i3', data: posting('i3', 100) }] });
  const old = (await call('POST', '/api/c/pay/link', { docId: 'i3' })).json.url.split('test_')[1];
  await call('PUT', '/api/c/records/entries/p3', { type: 'payment', date: '2026-09-06', applyTo: 'i3', amount: 40, bank: 'a1000', lines: [{ account: 'a1000', debit: 40, credit: 0 }, { account: 'a1200', debit: 0, credit: 40 }] });
  const fresh = (await call('POST', '/api/c/pay/link', { docId: 'i3' })).json.url.split('test_')[1];
  assert.notEqual(fresh, old);
  stripe.sessions[old] = [{ id: 'cs_old', payment_status: 'paid', status: 'complete', amount_total: 10000, currency: 'cad', created: Math.floor(Date.parse('2026-09-07T15:00:00Z') / 1000) }];
  const s3 = await call('POST', '/api/c/pay/sync');
  assert.deepEqual(s3.json.added, []); assert.equal(s3.json.issues.length, 1); assert.match(s3.json.errors[0], /couldn’t be recorded/);
  let i3 = (await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'i3');
  assert.equal(i3.payIssues[0].session, 'cs_old'); assert.equal(i3.payIssues[0].amount, 100);
  assert.equal(i3.payLinks.find(l => l.id === old).done, true);
  assert.equal((await call('POST', '/api/c/pay/sync')).json.issues.length, 0, 'reported once');
  assert.equal((await call('POST', '/api/c/pay/issue', { docId: 'i3', session: 'cs_old' })).status, 200);
  assert.ok((await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'i3').payIssues[0].resolved);
  // A payment entered by hand changes the balance: the next sync turns the out-of-date link off.
  await call('PUT', '/api/c/records/entries/p4', { type: 'payment', date: '2026-09-08', applyTo: 'i3', amount: 60, bank: 'a1000', lines: [{ account: 'a1000', debit: 60, credit: 0 }, { account: 'a1200', debit: 0, credit: 60 }] });
  await call('POST', '/api/c/pay/sync');
  assert.equal(stripe.links[fresh].active, false);
  i3 = (await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'i3');
  assert.equal(i3.payLink.active, false); assert.ok(i3.payLinks.find(l => l.id === fresh).closed);
  // A recurring invoice made twice for the same date: the second is refused.
  const rc = { ...invoice('1004', 10), recurringNew: true };
  assert.equal((await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'docs', id: 'rc_x_2026-09-01', data: rc }] })).status, 200);
  assert.equal((await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'docs', id: 'rc_x_2026-09-01', data: rc }] })).status, 409);
  assert.equal((await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'rc_x_2026-09-01').recurringNew, undefined, 'flag not stored');
  // Turning it off forgets the key.
  assert.equal((await call('PUT', '/api/c/pay', { remove: true })).json.configured, false);
  assert.equal((await call('POST', '/api/c/pay/link', { docId: 'i2' })).status, 409);
});
