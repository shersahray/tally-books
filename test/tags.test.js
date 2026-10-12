'use strict';
// Tags: the company's list, tags on transactions (checked by the server), the money in and out by tag totals,
// and who can change them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const TAGS = require('../public/tags.js');
const { validateCompany } = require('../src/server/validate');

test('the list: names trimmed, duplicates dropped, unknown groups cleared', () => {
  const t = TAGS.cleanList([{ id: 'g1', name: ' Event ' }, { id: 'g2', name: 'event' }, { id: '', name: 'x' }],
    [{ id: 't1', name: 'Trade  show', group: 'g1' }, { id: 't2', name: 'trade show', group: 'g1' }, { id: 't3', name: 'Trade show' }, { id: 't4', name: 'Fall', group: 'g9' }, { id: 't5', name: '  ' }]);
  assert.deepEqual(t.groups, [{ id: 'g1', name: 'Event' }]);
  assert.deepEqual(t.tags, [{ id: 't1', name: 'Trade show', group: 'g1' }, { id: 't3', name: 'Trade show', group: '' }, { id: 't4', name: 'Fall', group: '' }],
    'the same name can be in a group and outside it');
  const c = validateCompany({ name: 'X', tags: [{ id: 'a', name: 'A' }], tagGroups: 'nope' });
  assert.deepEqual(c.tags, [{ id: 'a', name: 'A', group: '' }]);
  assert.deepEqual(c.tagGroups, []);
});

test('tags on a transaction: known ids only, at most 20, each once', () => {
  const known = Array.from({ length: 25 }, (_, i) => 't' + i);
  assert.equal(TAGS.cleanTags(undefined, known), null);
  assert.equal(TAGS.cleanTags([], known), null);
  assert.deepEqual(TAGS.cleanTags(['t1', 't1', 't2'], known), ['t1', 't2']);
  assert.throws(() => TAGS.cleanTags(['t1', 'nope'], known), /doesn’t exist/);
  assert.throws(() => TAGS.cleanTags('t1', known), /list/);
  assert.throws(() => TAGS.cleanTags(known.slice(0, 21), known), /at most 20/);
  assert.deepEqual(TAGS.cleanTags(known.slice(0, 20), known).length, 20);
});

test('money in and out by tag: income, expenses and net per tag, in the period', () => {
  const types = { inc: 'Income', exp: 'Expense', cogs: 'Cost of Goods Sold', bank: 'Asset', hst: 'Liability' };
  const entries = [
    // A sale tagged Trade show and Fall: counts under both.
    { id: 'e1', date: '2026-03-01', tags: ['ts', 'fall'], lines: [{ account: 'bank', debit: 1130 }, { account: 'inc', credit: 1000 }, { account: 'hst', credit: 130 }] },
    // An expense for the trade show, with cost of goods sold.
    { id: 'e2', date: '2026-03-05', tags: ['ts'], lines: [{ account: 'exp', debit: 300 }, { account: 'cogs', debit: 50 }, { account: 'bank', credit: 350 }] },
    // A refund of part of the sale (income debited).
    { id: 'e3', date: '2026-03-10', tags: ['ts'], lines: [{ account: 'inc', debit: 100 }, { account: 'bank', credit: 100 }] },
    // No tag.
    { id: 'e4', date: '2026-03-12', lines: [{ account: 'exp', debit: 40 }, { account: 'bank', credit: 40 }] },
    // Outside the period.
    { id: 'e5', date: '2026-05-01', tags: ['ts'], lines: [{ account: 'inc', credit: 999 }, { account: 'bank', debit: 999 }] },
  ];
  const s = TAGS.summary(TAGS.postingsOf(entries), types, '2026-03-01', '2026-03-31');
  assert.deepEqual(s.by.ts, { in: 900, out: 350, net: 550, n: 3 });
  assert.deepEqual(s.by.fall, { in: 1000, out: 0, net: 1000, n: 1 });
  assert.deepEqual(s.none, { in: 0, out: 40, net: -40, n: 1 });
  assert.equal(s.by.nope, undefined);
  // A Map of types works too, and no dates means every date.
  const all = TAGS.summary(TAGS.postingsOf(entries), new Map(Object.entries(types)));
  assert.equal(all.by.ts.in, 1899);
});

test('usage counts transactions, documents, rules and added bank lines', () => {
  const st = { entries: [{ tags: ['a'] }, { tags: ['b'] }], docs: [{ tags: ['a', 'b'] }], rules: [{ tags: ['a'] }], bankTxns: [{ cat: { tags: ['a'] } }, { cat: {} }, {}] };
  assert.equal(TAGS.usage(st, 'a'), 4);
  assert.equal(TAGS.usage(st, 'b'), 2);
  assert.equal(TAGS.usage(st, 'c'), 0);
});

/* ---------- through the API ---------- */
let server, base, dir, co, cookie;
const PW = 'correct horse battery staple';
async function req(ck, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const call = (method, url, body) => req(cookie, method, url.replace('/c/', `/c/${co}/`), body);
const company = async () => (await call('GET', '/api/c/state')).json.company;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-tags-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = (await req(null, 'POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Bookkeeping' })).cookie;
  co = (await req(cookie, 'POST', '/api/companies', { name: 'Tag Co', province: 'ON' })).json.company.id;
  await call('PUT', '/api/c/records/contacts/c1', { name: 'Pat Customer', kind: 'customer' });
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

test('API: tags saved in settings and on invoices, expenses, journal entries, rules and bank lines', async () => {
  let r = await call('PUT', '/api/c/settings', { ...(await company()), tagGroups: [{ id: 'g1', name: 'Event' }], tags: [{ id: 't1', name: 'Trade show', group: 'g1' }, { id: 't2', name: 'Open house', group: 'g1' }, { id: 't3', name: 'Online' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c = await company();
  assert.deepEqual(c.tags.map(t => t.name), ['Trade show', 'Open house', 'Online']);
  assert.deepEqual(c.tagGroups, [{ id: 'g1', name: 'Event' }]);
  // An invoice and its journal entry.
  r = await call('POST', '/api/c/batch', { writes: [
    { op: 'set', collection: 'docs', id: 'i1', data: { kind: 'invoice', number: '1001', contactId: 'c1', date: '2026-03-01', tags: ['t1', 't3'], lines: [{ desc: 'Booth', account: 'a4000', qty: 1, rate: 1000, taxCode: 'none' }], sub: 1000, tax: 0, total: 1000 } },
    { op: 'set', collection: 'entries', id: 'd_i1', data: { type: 'invoice', date: '2026-03-01', docId: 'i1', contactId: 'c1', tags: ['t1', 't3'], lines: [{ account: 'a1200', debit: 1000, credit: 0 }, { account: 'a4000', debit: 0, credit: 1000 }] } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call('PUT', '/api/c/records/entries/x1', { type: 'expense', date: '2026-03-02', tags: ['t1', 't1'], lines: [{ account: 'a6000', debit: 200, credit: 0 }, { account: 'a1000', debit: 0, credit: 200 }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  r = await call('PUT', '/api/c/records/entries/j1', { type: 'journal', date: '2026-03-03', tags: [], lines: [{ account: 'a6000', debit: 5, credit: 0 }, { account: 'a1000', debit: 0, credit: 5 }] });
  assert.equal(r.status, 200);
  r = await call('PUT', '/api/c/records/rules/r1', { text: 'BOOTH', direction: 'out', account: 'a6000', tags: ['t2'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = (await call('GET', '/api/c/state')).json;
  assert.deepEqual(s.docs.find(d => d.id === 'i1').tags, ['t1', 't3']);
  assert.deepEqual(s.entries.find(e => e.id === 'd_i1').tags, ['t1', 't3']);
  assert.deepEqual(s.entries.find(e => e.id === 'x1').tags, ['t1'], 'each tag once');
  assert.equal('tags' in s.entries.find(e => e.id === 'j1'), false, 'an empty list is left off');
  assert.deepEqual(s.rules.find(x => x.id === 'r1').tags, ['t2']);
  // A bank line remembers what it was added as; a tag that doesn't exist is dropped there, not refused.
  r = await call('PUT', '/api/c/records/bankTxns/b1', { account: 'a1000', date: '2026-03-02', desc: 'BOOTH RENTAL', amount: -200, status: 'added', entryId: 'x1', cat: { account: 'a6000', tags: ['t1', 'gone'] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((await call('GET', '/api/c/state')).json.bankTxns.find(b => b.id === 'b1').cat.tags, ['t1']);
});

test('API: unknown tags and more than 20 are refused', async () => {
  let r = await call('PUT', '/api/c/records/entries/x2', { type: 'expense', date: '2026-03-02', tags: ['nope'], lines: [{ account: 'a6000', debit: 1, credit: 0 }, { account: 'a1000', debit: 0, credit: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /tag/i);
  r = await call('PUT', '/api/c/records/entries/x2', { type: 'expense', date: '2026-03-02', tags: 't1', lines: [{ account: 'a6000', debit: 1, credit: 0 }, { account: 'a1000', debit: 0, credit: 1 }] });
  assert.equal(r.status, 400);
  r = await call('PUT', '/api/c/records/rules/r2', { text: 'X', direction: 'out', account: 'a6000', tags: ['nope'] });
  assert.equal(r.status, 400);
  // 21 real tags.
  const c = await company();
  const many = Array.from({ length: 21 }, (_, i) => ({ id: 'm' + i, name: 'Tag ' + i }));
  assert.equal((await call('PUT', '/api/c/settings', { ...c, tags: [...c.tags, ...many] })).status, 200);
  r = await call('PUT', '/api/c/records/entries/x2', { type: 'expense', date: '2026-03-02', tags: many.map(t => t.id), lines: [{ account: 'a6000', debit: 1, credit: 0 }, { account: 'a1000', debit: 0, credit: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /20/);
  r = await call('PUT', '/api/c/records/entries/x2', { type: 'expense', date: '2026-03-02', tags: many.slice(0, 20).map(t => t.id), lines: [{ account: 'a6000', debit: 1, credit: 0 }, { account: 'a1000', debit: 0, credit: 1 }] });
  assert.equal(r.status, 200);
  assert.equal((await call('DELETE', '/api/c/records/entries/x2')).status, 200);
  const c2 = await company();
  assert.equal((await call('PUT', '/api/c/settings', { ...c2, tags: c2.tags.filter(t => !t.id.startsWith('m')) })).status, 200, 'unused tags can be removed');
});

test('API: a tag still in use can’t be removed from the list; renaming is fine', async () => {
  const c = await company();
  let r = await call('PUT', '/api/c/settings', { ...c, tags: c.tags.filter(t => t.id !== 't1') });
  assert.equal(r.status, 409);
  r = await call('PUT', '/api/c/settings', { ...c, tags: c.tags.map(t => (t.id === 't1' ? { ...t, name: 'Trade fair' } : t)) });
  assert.equal(r.status, 200);
  assert.equal((await company()).tags.find(t => t.id === 't1').name, 'Trade fair');
  // Take it off everything (what "Remove from all transactions" does), then it can go.
  const s = (await call('GET', '/api/c/state')).json;
  const off = x => { const o = { ...x }; delete o.id; o.tags = (o.tags || []).filter(t => t !== 't1'); if (!o.tags.length) delete o.tags; return o; };
  const writes = [];
  for (const col of ['entries', 'docs', 'rules']) for (const x of s[col].filter(x => (x.tags || []).includes('t1'))) writes.push({ op: 'set', collection: col, id: x.id, data: off(x) });
  for (const b of s.bankTxns.filter(b => b.cat && (b.cat.tags || []).includes('t1'))) { const d = { ...b }; delete d.id; d.cat = off(b.cat); writes.push({ op: 'set', collection: 'bankTxns', id: b.id, data: d }); }
  r = await call('POST', '/api/c/batch', { writes });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const c2 = await company();
  r = await call('PUT', '/api/c/settings', { ...c2, tags: c2.tags.filter(t => t.id !== 't1') });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual((await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'i1').tags, ['t3']);
});

test('API: tags can change on a transaction in closed books', async () => {
  let r = await call('PUT', '/api/c/closing', { date: '2026-03-31' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = (await call('GET', '/api/c/state')).json.entries.find(x => x.id === 'x1');
  const d = { ...e }; delete d.id;
  r = await call('PUT', '/api/c/records/entries/x1', { ...d, tags: ['t2'] });
  assert.equal(r.status, 200, 'only the tags changed');
  r = await call('PUT', '/api/c/records/entries/x1', { ...d, memo: 'changed' });
  assert.equal(r.status, 423, 'other changes still need the books unlocked');
  assert.equal((await call('PUT', '/api/c/closing', { date: '' })).status, 200);
});

test('custom roles: tags on a record follow its area; new tags from a form, but editing the list needs Accounting', async () => {
  const perms = { sales: 'edit', expenses: 'view', banking: 'none', payroll: 'none', reports: 'view', accounting: 'none', salestax: 'none', settings: 'none' };
  const roleId = (await req(cookie, 'POST', '/api/roles', { name: 'Sales clerk', perms })).json.role.id;
  let r = await req(cookie, 'POST', '/api/users', { name: 'Cleo', username: 'cleo@example.com', password: 'temporary pass 123', role: 'staff', customRole: roleId });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let ck = (await req(null, 'POST', '/api/auth/login', { username: 'cleo@example.com', password: 'temporary pass 123' })).cookie;
  assert.equal((await req(ck, 'POST', '/api/auth/password', { current: 'temporary pass 123', password: 'cleo picks her own phrase' })).status, 200);
  ck = (await req(null, 'POST', '/api/auth/login', { username: 'cleo@example.com', password: 'cleo picks her own phrase' })).cookie;
  const ccall = (m, u, b) => req(ck, m, u.replace('/c/', `/c/${co}/`), b);
  const st = (await ccall('GET', '/api/c/state')).json;
  // Tags on an invoice: Sales edit is enough.
  const inv = st.docs.find(d => d.id === 'i1'); const invD = { ...inv }; delete invD.id;
  r = await ccall('PUT', '/api/c/records/docs/i1', { ...invD, tags: ['t3', 't2'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // On an expense (Expenses at View): refused.
  const ex = (await call('GET', '/api/c/state')).json.entries.find(x => x.id === 'x1'); const exD = { ...ex }; delete exD.id;
  r = await ccall('PUT', '/api/c/records/entries/x1', { ...exD, tags: ['t3'] });
  assert.equal(r.status, 403);
  // Adding a tag to the list from a form: fine. Renaming or removing one: needs Accounting.
  const c = st.company;
  r = await ccall('PUT', '/api/c/settings', { ...c, tags: [...c.tags, { id: 't9', name: 'Spring sale', group: '' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok((await company()).tags.some(t => t.id === 't9'));
  const c2 = (await ccall('GET', '/api/c/state')).json.company;
  r = await ccall('PUT', '/api/c/settings', { ...c2, tags: c2.tags.map(t => (t.id === 't9' ? { ...t, name: 'Renamed' } : t)) });
  assert.equal(r.status, 403);
  r = await ccall('PUT', '/api/c/settings', { ...c2, tags: c2.tags.filter(t => t.id !== 't9') });
  assert.equal(r.status, 403);
});
