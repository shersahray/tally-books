'use strict';
// Credit notes and vendor credits, the PDF writer, and email through the company's own mailbox.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createApp } = require('../src/server/app');
const PDF = require('../public/pdf.js');

let server, base, dir, co, cookie, smtp;
const got = []; // messages the test mail server received
let smtpRejectAuth = false;
before(async () => {
  // A small SMTP server: plain connection, AUTH PLAIN, records each message.
  smtp = net.createServer(sock => {
    let mode = 'cmd', data = '', cur = { rcpt: [] };
    sock.write('220 test ESMTP\r\n');
    let buf = '';
    sock.on('data', chunk => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (line === '.') { mode = 'cmd'; cur.data = data; got.push(cur); cur = { rcpt: [] }; data = ''; sock.write('250 queued\r\n'); }
          else data += line + '\r\n';
          continue;
        }
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) { cur.auth = Buffer.from(line.split(' ')[2], 'base64').toString(); sock.write(smtpRejectAuth ? '535 5.7.8 bad credentials\r\n' : '235 ok\r\n'); }
        else if (/^MAIL FROM/i.test(line)) { cur.from = line; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO/i.test(line)) { cur.rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { mode = 'data'; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.end('221 bye\r\n'); }
        else sock.write('500 what\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-docs-'));
  server = createApp({ dataDir: dir, autoBackup: false, mailAllowLocal: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Docs Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const doc = (kind, number, contactId, total, extra = {}) => ({ kind, number, date: '2026-09-01', due: '2026-10-01', contactId, lines: [{ desc: 'x', account: 'a4000', qty: 1, rate: total, taxCode: 'none' }], sub: total, tax: 0, total, ...extra });
const post = (kind, id, total) => ({ type: kind, date: '2026-09-01', docId: id, lines: kind === 'invoice' ? [{ account: 'a1200', debit: total, credit: 0 }, { account: 'a4000', debit: 0, credit: total }] : [{ account: 'a4000', debit: total, credit: 0 }, { account: 'a1200', debit: 0, credit: total }] });

test('credit notes: applied to invoices, limits, refunds, protected invoices', async () => {
  for (const [id, name] of [['c1', 'Ana'], ['c2', 'Ben']]) await call('PUT', `/api/c/records/contacts/${id}`, { name, kind: 'customer', email: `${name.toLowerCase()}@example.com` });
  const w = [
    { op: 'set', collection: 'docs', id: 'i1', data: doc('invoice', '1001', 'c1', 500) }, { op: 'set', collection: 'entries', id: 'd_i1', data: post('invoice', 'i1', 500) },
    { op: 'set', collection: 'docs', id: 'i2', data: doc('invoice', '1002', 'c2', 300) }, { op: 'set', collection: 'entries', id: 'd_i2', data: post('invoice', 'i2', 300) },
    { op: 'set', collection: 'docs', id: 'cn1', data: doc('credit', 'CN-1001', 'c1', 200, { due: '', applied: [{ docId: 'i1', amount: 150 }] }) }, { op: 'set', collection: 'entries', id: 'd_cn1', data: post('credit', 'cn1', 200) },
  ];
  assert.equal((await call('POST', '/api/c/batch', { writes: w })).status, 200);
  const cn = (await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'cn1');
  const put = applied => call('PUT', '/api/c/records/docs/cn1', { ...cn, id: undefined, applied });
  assert.equal((await put([{ docId: 'i1', amount: 250 }])).status, 400, 'more than the credit is worth');
  assert.equal((await put([{ docId: 'i2', amount: 50 }])).status, 400, 'another customer’s invoice');
  assert.equal((await put([{ docId: 'cn1', amount: 50 }])).status, 400, 'a credit isn’t applied to a credit');
  assert.equal((await call('DELETE', '/api/c/records/docs/i1')).status, 409, 'invoice with a credit on it');
  // Refund the rest (50) to the customer; a refund can't point at an invoice.
  const refund = (applyTo, amount) => ({ type: 'refund', date: '2026-09-05', applyTo, amount, contactId: 'c1', bank: 'a1000', lines: [{ account: 'a1200', debit: amount, credit: 0 }, { account: 'a1000', debit: 0, credit: amount }] });
  assert.equal((await call('PUT', '/api/c/records/entries/r1', refund('cn1', 50))).status, 200);
  assert.equal((await call('PUT', '/api/c/records/entries/r2', refund('i1', 10))).status, 400);
  assert.equal((await put([{ docId: 'i1', amount: 151 }])).status, 400, 'refund plus applied can’t pass the credit');
  // Payment on the invoice can only cover what's left after the credit (checked when applying more credit).
  const pay = { type: 'payment', date: '2026-09-10', applyTo: 'i1', amount: 350, contactId: 'c1', bank: 'a1000', lines: [{ account: 'a1000', debit: 350, credit: 0 }, { account: 'a1200', debit: 0, credit: 350 }] };
  assert.equal((await call('PUT', '/api/c/records/entries/p1', pay)).status, 200);
  assert.equal((await put([{ docId: 'i1', amount: 151 }])).status, 400, 'invoice fully settled');
  // The server caps payments and refunds too, and they go to the right kind of document.
  assert.equal((await call('PUT', '/api/c/records/entries/p2', { ...pay, amount: 1 })).status, 400, 'nothing left owing');
  assert.equal((await call('PUT', '/api/c/records/entries/r3', refund('cn1', 1))).status, 400, 'nothing left on the credit');
  assert.equal((await call('PUT', '/api/c/records/entries/p3', { ...pay, applyTo: 'cn1', amount: 1 })).status, 400, 'a payment doesn’t go to a credit note');
  assert.equal((await call('PUT', '/api/c/records/entries/p1', { ...pay, amount: 350, memo: 'edited' })).status, 200, 'editing a payment doesn’t count it twice');
  // The company list counts credits.
  const sum = (await call('GET', '/api/companies')).json.companies.find(c => c.id === co);
  assert.equal(sum.receivable, 300); assert.equal(sum.payable || 0, 0);
});

test('PDF writer: valid file with text, pages and a JPEG', () => {
  const d = PDF.create();
  d.text(50, 60, 'Facture n° 1001 — Café', { size: 18, bold: true });
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0000b080002000301011100ffd9', 'hex');
  assert.deepEqual(PDF.jpegSize(jpeg), { h: 2, w: 3, comps: 1 });
  d.image(jpeg, 50, 80, 100, 50);
  d.addPage(); d.text(50, 50, 'Page 2');
  const out = Buffer.from(d.output());
  const s = out.toString('latin1');
  assert.match(s, /^%PDF-1\.4/); assert.match(s, /\/Count 2/); assert.match(s, /\/DCTDecode/); assert.match(s, /%%EOF\n$/);
  assert.match(s, /Caf\\351/, 'é in WinAnsi');
  const xref = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.equal(s.slice(xref, xref + 4), 'xref');
  assert.ok(PDF.widthOf('WWW', 10) > PDF.widthOf('iii', 10));
});

test('email: settings stay private, PDFs go out from the company’s mailbox, mistakes are caught', async () => {
  assert.equal((await call('GET', '/api/c/mail')).json.configured, false);
  assert.equal((await call('POST', '/api/c/mail/send', { to: 'ana@example.com', subject: 'x', text: 'y' })).status, 409);
  const M = require('../src/server/mail.js');
  assert.throws(() => M.validateMail({ host: 'smtp.example.com', port: 25, security: 'none', user: 'me@example.com', pass: 'x' }), /secure connection/, 'no unencrypted mail');
  await assert.rejects(M.send({ host: 'localhost', port: 25, security: 'ssl', user: 'a@b.ca', pass: 'x', fromEmail: 'a@b.ca' }, { to: ['c@d.ca'], subject: 's', text: 't' }), /private network/);
  const cfg = { host: '127.0.0.1', port: smtp.address().port, security: 'none', user: 'books@docsco.ca', pass: 'app-password-123', fromName: 'Docs Co' };
  let r = await call('PUT', '/api/c/mail', cfg);
  assert.equal(r.status, 200); assert.equal(r.json.fromEmail, 'books@docsco.ca');
  assert.ok(!JSON.stringify((await call('GET', '/api/c/mail')).json).includes('app-password-123'));
  // Saving without a password keeps the old one, but only for the same server and user.
  assert.equal((await call('PUT', '/api/c/mail', { ...cfg, pass: '', fromName: 'Docs Co Ltd' })).status, 200);
  const moved = await call('PUT', '/api/c/mail', { ...cfg, host: 'localhost', pass: '' });
  assert.equal(moved.status, 400); assert.match(moved.json.error, /password again/);
  assert.equal((await call('POST', '/api/c/mail/test', {})).status, 200);
  assert.equal(got.at(-1).auth, '\u0000books@docsco.ca\u0000app-password-123');
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  r = await call('POST', '/api/c/mail/send', { to: 'ana@example.com', cc: 'boss@example.com', subject: 'Invoice 1001\r\nBcc: evil@example.com', text: 'Hello Ana,\n.\nBye', attachments: [{ name: 'Invoice-1001.pdf', data: pdf }], docIds: ['i1'], what: 'invoice' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const m = got.at(-1);
  assert.deepEqual(m.rcpt, ['RCPT TO:<ana@example.com>', 'RCPT TO:<boss@example.com>']);
  assert.match(m.from, /books@docsco\.ca/);
  assert.match(m.data, /^Subject: Invoice 1001 Bcc: evil@example\.com$/m, 'line breaks in a subject can’t add headers');
  assert.ok(!/^Bcc:/m.test(m.data));
  assert.match(m.data, /From: "Docs Co Ltd" <books@docsco\.ca>/);
  assert.match(m.data, /filename="Invoice-1001\.pdf"/);
  const sent = (await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'i1').sent;
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'ana@example.com'); assert.equal(sent[0].what, 'invoice');
  assert.equal((await call('POST', '/api/c/mail/send', { to: 'not-an-address', subject: 's', text: 't' })).status, 400);
  assert.equal((await call('POST', '/api/c/mail/send', { to: 'ana@example.com', subject: 's', text: 't', attachments: [{ name: 'x.exe', data: Buffer.from('MZ').toString('base64') }] })).status, 400);
  smtpRejectAuth = true;
  r = await call('POST', '/api/c/mail/test', {});
  assert.equal(r.status, 502); assert.match(r.json.error, /app password/);
  smtpRejectAuth = false;
  assert.ok((await call('GET', '/api/c/mail')).json.sentToday >= 2);
  const log = (await call('GET', '/api/c/audit')).json.rows.map(x => x.action);
  assert.ok(log.includes('email') && log.includes('mail'));
});

test('logo: only JPEG, replaced cleanly', async () => {
  assert.equal((await call('PUT', '/api/c/logo', { data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') })).status, 400);
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');
  const a = (await call('PUT', '/api/c/logo', { data: jpeg })).json.logoFile;
  const b = (await call('PUT', '/api/c/logo', { data: jpeg })).json.logoFile;
  assert.notEqual(a, b);
  assert.equal((await fetch(`${base}/api/c/${co}/files/${a}`, { headers: { cookie } })).status, 404, 'the old logo is gone');
  assert.equal((await call('GET', '/api/c/state')).json.company.logoFile, b);
  const st = (await call('GET', '/api/c/state')).json;
  await call('PUT', '/api/c/settings', { ...st.company, logoFile: 'something-else', address: '1 Main St\nToronto ON' });
  const c2 = (await call('GET', '/api/c/state')).json.company;
  assert.equal(c2.logoFile, b, 'settings can’t point the logo at another file'); assert.equal(c2.address, '1 Main St\nToronto ON');
});
