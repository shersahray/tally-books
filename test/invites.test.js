'use strict';
// Inviting a firm or a single business in one step, and the subscription numbers on the administrator's overview.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

const KEY = 'sk_test_' + 'c'.repeat(24);
let server, base, dir, admin;
async function fakeStripe(url, init) {
  const u = new URL(url), method = init.method || 'GET', p = u.pathname.replace('/v1/', '');
  const json = (status, j) => ({ ok: status < 400, status, json: async () => j });
  if (p === 'prices' && method === 'GET') return json(200, { data: [] });
  return json(404, { error: { message: 'not found' } });
}
async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-invites-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, billingFetch: fakeStripe });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple', firmName: 'Sher Books' })).cookie;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('invite a firm: active straight away, with an invitation link for its owner', async () => {
  assert.equal((await call('POST', '/api/firms/invite', { firmName: '', name: 'Ana', email: 'ana@maple.example' }, admin)).status, 400);
  const r = (await call('POST', '/api/firms/invite', { firmName: 'Maple Firm', name: 'Ana', email: 'ana@maple.example', plan: 'plus' }, admin)).json;
  assert.equal(r.firm.status, 'active');
  assert.equal(r.firm.plan, 'plus');
  assert.equal(r.user.role, 'owner');
  assert.ok(r.user.link);
  // A taken email leaves no empty firm behind.
  const before = (await call('GET', '/api/firms', undefined, admin)).json.firms.length;
  assert.equal((await call('POST', '/api/firms/invite', { firmName: 'Copy Firm', name: 'Ana', email: 'ana@maple.example' }, admin)).status, 409);
  assert.equal((await call('GET', '/api/firms', undefined, admin)).json.firms.length, before);
  // The owner accepts and is in their own firm.
  const acc = await call('POST', '/api/auth/link/accept', { token: r.user.link, password: 'violet harbour tram ninety', acceptTerms: true });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
});

test('invite a business: its company and its owner as a client, in one step', async () => {
  const r = (await call('POST', '/api/companies/invite', { name: 'Corner Bakery', province: 'ON', person: 'Bo Lee', email: 'bo@bakery.example' }, admin)).json;
  assert.equal(r.company.name, 'Corner Bakery');
  assert.equal(r.user.role, 'client');
  assert.deepEqual(r.user.companies, [r.company.id]);
  assert.equal(r.clientPays, false, 'subscriptions are off, so no one pays');
  // A bad email removes the company again.
  const n = (await call('GET', '/api/companies', undefined, admin)).json.companies.length;
  assert.equal((await call('POST', '/api/companies/invite', { name: 'Oops Inc', person: 'X', email: 'bo@bakery.example' }, admin)).status, 409);
  assert.equal((await call('GET', '/api/companies', undefined, admin)).json.companies.length, n);
});

test('overview: subscription numbers once subscriptions are on', async () => {
  assert.equal((await call('GET', '/api/overview', undefined, admin)).json.subs, null);
  await call('PUT', '/api/billing', { key: KEY, amounts: { essentials: 15, plus: 30 }, trialDays: 14 }, admin);
  const r = (await call('POST', '/api/companies/invite', { name: 'Shop Two', province: 'QC', person: 'Cy', email: 'cy@shop.example', plan: 'essentials' }, admin)).json;
  assert.equal(r.clientPays, true);
  const s = (await call('GET', '/api/overview', undefined, admin)).json.subs;
  assert.equal(s.total, 2, 'Maple Firm and Shop Two; the server owner’s firm doesn’t pay');
  assert.equal(s.notStarted, 2);
  assert.deepEqual([s.paying, s.trial, s.failed, s.due.length, s.monthly], [0, 0, 0, 0, 0]);
  assert.ok(s.waiting.some(w => w.name === 'Shop Two' && w.kind === 'company'));
  assert.ok(s.rows.some(w => w.name === 'Maple Firm' && w.kind === 'firm' && w.monthly === 30));
});
