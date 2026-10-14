'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// Receipts by email: the server's settings, each company's address, the Postmark and SendGrid webhooks, and the limits.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../src/server/app');
const inbound = require('../src/server/inbound');

let server, fake, base, dir, co, co2, cookie = '', clientCookie = '', secret = '', address = '', aiCalls = 0;
const KEY = 'sk-ant-api03-' + 'm'.repeat(40);
const PDF = Buffer.from('%PDF-1.4\n%fake receipt\n');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40 * 1024, 7)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(100, 1)]);

before(async () => {
  fake = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      aiCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'record_document', input: { paid: true, vendorName: 'Costco', date: '2026-10-01', lines: [{ description: 'Supplies', amount: 40, account: '', taxable: true }], taxes: [{ name: 'HST', amount: 5.2 }], total: 45.2, confidence: 'high', reason: '' } }], usage: { input_tokens: 1000, output_tokens: 100 } }));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-inb-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, password: 'basic-auth-on-the-rest', aiUrl: `http://127.0.0.1:${fake.address().port}/v1/messages` });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', ...basic }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Mail Co', province: 'ON' })).json.company.id;
  co2 = (await call('POST', '/api/companies', { name: 'Other Co', province: 'ON' })).json.company.id;
  const link = (await call('POST', '/api/users', { name: 'Cli', username: 'cli@example.com', role: 'client', companies: [co], invite: true })).json.user.link;
  const a = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json', ...basic }, body: JSON.stringify({ token: link, password: 'purple walrus harbour lantern' }) });
  clientCookie = a.headers.get('set-cookie').split(';')[0];
});
after(async () => { await server.shutdown(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const basic = { authorization: 'Basic ' + Buffer.from('x:basic-auth-on-the-rest').toString('base64') };
async function call(method, url, body, ck = cookie) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { ...basic, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), cookie: ck }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
// The mail provider: no cookie, no password, just the secret in the address.
async function hook(body, { s = secret, type = 'application/json' } = {}) {
  const res = await fetch(`${base}/api/inbound/email/${encodeURIComponent(s)}`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const postmark = (o = {}) => ({ From: '"Pat Lee" <pat@client.example>', FromFull: { Email: 'pat@client.example', Name: 'Pat Lee' }, To: address, ToFull: [{ Email: address }], OriginalRecipient: address,
  Subject: 'Costco receipt', TextBody: 'See attached.', HtmlBody: '', Attachments: [{ Name: 'costco.pdf', ContentType: 'application/pdf', Content: PDF.toString('base64'), ContentLength: PDF.length }], ...o });
const stateOf = async c => (await (await fetch(`${base}/api/c/${c}/state`, { headers: { ...basic, cookie } })).json());

test('administrator turns it on; the company gets an address it can change', async () => {
  // Nothing set up: the webhook doesn't exist.
  assert.equal((await hook(postmark(), { s: 'anything' })).status, 404);
  assert.equal((await call('PUT', '/api/inbound', { on: true })).status, 400, 'a domain is needed first');
  assert.equal((await call('PUT', '/api/inbound', { domain: 'https://bad domain' })).status, 400);
  const st = (await call('PUT', '/api/inbound', { domain: 'In.Example.com', on: true })).json;
  assert.equal(st.domain, 'in.example.com'); assert.ok(st.ready); assert.ok(st.secret.length >= 40);
  assert.match(st.webhook, new RegExp(`/api/inbound/email/${st.secret}$`));
  secret = st.secret;
  assert.equal((await call('GET', '/api/inbound', undefined, clientCookie)).json.secret, undefined, 'only the administrator sees the secret');
  assert.equal((await call('PUT', '/api/inbound', { on: false }, clientCookie)).status, 403);
  // Each company's address: long and random, made the first time it's shown.
  const a = (await call('GET', '/api/c/receipts/email')).json;
  assert.equal(a.feature, true);
  assert.match(a.address, /^r-[0-9a-f]{32}@in\.example\.com$/);
  assert.equal((await call('GET', '/api/c/receipts/email', undefined, clientCookie)).status, 403, 'clients don’t manage it');
  // A new address: the old one stops working.
  const old = a.address;
  address = (await call('POST', '/api/c/receipts/email/new')).json.address;
  assert.notEqual(address, old);
  const r = await hook(postmark({ To: old, ToFull: [{ Email: old }], OriginalRecipient: old }));
  assert.equal(r.status, 200); assert.ok(r.json.ignored, 'the old address is nobody’s');
  assert.equal((await stateOf(co)).receipts.length, 0);
});

test('Postmark: a PDF lands in the right company’s receipts, read by AI, with the sender and subject', async () => {
  await call('PUT', '/api/ai', { apiKey: KEY, capUsd: 20 });
  const st0 = await stateOf(co);
  await call('PUT', '/api/c/settings', { ...st0.company, ai: true });
  const r = await hook(postmark());
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.results[0].company, co);
  let rec;
  for (let i = 0; i < 60; i++) { rec = (await stateOf(co)).receipts[0]; if (rec && rec.readStatus === 'read') break; await new Promise(z => setTimeout(z, 50)); }
  assert.equal(rec.mediaType, 'application/pdf'); assert.equal(rec.fileName, 'costco.pdf');
  assert.equal(rec.source, 'email'); assert.equal(rec.emailFrom, 'pat@client.example'); assert.equal(rec.emailSubject, 'Costco receipt');
  assert.equal(rec.readStatus, 'read'); assert.equal(rec.draft.total, 45.2);
  assert.equal((await stateOf(co2)).receipts.length, 0, 'not in another company');
  // The file is the one sent.
  const f = await fetch(`${base}/api/c/${co}/files/${rec.fileId}`, { headers: { ...basic, cookie } });
  assert.deepEqual(Buffer.from(await f.arrayBuffer()), PDF);
  // The activity log says where it came from.
  const audit = (await call('GET', '/api/c/audit')).json.rows;
  assert.ok(audit.some(x => x.summary === 'Receipt emailed in from pat@client.example'));
  // The sender and subject survive an edit by the bookkeeper.
  const { id, ...data } = rec;
  await call('PUT', `/api/c/records/receipts/${id}`, { ...data, note: 'ok', emailFrom: 'forged@x.com' });
  const after = (await stateOf(co)).receipts.find(x => x.id === id);
  assert.equal(after.emailFrom, 'pat@client.example'); assert.equal(after.note, 'ok');
});

test('the webhook refuses a wrong secret, and anything not addressed to a company', async () => {
  assert.equal((await hook(postmark(), { s: secret + 'x' })).status, 404);
  assert.equal((await hook(postmark(), { s: '' })).status, 404);
  assert.equal((await hook('hello', { type: 'text/plain' })).status, 415);
  const unknown = 'r-' + '0'.repeat(32) + '@in.example.com';
  const r = await hook(postmark({ To: unknown, ToFull: [{ Email: unknown }], OriginalRecipient: unknown }));
  assert.equal(r.status, 200); assert.equal(r.json.ok, false);
  const other = address.replace('in.example.com', 'elsewhere.com');
  assert.equal((await hook(postmark({ To: other, ToFull: [{ Email: other }], OriginalRecipient: other }))).json.ok, false, 'our token at someone else’s domain');
});

test('allowed senders: others are refused and logged', async () => {
  assert.equal((await call('PUT', '/api/c/receipts/email', { allowed: ['not an email'] })).status, 400);
  assert.equal((await call('PUT', '/api/c/receipts/email', { allowed: ['Boss@Client.example', '@shop.example'] })).status, 200);
  const before = (await stateOf(co)).receipts.length;
  const r = await hook(postmark({ From: 'eve@evil.example', FromFull: { Email: 'eve@evil.example', Name: '' } }));
  assert.equal(r.status, 200); assert.match(r.json.results[0].rejected, /allowed senders/);
  assert.equal((await stateOf(co)).receipts.length, before);
  const info = (await call('GET', '/api/c/receipts/email')).json;
  assert.equal(info.rejected[0].from, 'eve@evil.example');
  // A whole domain, and an exact address (in any case).
  assert.equal((await hook(postmark({ From: 'a@shop.example', FromFull: { Email: 'A@Shop.example' } }))).json.ok, true);
  assert.equal((await hook(postmark({ From: 'boss@client.example', FromFull: { Email: 'boss@client.example' } }))).json.ok, true);
  await call('PUT', '/api/c/receipts/email', { allowed: [] });
});

test('only PDFs and photos; too big is refused; an email with no attachment becomes a PDF of its text', async () => {
  const n0 = (await stateOf(co)).receipts.length;
  // An HTML page or a program dressed up as a PDF isn't kept.
  const bad = await hook(postmark({ Attachments: [{ Name: 'invoice.pdf', ContentType: 'application/pdf', Content: Buffer.from('<html><script>alert(1)</script>').toString('base64') }, { Name: 'x.exe', ContentType: 'application/octet-stream', Content: Buffer.from('MZ\x90\x00').toString('base64') }] }));
  assert.match(bad.json.results[0].rejected, /not a PDF or photo/);
  // One file over 10 MB.
  const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024)]);
  const r = await hook(postmark({ Attachments: [{ Name: 'big.pdf', ContentType: 'application/pdf', Content: big.toString('base64') }] }));
  assert.match(r.json.results[0].rejected, /over 10 MB/);
  // The whole email over 25 MB.
  const nine = Buffer.concat([PDF, Buffer.alloc(9 * 1024 * 1024)]).toString('base64');
  const r2 = await hook(postmark({ Attachments: [1, 2, 3].map(i => ({ Name: `p${i}.pdf`, ContentType: 'application/pdf', Content: nine })) }));
  assert.equal(r2.status, 413);
  assert.equal((await stateOf(co)).receipts.length, n0);
  // A small inline logo is skipped; a photo and an iPhone HEIC are kept (HEIC isn't sent to AI).
  const tiny = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500)]);
  const r3 = await hook(postmark({ Attachments: [{ Name: 'logo.jpg', ContentType: 'image/jpeg', ContentID: 'logo@x', Content: tiny.toString('base64') }, { Name: 'IMG_1.HEIC', ContentType: 'image/heic', Content: HEIC.toString('base64') }, { Name: 'photo.jpg', ContentType: 'image/jpeg', Content: JPEG.toString('base64') }] }));
  assert.equal(r3.json.results[0].receipts.length, 2);
  const list = (await stateOf(co)).receipts;
  const heic = list.find(x => x.mediaType === 'image/heic');
  assert.equal(heic.readStatus, 'off'); assert.match(heic.readError, /HEIC/);
  // No attachment: the text of the email is the receipt.
  const r4 = await hook(postmark({ Subject: 'Your Uber receipt', TextBody: '', HtmlBody: '<html><style>p{}</style><p>Total: <b>$18.40</b></p><script>x()</script></html>', Attachments: [] }));
  assert.equal(r4.json.ok, true);
  const body = (await stateOf(co)).receipts.find(x => x.id === r4.json.results[0].receipts[0]);
  assert.equal(body.mediaType, 'application/pdf'); assert.equal(body.fileName, 'Your Uber receipt.pdf');
  const pdf = Buffer.from(await (await fetch(`${base}/api/c/${co}/files/${body.fileId}`, { headers: { ...basic, cookie } })).arrayBuffer()).toString('latin1');
  assert.match(pdf, /Total: \$18\.40/); assert.doesNotMatch(pdf, /x\(\)|<b>/);
});

test('SendGrid Inbound Parse (multipart form) is read too', async () => {
  const B = '----xyzBOUNDARY';
  const part = (name, value) => `--${B}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('from', 'Sam Roy <sam@client.example>') + part('to', `Receipts <${address}>`) + part('subject', 'Home Depot') + part('text', 'attached') +
      part('envelope', JSON.stringify({ to: [address], from: 'sam@client.example' })) + part('attachments', '1') +
      part('attachment-info', JSON.stringify({ attachment1: { filename: 'hd.pdf', type: 'application/pdf' } })) +
      `--${B}\r\nContent-Disposition: form-data; name="attachment1"; filename="hd.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    PDF, Buffer.from(`\r\n--${B}--\r\n`),
  ]);
  const r = await hook(body, { type: `multipart/form-data; boundary=${B}` });
  assert.equal(r.status, 200); assert.equal(r.json.ok, true);
  const rec = (await stateOf(co)).receipts.find(x => x.id === r.json.results[0].receipts[0]);
  assert.equal(rec.emailFrom, 'sam@client.example'); assert.equal(rec.emailSubject, 'Home Depot'); assert.equal(rec.fileName, 'hd.pdf');
  const f = Buffer.from(await (await fetch(`${base}/api/c/${co}/files/${rec.fileId}`, { headers: { ...basic, cookie } })).arrayBuffer());
  assert.deepEqual(f, PDF, 'the file comes through byte for byte');
});

test('a plan without the feature: emails are refused, settings can’t be changed', async () => {
  const firms = (await call('GET', '/api/firms')).json;
  assert.equal((await call('PUT', `/api/firms/${firms.myFirm}`, { plan: 'essentials' })).status, 200);
  const n = (await stateOf(co)).receipts.length;
  const r = await hook(postmark());
  assert.match(r.json.results[0].rejected, /plan/);
  assert.equal((await stateOf(co)).receipts.length, n);
  assert.equal((await call('GET', '/api/c/receipts/email')).json.feature, false);
  assert.equal((await call('POST', '/api/c/receipts/email/new')).status, 403);
  assert.equal((await call('PUT', '/api/c/receipts/email', { allowed: [] })).status, 403);
  await call('PUT', `/api/firms/${firms.myFirm}`, { plan: 'plus' });
  // A company that switched the feature off is treated the same.
  const st = await stateOf(co);
  await call('PUT', '/api/c/settings', { ...st.company, features: { emailReceipts: false } });
  assert.match((await hook(postmark())).json.results[0].rejected, /plan/);
  await call('PUT', '/api/c/settings', { ...st.company, features: {} });
});

test('each company takes at most 60 emails an hour', async () => {
  let last;
  for (let i = 0; i < 70; i++) { last = await hook(postmark({ Attachments: [], TextBody: 'x' + i })); if (last.status === 429) break; }
  assert.equal(last.status, 429);
});

test('parsing helpers', () => {
  assert.deepEqual(inbound.addrsIn('"A, B" <a@b.co>, c@d.example'), ['a@b.co', 'c@d.example']);
  assert.equal(inbound.senderAllowed([], 'x@y.z'), true);
  assert.equal(inbound.senderAllowed(['@y.com'], 'x@y.com'), true);
  assert.equal(inbound.senderAllowed(['@y.com'], 'x@evily.com.au'), false);
  assert.equal(inbound.senderAllowed(['@y.com'], 'x@noty.com'), false, 'a domain rule needs the whole domain');
  assert.equal(inbound.sniffInbound(HEIC), 'image/heic');
  assert.equal(inbound.sniffInbound(Buffer.from('MZ\x90\x00 program')), '');
  assert.equal(inbound.htmlToText('<p>A&amp;B</p><script>bad()</script><p>&#36;5</p>'), 'A&B\n$5');
});
