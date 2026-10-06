'use strict';
// Bank feeds through Plaid, with a stand-in for Plaid's API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');

const CID = 'a1b2c3d4e5f6a7b8c9d0e1f2', SECRET = 'f0e1d2c3b4a5f6e7d8c9b0a1f2e3d4';
let server, base, dir, co, cookie;
const plaid = { calls: [], pages: {}, fail: null, items: {} };
let nextItem = 0;
async function fakePlaid(url, init) {
  const u = new URL(url), body = JSON.parse(init.body || '{}');
  plaid.calls.push({ host: u.host, path: u.pathname, body });
  const json = (status, j) => ({ ok: status < 400, status, json: async () => j });
  if (body.client_id !== CID || body.secret !== SECRET) return json(400, { error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS', error_message: 'invalid client_id or secret provided' });
  if (plaid.fail && plaid.fail.path === u.pathname) { const f = plaid.fail; if (!f.times || --f.times === 0) plaid.fail = null; return json(400, { error_type: 'ITEM_ERROR', error_code: f.code, error_message: f.code }); }
  switch (u.pathname) {
    case '/link/token/create': return json(200, { link_token: 'link-sandbox-' + (body.access_token ? 'update' : 'new') });
    case '/item/public_token/exchange': { const n = ++nextItem; plaid.items['access-sandbox-' + n] = true; return json(200, { access_token: 'access-sandbox-' + n, item_id: 'item' + n }); }
    case '/accounts/get': return json(200, { accounts: [
      { account_id: 'chq', name: 'Business Chequing', mask: '1234', type: 'depository', subtype: 'checking', balances: { iso_currency_code: 'CAD' } },
      { account_id: 'usd', name: 'US Dollar Account', mask: '9876', type: 'depository', subtype: 'checking', balances: { iso_currency_code: 'USD' } },
      { account_id: 'visa', name: 'Visa', mask: '5555', type: 'credit', subtype: 'credit card', balances: { iso_currency_code: 'CAD' } }] });
    case '/transactions/sync': {
      const page = (plaid.pages[body.cursor || ''] || { added: [], modified: [], removed: [], next_cursor: body.cursor || 'c0', has_more: false });
      return json(200, page);
    }
    case '/item/remove': delete plaid.items[body.access_token]; return json(200, { removed: true });
  }
  return json(404, { error_code: 'NOT_FOUND', error_message: 'not found' });
}
const tx = (id, acct, date, amount, name, extra = {}) => ({ transaction_id: id, account_id: acct, date, amount, name, merchant_name: null, pending: false, iso_currency_code: acct === 'usd' ? 'USD' : 'CAD', ...extra });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-feeds-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, plaidFetch: fakePlaid });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Feeds Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body, ck = cookie) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie: ck }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const lines = async () => (await call('GET', '/api/c/state')).json.bankTxns;

test('bank feeds: keys are the administrator’s, checked, and never shown', async () => {
  assert.deepEqual((await call('GET', '/api/plaid')).json, { configured: false, env: 'sandbox', source: '', clientIdHint: '', connections: 0, accounts: 0, admin: true });
  assert.equal((await call('POST', '/api/c/feeds/link', {})).status, 409, 'not set up yet');
  assert.equal((await call('PUT', '/api/plaid', { clientId: 'not a key!' })).status, 400);
  assert.equal((await call('PUT', '/api/plaid', { env: 'staging' })).status, 400);
  const st = (await call('PUT', '/api/plaid', { clientId: CID, secret: SECRET, env: 'sandbox' })).json;
  assert.equal(st.configured, true); assert.equal(st.clientIdHint, '…' + CID.slice(-4));
  assert.ok(!JSON.stringify(st).includes(SECRET) && !JSON.stringify(st).includes(CID), 'keys not sent back');
  assert.equal(fs.statSync(path.join(dir, 'plaid.json')).mode & 0o077, 0, 'file readable by this account only');
});

test('bank feeds: connect, choose accounts, bring in posted lines once, keep reviewed lines', async () => {
  const lt = (await call('POST', '/api/c/feeds/link', { lang: 'fr' })).json;
  assert.equal(lt.linkToken, 'link-sandbox-new');
  const req = plaid.calls.at(-1).body;
  assert.equal(req.language, 'fr'); assert.deepEqual(req.products, ['transactions']); assert.deepEqual(req.country_codes, ['CA', 'US']);
  assert.ok(!req.user.client_user_id.includes('@'), 'no email sent to Plaid');
  assert.equal((await call('POST', '/api/c/feeds', { publicToken: 'nonsense' })).status, 400);
  const item = (await call('POST', '/api/c/feeds', { publicToken: 'public-sandbox-abc12345', institution: { name: 'RBC Royal Bank' } })).json.item;
  assert.equal(item.institution, 'RBC Royal Bank'); assert.equal(item.accounts.length, 3); assert.deepEqual(item.links, {});
  assert.equal(item.accessToken, undefined, 'access token stays on the server');

  // Only bank and card accounts can be fed, and each by one bank account.
  assert.equal((await call('PUT', `/api/c/feeds/${item.id}`, { links: { chq: 'a6000' } })).status, 400, 'not into an expense account');
  assert.equal((await call('PUT', `/api/c/feeds/${item.id}`, { links: { chq: 'a1000', usd: 'a1000' } })).status, 400, 'two bank accounts into one');
  const saved = (await call('PUT', `/api/c/feeds/${item.id}`, { links: { chq: 'a1000', usd: 'a1010', visa: 'a2100' }, starts: { chq: '2026-09-01' } })).json.item;
  assert.deepEqual(saved.links, { chq: 'a1000', usd: 'a1010', visa: 'a2100' });

  plaid.pages[''] = { added: [
    tx('t1', 'chq', '2026-09-03', 45.5, 'Staples #123', { merchant_name: 'Staples' }),
    tx('t2', 'chq', '2026-09-04', -1200, 'Customer deposit'),
    tx('t0', 'chq', '2026-08-28', 10, 'Before the start date'),
    tx('tp', 'chq', '2026-09-05', 9.99, 'Pending coffee', { pending: true }),
    tx('t3', 'usd', '2026-09-06', 100, 'Amazon.com'),
    tx('t4', 'visa', '2026-09-07', 30, 'Shell'),
    tx('tx', 'other', '2026-09-07', 5, 'Unlinked account'),
  ], modified: [], removed: [], next_cursor: 'c1', has_more: true };
  plaid.pages.c1 = { added: [tx('t5', 'chq', '2026-09-08', 12, 'Second page')], modified: [], removed: [], next_cursor: 'c2', has_more: false };
  const r = (await call('POST', `/api/c/feeds/${item.id}/sync`, {})).json;
  assert.equal(r.added, 5);
  let b = await lines();
  const by = desc => b.find(x => x.desc.startsWith(desc));
  assert.equal(by('Staples').amount, -45.5, 'money out is negative'); assert.equal(by('Staples').account, 'a1000');
  assert.equal(by('Customer deposit').amount, 1200, 'money in is positive');
  assert.equal(by('Amazon.com').desc, 'Amazon.com (USD)'); assert.equal(by('Amazon.com').account, 'a1010');
  assert.equal(by('Shell').account, 'a2100');
  assert.ok(!by('Before the start') && !by('Pending') && !by('Unlinked'), 'start date, pending and unlinked accounts are left out');
  assert.ok(b.every(x => x.status === 'new' && x.feed === true && x.file === 'Bank feed · RBC Royal Bank'));
  assert.equal(plaid.calls.filter(c => c.path === '/transactions/sync').at(-1).body.cursor, 'c1', 'second page asked with the cursor');

  // Next sync starts from the saved position; the bank changes a waiting line, removes one, and posts a new one.
  const deposit = by('Customer deposit');
  await call('PUT', `/api/c/records/bankTxns/${by('Shell').id}`, { ...by('Shell'), status: 'excluded' });
  plaid.pages.c2 = { added: [tx('t1', 'chq', '2026-09-03', 45.5, 'Staples #123'), tx('t6', 'chq', '2026-09-09', 7, 'Tim Hortons')],
    modified: [tx('t2', 'chq', '2026-09-04', -1250, 'Customer deposit corrected'), tx('t4', 'visa', '2026-09-07', 31, 'Shell changed')],
    removed: [{ transaction_id: 't5' }], next_cursor: 'c3', has_more: false };
  const r2 = (await call('POST', `/api/c/feeds/${item.id}/sync`, {})).json;
  assert.deepEqual([r2.added, r2.updated, r2.removed], [1, 1, 1]);
  b = await lines();
  assert.equal(b.length, 5, 'Staples not brought in twice');
  assert.equal(b.find(x => x.id === deposit.id).amount, 1250);
  assert.equal(b.find(x => x.ptid === 't4').desc, 'Shell', 'a reviewed (excluded) line is left alone');
  assert.ok(!b.some(x => x.ptid === 't5'), 'removed by the bank while waiting');

  // Nothing secret reaches the browser, the books or a backup.
  const st = JSON.stringify((await call('GET', '/api/c/state')).json) + JSON.stringify((await call('GET', '/api/c/backup')).json) + JSON.stringify((await call('GET', '/api/c/feeds')).json);
  assert.ok(!st.includes('access-sandbox') && !st.includes(SECRET));
});

test('bank feeds: a newly linked account reads history again; sign-in problems and retries; disconnect', async () => {
  const items = (await call('GET', '/api/c/feeds')).json.items;
  const id = items[0].id;
  // Unlink the US account, then link it again from an earlier date: the next sync starts from the beginning, without duplicates.
  await call('PUT', `/api/c/feeds/${id}`, { links: { chq: 'a1000', visa: 'a2100' }, starts: { chq: '2026-09-01' } });
  await call('PUT', `/api/c/feeds/${id}`, { links: { chq: 'a1000', usd: 'a1010', visa: 'a2100' }, starts: { chq: '2026-09-01', usd: '2026-01-01' } });
  plaid.pages[''].has_more = false; plaid.pages[''].next_cursor = 'c3';
  const r = (await call('POST', `/api/c/feeds/${id}/sync`, {})).json;
  assert.equal(plaid.calls.filter(c => c.path === '/transactions/sync').at(-1).body.cursor, undefined, 'read from the beginning');
  assert.equal(r.added, 0, 'everything was already in (and the line before the start date stays out)');

  // The bank changed things while paging: start that sync again once.
  plaid.fail = { path: '/transactions/sync', code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', times: 1 };
  assert.equal((await call('POST', `/api/c/feeds/${id}/sync`, {})).status, 200);
  // The bank wants a new sign-in: shown on the connection, and cleared after signing in again.
  plaid.fail = { path: '/transactions/sync', code: 'ITEM_LOGIN_REQUIRED', times: 1 };
  const bad = await call('POST', `/api/c/feeds/${id}/sync`, {});
  assert.equal(bad.status, 400); assert.match(bad.json.error, /sign in again/);
  let it = (await call('GET', '/api/c/feeds')).json.items[0];
  assert.equal(it.status, 'login');
  assert.equal((await call('POST', '/api/c/feeds/link', { itemId: id })).json.linkToken, 'link-sandbox-update');
  it = (await call('POST', `/api/c/feeds/${id}/reconnected`, {})).json.item;
  assert.equal(it.status, 'ok');

  // Clients can't connect banks or see connections; another company can't touch this one's.
  const inv = (await call('POST', '/api/users', { name: 'C', username: 'c@example.com', role: 'client', companies: [co], invite: true })).json.user.link;
  const acc = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inv, password: 'client long phrase' }) });
  const cc = acc.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/c/feeds', undefined, cc)).status, 403);
  assert.equal((await call('GET', '/api/plaid', undefined, cc)).json.configured, false);
  const other = (await call('POST', '/api/companies', { name: 'Other Co', province: 'ON' })).json.company.id;
  const res = await fetch(`${base}/api/c/${other}/feeds/${id}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
  assert.equal(res.status, 404);

  // Switching environments needs no connections; disconnecting removes the item at Plaid (stopping its charge).
  assert.equal((await call('PUT', '/api/plaid', { env: 'production' })).status, 400);
  const before = Object.keys(plaid.items).length;
  assert.equal((await call('DELETE', `/api/c/feeds/${id}`)).status, 200);
  assert.equal(Object.keys(plaid.items).length, before - 1);
  assert.equal((await call('GET', '/api/c/feeds')).json.items.length, 0);
  assert.equal((await lines()).length, 5, 'lines already brought in stay');
  assert.equal((await call('PUT', '/api/plaid', { env: 'production' })).json.env, 'production');
  assert.equal(plaid.calls.at(-1).host, 'sandbox.plaid.com');
});

test('bank feeds: statement files and feeds don’t double up; relinks and restores read history again; disconnect mid-sync', async () => {
  await call('PUT', '/api/plaid', { env: 'sandbox' });
  // A statement imported first: the feed recognises its lines instead of adding them again.
  await call('POST', '/api/c/bank/import', { account: 'a1000', fileName: 'sept.csv', rows: [{ date: '2026-10-01', amount: -19.99, desc: 'NETFLIX.COM' }, { date: '2026-10-02', amount: -5, desc: 'COFFEE' }] });
  const item = (await call('POST', '/api/c/feeds', { publicToken: 'public-sandbox-second123', institution: { name: 'TD' } })).json.item;
  plaid.pages = { '': { added: [tx('n1', 'chq', '2026-10-02', 19.99, 'Netflix'), tx('n2', 'chq', '2026-10-03', 5, 'Coffee'), tx('n3', 'chq', '2026-10-03', 5, 'Second coffee'), tx('n4', 'chq', '2026-10-04', 60, 'Bell Canada')], modified: [], removed: [], next_cursor: 'd1', has_more: false } };
  await call('PUT', `/api/c/feeds/${item.id}`, { links: { chq: 'a1000' }, starts: { chq: '2026-10-01' } });
  const r = (await call('POST', `/api/c/feeds/${item.id}/sync`, {})).json;
  assert.equal(r.added, 2, 'the second coffee and Bell are new; Netflix and the first coffee were in the statement');
  let b = (await lines()).filter(x => x.date >= '2026-10-01');
  assert.equal(b.length, 4);
  assert.equal(b.find(x => x.desc === 'NETFLIX.COM').ptid, 'n1', 'statement line marked as the bank’s');
  // A statement imported after the feed: lines the feed already brought in are skipped (once each).
  const imp = (await call('POST', '/api/c/bank/import', { account: 'a1000', fileName: 'oct.csv', rows: [{ date: '2026-10-04', amount: -60, desc: 'BELL CANADA' }, { date: '2026-10-05', amount: -60, desc: 'BELL AGAIN' }] })).json;
  assert.deepEqual([imp.added, imp.skipped], [1, 1]);

  // Relinking while a sync is running: that sync doesn't undo the reset, so the next one reads history again.
  let release; const gate = new Promise(r2 => { release = r2; });
  plaid.pages.d1 = { added: [], modified: [], removed: [], next_cursor: 'd2', has_more: false };
  const orig = plaid.pages.d1; let waited = false;
  Object.defineProperty(plaid.pages, 'd1', { configurable: true, get() { if (!waited) { waited = true; return gate.then(() => orig); } return orig; } });
  const running = call('POST', `/api/c/feeds/${item.id}/sync`, {});
  await new Promise(r2 => setTimeout(r2, 100));
  await call('PUT', `/api/c/feeds/${item.id}`, { links: { chq: 'a1000', visa: 'a2100' }, starts: { chq: '2026-10-01', visa: '2026-10-01' } });
  release(); await running;
  const n = plaid.calls.filter(c => c.path === '/transactions/sync').length;
  await call('POST', `/api/c/feeds/${item.id}/sync`, {});
  assert.equal(plaid.calls.filter(c => c.path === '/transactions/sync')[n].body.cursor, undefined, 'history read again after the relink');

  // A restore puts the books back in time: the feed reads its history again.
  const backup = (await call('GET', '/api/c/backup')).json;
  await call('POST', '/api/c/restore', backup);
  const m = plaid.calls.filter(c => c.path === '/transactions/sync').length;
  await call('POST', `/api/c/feeds/${item.id}/sync`, {});
  assert.equal(plaid.calls.filter(c => c.path === '/transactions/sync')[m].body.cursor, undefined, 'history read again after a restore');
  assert.equal((await lines()).filter(x => x.ptid === 'n2').length, 1, 'still no duplicates');

  // Disconnected while a sync runs: the sync finishes quietly.
  let rel2; const gate2 = new Promise(r2 => { rel2 = r2; });
  Object.defineProperty(plaid.pages, 'd1', { configurable: true, get() { return gate2.then(() => orig); } });
  plaid.pages[''] = { added: [], modified: [], removed: [], next_cursor: 'd1', has_more: true };
  const run2 = call('POST', `/api/c/feeds/${item.id}/sync`, {});
  await new Promise(r2 => setTimeout(r2, 100));
  assert.equal((await call('DELETE', `/api/c/feeds/${item.id}`)).status, 200);
  rel2();
  const done = await run2;
  assert.equal(done.status, 200); assert.equal(done.json.item, null);
});
