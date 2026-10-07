'use strict';
// The account library: every account is valid for the chart, has French, a sensible code and a valid GIFI suggestion.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LIB = require('../public/accountlib.js');
const GIFI = require('../public/gifi.js');
const { DEFAULT_ACCOUNTS } = require('../src/server/seed.js');
const { createApp } = require('../src/server/app');

const RANGE = { Asset: '1', Liability: '2', Equity: '3', Income: '4', 'Cost of Goods Sold': '5' };
test('library: well-formed, no clashes with the standard chart', () => {
  const A = LIB.ACCOUNTS;
  assert.ok(A.length >= 250, `${A.length} accounts`);
  const codes = new Set(), names = new Set(), std = new Set(DEFAULT_ACCOUNTS.map(a => a[0])), stdNames = new Set(DEFAULT_ACCOUNTS.map(a => a[1].toLowerCase()));
  for (const a of A) {
    assert.ok(/^\d{4}$/.test(a.code), a.code);
    assert.ok(!codes.has(a.code), 'code used twice: ' + a.code); codes.add(a.code);
    assert.ok(!names.has(a.name.toLowerCase()), 'name used twice: ' + a.name); names.add(a.name.toLowerCase());
    assert.ok(!std.has(a.code), 'clashes with the standard chart: ' + a.code);
    assert.ok(!stdNames.has(a.name.toLowerCase()), 'already in the standard chart: ' + a.name);
    assert.ok(a.fr && a.fr !== '', 'French for ' + a.name);
    assert.ok(LIB.GROUPS[a.group], 'group of ' + a.name);
    if (RANGE[a.type]) assert.equal(a.code[0], RANGE[a.type], `${a.code} ${a.name} in the ${a.type} range`);
    else assert.ok(+a.code >= 6000, `${a.code} ${a.name} is an expense code`);
    assert.ok(['', 'bank', 'card', 'capital'].includes(a.detail), a.name);
    if (a.detail === 'bank' || a.detail === 'capital') assert.equal(a.type, 'Asset');
    if (a.detail === 'card') assert.equal(a.type, 'Liability');
    const g = a.gifi || GIFI.suggest({ name: a.name, type: a.type, detail: a.detail });
    assert.ok(g && !GIFI.problem(g, a.type), `GIFI ${g} for ${a.name}`);
  }
});

test('library accounts can all be added to a company', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-acclib-'));
  const server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const call = async (m, u, b) => { const x = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined }); return { status: x.status, json: await x.json() }; };
    const co = (await call('POST', '/api/companies', { name: 'Big Chart Co', province: 'ON' })).json.company.id;
    const writes = LIB.ACCOUNTS.map(a => ({ op: 'set', collection: 'accounts', id: 'L' + a.code, data: { code: a.code, name: a.name, type: a.type, detail: a.detail, desc: a.hint, ...(a.gifi ? { gifi: a.gifi } : {}), active: true } }));
    const res = await call('POST', `/api/c/${co}/batch`, { writes });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const st = (await call('GET', `/api/c/${co}/state`)).json;
    assert.equal(st.accounts.length, DEFAULT_ACCOUNTS.length + LIB.ACCOUNTS.length);
    assert.ok(st.accounts.filter(a => a.id.startsWith('L')).every(a => a.gifi), 'each gets a GIFI code');
  } finally { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
