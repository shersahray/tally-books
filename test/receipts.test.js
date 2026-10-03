'use strict';
// Receipts sent from a phone: storage, who can do what, AI reading in the background, attaching, backups.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/server/app');

let server, fake, base, dir, co, cookie = '', clientCookie = '', otherCookie = '';
const KEY = 'sk-ant-api03-' + 'r'.repeat(40);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = Buffer.from('%PDF-1.4\n%fake\n');

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      const j = JSON.parse(b);
      const ctx = JSON.parse(j.system[1].text.replace('Company data:\n', ''));
      const office = ctx.accounts.find(a => /Office/.test(a.name)).id;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_document', input: { paid: true, vendorName: 'Staples', date: '2026-09-12', lines: [{ description: 'Paper', amount: 20, account: office, taxable: true }], taxes: [{ name: 'HST', amount: 2.6 }], total: 22.6, confidence: 'high', reason: '' } }], usage: { input_tokens: 2000, output_tokens: 200 } }));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-rc-'));
  server = createApp({ dataDir: dir, autoBackup: false, aiUrl: `http://127.0.0.1:${fake.address().port}/v1/messages` });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Receipt Co', province: 'ON' })).json.company.id;
  const invite = async (username, extra = {}) => {
    const link = (await call('POST', '/api/users', { name: username, username, role: 'client', companies: [co], invite: true, ...extra })).json.user.link;
    const a = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link, password: username.startsWith('client') ? 'purple walrus harbour lantern' : 'quiet maple ferry orbit' }) });
    return a.headers.get('set-cookie').split(';')[0];
  };
  clientCookie = await invite('client@example.com');
  otherCookie = await invite('other@example.com');
});
after(async () => { await server.shutdown(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, url, body, ck = cookie) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), cookie: ck }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}
const send = (buf, name, ck) => call('POST', '/api/c/receipts', { fileName: name, mediaType: 'image/jpeg', data: buf.toString('base64') }, ck);
const state = async () => (await call('GET', '/api/c/state')).json;

test('receipts: sending, viewing, and only real photos or PDFs', async () => {
  const r = await send(JPEG, 'lunch.jpg', clientCookie);
  assert.equal(r.status, 200);
  const rec = (await state()).receipts.find(x => x.id === r.json.id);
  assert.equal(rec.status, 'inbox'); assert.equal(rec.uploadedBy, 'client@example.com'); assert.equal(rec.readStatus, 'off', 'AI isn’t set up');
  assert.equal(rec.mediaType, 'image/jpeg', 'type comes from the file itself');
  const f = await fetch(`${base}/api/c/${co}/files/${rec.fileId}`, { headers: { cookie: clientCookie } });
  assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'image/jpeg');
  assert.match(f.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), JPEG);
  const p = await send(PDF, 'bill.pdf', cookie);
  assert.equal((await state()).receipts.find(x => x.id === p.json.id).mediaType, 'application/pdf');
  // An HTML page dressed up as a photo is refused.
  assert.equal((await send(Buffer.from('<html><script>alert(1)</script></html>'), 'x.jpg', cookie)).status, 400);
  assert.equal((await send(Buffer.alloc(0), 'x.jpg', cookie)).status, 400);
  // Receipts can't be made up without a file, and what AI read can't be forged.
  assert.equal((await call('PUT', '/api/c/records/receipts/fake1', { status: 'inbox', fileId: 'nope' })).status, 400);
  await call('PUT', `/api/c/records/receipts/${p.json.id}`, { status: 'inbox', note: 'hi', draft: { total: 999 }, uploadedBy: 'someone' });
  const p2 = (await state()).receipts.find(x => x.id === p.json.id);
  assert.equal(p2.draft, undefined); assert.equal(p2.uploadedBy, 'owner@example.com'); assert.equal(p2.note, 'hi');
});

test('receipts: clients add notes or remove their own, the bookkeeper does the rest', async () => {
  const mine = (await send(JPEG, 'a.jpg', clientCookie)).json.id;
  const st = await state(); const r = st.receipts.find(x => x.id === mine);
  const { id, ...data } = r;
  assert.equal((await call('PUT', `/api/c/records/receipts/${mine}`, { ...data, note: 'Client lunch' }, clientCookie)).status, 200);
  assert.equal((await call('PUT', `/api/c/records/receipts/${mine}`, { ...data, status: 'discarded' }, clientCookie)).status, 403);
  assert.equal((await call('DELETE', `/api/c/records/receipts/${mine}`, undefined, otherCookie)).status, 403, 'not someone else’s');
  assert.equal((await call('POST', `/api/c/receipts/${mine}/read`, undefined, clientCookie)).status, 403, 'clients don’t start AI');
  const fileId = r.fileId;
  assert.equal((await call('DELETE', `/api/c/records/receipts/${mine}`, undefined, clientCookie)).status, 200);
  assert.equal((await fetch(`${base}/api/c/${co}/files/${fileId}`, { headers: { cookie } })).status, 404, 'the photo goes too');
});

test('receipts: read by AI in the background, attached to an expense, kept as proof', async () => {
  await call('PUT', '/api/ai', { apiKey: KEY, capUsd: 20 });
  const st0 = await state();
  await call('PUT', '/api/c/settings', { ...st0.company, ai: true });
  const id = (await send(JPEG, 'staples.jpg', clientCookie)).json.id;
  let r;
  for (let i = 0; i < 50; i++) { r = (await state()).receipts.find(x => x.id === id); if (r.readStatus === 'read') break; await new Promise(z => setTimeout(z, 50)); }
  assert.equal(r.readStatus, 'read'); assert.equal(r.draft.total, 22.6); assert.equal(r.draft.vendorName, 'Staples');
  // The bookkeeper records it as an expense and attaches the receipt.
  const office = st0.accounts.find(a => /Office/.test(a.name)).id;
  const e = { type: 'expense', date: '2026-09-12', memo: 'Staples', receiptId: id, lines: [{ account: office, debit: 22.6, credit: 0 }, { account: 'a1000', debit: 0, credit: 22.6 }] };
  assert.equal((await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'entries', id: 'e1', data: e }, { op: 'set', collection: 'receipts', id, data: { ...r, id: undefined, status: 'done', entryId: 'e1' } }] })).status, 200);
  assert.equal((await call('DELETE', `/api/c/records/receipts/${id}`)).status, 409, 'attached receipts are kept');
  // Deleting the expense sends the receipt back to review.
  assert.equal((await call('DELETE', '/api/c/records/entries/e1')).status, 200);
  const back = (await state()).receipts.find(x => x.id === id);
  assert.equal(back.status, 'inbox'); assert.equal(back.entryId, '');
  assert.equal((await call('DELETE', `/api/c/records/receipts/${id}`, undefined, clientCookie)).status, 403, 'once recorded, the client who sent it can’t remove the proof');
  assert.equal((await call('POST', '/api/c/batch', { writes: [{ op: 'set', collection: 'receipts', id: 'new-one', data: { ...back, id: undefined } }] })).status, 400, 'no copies made by a plain write');
});

test('receipts: photos are backed up once, in their own folder', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-rcb-'));
  assert.equal((await call('PUT', '/api/backups', { folder: out, enabled: true })).status, 200);
  assert.equal((await call('POST', '/api/backups/run', {})).status, 200);
  const rdir = path.join(out, 'Sumlora Backups', 'Receipts', co);
  const files = fs.readdirSync(rdir);
  assert.ok(files.some(f => f.endsWith('.jpg')) && files.some(f => f.endsWith('.pdf')));
  fs.rmSync(out, { recursive: true, force: true });
});
