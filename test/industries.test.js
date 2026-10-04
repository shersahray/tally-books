'use strict';
// Starter charts of accounts by type of business.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IND = require('../public/industries.js');
const { createApp } = require('../src/server/app');
const { DEFAULT_ACCOUNTS } = require('../src/server/seed');

test('every industry: valid account types and details, no clashes with the standard chart', () => {
  const DETAILS = { Asset: ['', 'bank', 'capital'], Liability: [''], Equity: [''], Income: [''], 'Cost of Goods Sold': [''], Expense: [''] };
  const std = new Map(DEFAULT_ACCOUNTS.map(a => [a[0], a]));
  for (const [key, ind] of Object.entries(IND.INDUSTRIES)) {
    assert.ok(ind.label && ind.fr, key);
    const list = IND.accountsFor(key);
    assert.equal(new Set(list.map(a => a[0])).size, list.length, `${key}: one account per code`);
    for (const [code, name, type, detail, fr] of list) {
      assert.match(code, /^\d{4}$/, `${key} ${code}`);
      assert.ok(name && fr, `${key} ${code} needs English and French names`);
      assert.ok(DETAILS[type] && DETAILS[type].includes(detail), `${key} ${code}: ${type}/${detail}`);
      // Renaming a standard account keeps its type and detail, so nothing that relies on it breaks.
      if (std.has(code)) assert.deepEqual([type, detail], [std.get(code)[2], std.get(code)[3]], `${key} ${code} renames ${std.get(code)[1]}`);
    }
    // Names are unique within the chart it makes.
    const names = [...DEFAULT_ACCOUNTS.filter(a => !list.some(b => b[0] === a[0])).map(a => a[1]), ...list.map(a => a[1])].map(n => n.toLowerCase());
    assert.equal(new Set(names).size, names.length, `${key}: duplicate account names`);
  }
  assert.deepEqual(IND.accountsFor('nope'), []);
});

test('a new company gets its industry’s accounts (in its language); non-profits and copies don’t', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-ind-'));
  const server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const call = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) }); return res.json(); };
    const make = async body => { const id = (await call('POST', '/api/companies', { province: 'ON', ...body })).company.id; return (await call('GET', `/api/c/${id}/state`)); };
    const pizza = await make({ name: 'Slice Inc', industry: 'pizza', examples: true });
    const byCode = c => pizza.accounts.find(a => a.code === c);
    assert.equal(byCode('4000').name, 'Pizza and food sales'); assert.equal(byCode('5000').name, 'Food cost');
    assert.equal(byCode('6160').name, 'Delivery app commissions'); assert.equal(byCode('1510').detail, 'capital');
    assert.equal(byCode('2200').name, 'HST payable', 'the standard accounts are all still there');
    assert.ok(byCode('6160').gifi, 'GIFI code suggested');
    assert.equal(pizza.company.industry, 'pizza');
    assert.ok(pizza.entries.length > 0, 'example data still works');
    const fr = await make({ name: 'Peinture Roy', industry: 'painter', lang: 'fr', province: 'QC' });
    assert.equal(fr.accounts.find(a => a.code === '5000').name, 'Peinture et matériaux');
    const npo = await make({ name: 'Club', industry: 'restaurant', orgType: 'npo' });
    assert.equal(npo.accounts.find(a => a.code === '4000').name, 'Donations'); assert.equal(npo.company.industry, '');
    const odd = await make({ name: 'Odd', industry: 'spaceships' });
    assert.equal(odd.company.industry, ''); assert.equal(odd.accounts.find(a => a.code === '4000').name, 'Sales');
  } finally { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
