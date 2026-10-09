'use strict';
// The Scrap yard add-on: choosing "Scrap yard or auto recycler" sets up the accounts, materials and add-on;
// vehicles are bought by VIN with the seller's details; their transactions are protected; seller IDs stay out of the log.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { Billing } = require('../src/server/billing');
const PLANS = require('../public/plans.js');
const IND = require('../public/industries.js');

let server, base, dir, cookie = '', yard, plain;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-yard-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  yard = (await call('POST', '/api/companies', { name: 'Kanata Auto Recyclers', province: 'ON', industry: 'scrapyard' })).json.company;
  plain = (await call('POST', '/api/companies', { name: 'Smiths Falls Scrap', province: 'ON', industry: 'scrapyard', scrapyard: false })).json.company;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, url, body, cid) {
  const res = await fetch(base + (cid ? url.replace('/c/', `/c/${cid}/`) : url), { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const state = cid => call('GET', '/api/c/state', undefined, cid).then(r => r.json);

test('the industry and its add-on are defined together', () => {
  assert.equal(PLANS.ADDON_FOR_INDUSTRY.scrapyard, 'scrapyard');
  assert.ok(PLANS.ADDONS.scrapyard.cents >= 100);
  const codes = new Set(IND.accountsFor('scrapyard').map(a => a[0]));
  for (const [, inc, exp] of IND.INDUSTRIES.scrapyard.items) { assert.ok(codes.has(inc), inc); if (exp) assert.ok(codes.has(exp), exp); }
});

test('a company set up as a scrap yard gets its accounts, materials, weigh ticket field and the add-on', async () => {
  assert.equal(yard.scrapyard, true, 'the add-on is on');
  const s = await state(yard.id);
  assert.deepEqual(s.addons, { assistant: false, scrapyard: true });
  const byCode = c => s.accounts.find(a => a.code === c);
  assert.equal(byCode('1410').name, 'Vehicles in yard (inventory)');
  assert.equal(byCode('4000').name, 'Scrap metal sales');
  assert.equal(byCode('5000').name, 'Cost of vehicles processed');
  assert.equal(s.items.length, IND.INDUSTRIES.scrapyard.items.length);
  const copper = s.items.find(i => i.name === 'Copper (per lb)');
  assert.equal(copper.incomeAccount, byCode('4000').id); assert.equal(copper.expenseAccount, byCode('5010').id); assert.equal(copper.bought, true);
  assert.deepEqual(s.company.customFields.map(f => f.label), ['Weigh ticket no.']);
  // Unticked when it was made: the accounts, but no add-on.
  assert.equal(plain.scrapyard, undefined);
  assert.equal((await state(plain.id)).addons.scrapyard, false);
});

test('vehicles: only with the add-on, checked on the way in, and their purchase is kept with them', async () => {
  const s = await state(yard.id);
  const id = c => s.accounts.find(a => a.code === c).id;
  const inv = id('1410'), bank = id('1000'), hst = id('2200');
  const veh = { stock: '26001', vin: '2hgfb2f59ch123456', year: 2012, make: 'Honda', model: 'Civic', bought: '2026-09-15', price: 400, tax: 0, invAccount: inv, payAccount: bank, payMethod: 'etransfer',
    sellerKind: 'public', seller: { name: 'Pat Doe', address: '1 Main St, Smiths Falls', idType: 'Driver’s licence', idNumber: 'D1234-56789-01234' }, status: 'yard', env: { fluids: true }, parts: [] };
  const buy = { type: 'expense', date: '2026-09-15', ref: '26001', vehBuy: 'v1', veh: 'v1', lines: [{ account: inv, debit: 400, credit: 0 }, { account: bank, debit: 0, credit: 400 }] };

  const no = await call('PUT', '/api/c/records/vehicles/v1', veh, plain.id);
  assert.equal(no.status, 403, 'not without the add-on');
  assert.match(no.json.error, /Scrap yard add-on/);

  assert.equal((await call('PUT', '/api/c/records/vehicles/v0', { ...veh, seller: { name: '' } }, yard.id)).status, 400, 'a public seller needs a name');
  assert.equal((await call('PUT', '/api/c/records/vehicles/v0', { ...veh, tax: 52 }, yard.id)).status, 400, 'no GST/HST from someone not registered');
  assert.equal((await call('PUT', '/api/c/records/vehicles/v0', { ...veh, sellerKind: 'business' }, yard.id)).status, 400, 'a business seller is a vendor');

  const ok = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'vehicles', id: 'v1', data: { ...veh, buyEntry: 'vb_v1' } }, { op: 'set', collection: 'entries', id: 'vb_v1', data: buy }] }, yard.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const after1 = await state(yard.id);
  const v = after1.vehicles.find(x => x.id === 'v1');
  assert.equal(v.vin, '2HGFB2F59CH123456', 'VINs are kept in capitals');
  assert.equal(v.env.fluids, true); assert.equal(v.env.battery, false);
  assert.equal(after1.entries.find(e => e.id === 'vb_v1').veh, 'v1', 'the purchase points at its vehicle');

  assert.equal((await call('PUT', '/api/c/records/vehicles/v2', { ...veh, stock: '26001' }, yard.id)).status, 409, 'stock numbers are unique');
  // A registered business seller: their GST/HST is claimed back.
  const vendor = 'tow1';
  assert.equal((await call('PUT', `/api/c/records/contacts/${vendor}`, { name: 'Rideau Towing', kind: 'vendor' }, yard.id)).status, 200);
  const biz = await call('POST', '/api/c/batch', { writes: [
    { op: 'set', collection: 'vehicles', id: 'v2', data: { ...veh, stock: '26002', vin: '', sellerKind: 'business', contactId: vendor, seller: { gstNo: '123456789RT0001' }, price: 800, tax: 104, buyEntry: 'vb_v2' } },
    { op: 'set', collection: 'entries', id: 'vb_v2', data: { ...buy, vehBuy: 'v2', veh: 'v2', contactId: vendor, lines: [{ account: inv, debit: 800, credit: 0 }, { account: hst, debit: 104, credit: 0 }, { account: bank, debit: 0, credit: 904 }] } },
  ] }, yard.id);
  assert.equal(biz.status, 200, JSON.stringify(biz.json));

  // Its purchase can't be deleted on its own, and the vehicle can't be deleted while it has one.
  assert.equal((await call('DELETE', '/api/c/records/entries/vb_v1', undefined, yard.id)).status, 409);
  assert.equal((await call('DELETE', '/api/c/records/vehicles/v1', undefined, yard.id)).status, 409);

  // A part sold on a sales receipt keeps the receipt from being deleted.
  const sr = { kind: 'sreceipt', date: '2026-09-20', number: '1', depositTo: bank, contactId: '', lines: [{ desc: 'Alternator', account: id('4010'), qty: 1, rate: 60 }], total: 60, veh: 'v1' };
  assert.equal((await call('PUT', '/api/c/records/docs/sr1', sr, yard.id)).status, 200);
  const cur = (await state(yard.id)).vehicles.find(x => x.id === 'v1');
  assert.equal((await call('PUT', '/api/c/records/vehicles/v1', { ...cur, parts: [{ id: 'p1', name: 'Alternator', location: 'B3', price: 60, status: 'sold', docId: 'sr1' }] }, yard.id)).status, 200);
  assert.equal((await call('DELETE', '/api/c/records/docs/sr1', undefined, yard.id)).status, 409);

  // Deleting the vehicle the way the screen does: unhook, delete the purchase, delete the vehicle.
  const v2 = (await state(yard.id)).vehicles.find(x => x.id === 'v2');
  const del = await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'vehicles', id: 'v2', data: { ...v2, buyEntry: '' } }, { op: 'delete', collection: 'entries', id: 'vb_v2' }, { op: 'delete', collection: 'vehicles', id: 'v2' }] }, yard.id);
  assert.equal(del.status, 200, JSON.stringify(del.json));

  // The activity log never has a seller's full ID number.
  const log = await call('GET', '/api/c/audit?collection=vehicles&limit=50', undefined, yard.id);
  assert.equal(log.status, 200);
  for (const row of log.json.rows) {
    const full = (await call('GET', `/api/c/audit/${row.seq}`, undefined, yard.id)).json;
    assert.ok(!JSON.stringify(full).includes('D1234-56789-01234'), 'ID number masked');
  }
});

test('an owner can add or remove the add-on later', async () => {
  let r = await call('PUT', `/api/companies/${plain.id}`, { scrapyard: true });
  assert.equal(r.status, 200); assert.equal(r.json.company.scrapyard, true);
  assert.equal((await state(plain.id)).addons.scrapyard, true);
  r = await call('PUT', `/api/companies/${plain.id}`, { scrapyard: false });
  assert.equal(r.json.company.scrapyard, false);
});

test('checkout and subscriptions carry a line for each add-on', async () => {
  const calls = [];
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const fakeFetch = async (url, o) => {
    const p = new URL(url).pathname.replace('/v1/', ''), body = Object.fromEntries(new URLSearchParams(o.body || ''));
    calls.push({ p, body });
    if (p === 'prices') return ok({ id: 'price_' + (body['metadata[sumlora_addon]'] || body['metadata[sumlora_plan]']) });
    if (p === 'checkout/sessions') return ok({ id: 'cs_1', url: 'https://checkout.example/cs_1' });
    return ok({});
  };
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-yard-bill-'));
  try {
    const b = new Billing(bdir, { fetch: fakeFetch });
    assert.equal(b.data.amounts.scrapyard, PLANS.ADDONS.scrapyard.cents);
    b.data.key = 'sk_test_' + 'x'.repeat(24);
    await b.checkout({ kind: 'firm', id: 'f1', plan: 'plus', quantity: 3, addons: { assistant: 1, scrapyard: 2 }, base: 'http://x' });
    const s = calls.find(c => c.p === 'checkout/sessions').body;
    assert.equal(s['line_items[0][quantity]'], '3');
    assert.deepEqual([s['line_items[1][price]'], s['line_items[1][quantity]'], s['line_items[2][price]'], s['line_items[2][quantity]']], ['price_assistant', '1', 'price_scrapyard', '2']);
  } finally { fs.rmSync(bdir, { recursive: true, force: true }); }
});
