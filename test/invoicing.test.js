'use strict';
// Monthly invoices to firms and clients, for an administrator paid by e-Transfer: who to bill and for what.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

let server, base, dir, admin;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-invoicing-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/auth/setup', { acceptTerms: true, name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple', firmName: 'Sher Books' })).cookie;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('invoicing: lists each firm with its companies and plan; only the administrator sees it', async () => {
  const mine = (await call('POST', '/api/companies', { name: 'Sher Books Inc.', province: 'QC' }, admin)).json.company.id;
  await call('PUT', '/api/firms/settings', { signups: 'open' }, admin);
  const owner = (await call('POST', '/api/auth/signup', { acceptTerms: true, firmName: 'Maple Firm', name: 'Ana', username: 'ana@maple.example', password: 'another long phrase here' })).cookie;
  const a = (await call('POST', '/api/companies', { name: 'Client A', province: 'ON' }, owner)).json.company.id;
  await call('POST', '/api/companies', { name: 'Client B', province: 'ON' }, owner);
  const gone = (await call('POST', '/api/companies', { name: 'Client C', province: 'ON' }, owner)).json.company.id;
  await call('PUT', `/api/companies/${gone}`, { archived: true }, owner);
  await call('POST', '/api/auth/signup', { acceptTerms: true, firmName: 'Empty Firm', name: 'Eve', username: 'eve@empty.example', password: 'empty long phrase here' });

  assert.equal((await call('GET', '/api/invoicing', undefined, owner)).status, 403, 'a firm owner can’t see it');
  let s = (await call('GET', '/api/invoicing', undefined, admin)).json;
  assert.equal(s.companyId, '');
  assert.deepEqual(s.companies.map(c => c.name), ['Sher Books Inc.']);
  assert.deepEqual([s.amounts.essentials, s.amounts.plus, s.amounts.assistant], [1500, 3000, 500]);
  const maple = s.customers.find(c => c.name === 'Maple Firm');
  assert.deepEqual([maple.email, maple.person, maple.plan, maple.companies, maple.assistant], ['ana@maple.example', 'Ana', 'essentials', 2, 0], 'archived companies aren’t billed');
  assert.equal(s.customers.find(c => c.name === 'Empty Firm').companies, 0);
  assert.ok(!s.customers.some(c => c.name === 'Sher Books'), 'your own firm isn’t billed');

  assert.equal((await call('PUT', '/api/invoicing', { companyId: a }, admin)).status, 400, 'only your own company can bill');
  assert.deepEqual((await call('PUT', '/api/invoicing', { companyId: mine, tax: false }, admin)).json, { ok: true, companyId: mine, tax: false });
  s = (await call('GET', '/api/invoicing', undefined, admin)).json;
  assert.deepEqual([s.companyId, s.tax], [mine, false]);

  // A suspended firm drops off the list.
  const fid = (await call('GET', '/api/firms', undefined, admin)).json.firms.find(f => f.name === 'Maple Firm').id;
  await call('PUT', `/api/firms/${fid}`, { status: 'suspended' }, admin);
  assert.ok(!(await call('GET', '/api/invoicing', undefined, admin)).json.customers.some(c => c.name === 'Maple Firm'));
});
