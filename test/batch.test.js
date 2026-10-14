'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// Batch actions on invoices: which ticked documents each action takes, sending one at a time through the mail
// route (with a stub SMTP server), "Mark as sent", and the combined PDF.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { createApp } = require('../src/server/app');
const B = require('../public/batch.js');

/* ---------- pure logic ---------- */
const D = (id, kind, number, date, contactId) => ({ id, kind, number, date, contactId });
const emails = { c1: 'ana@example.com', c2: '', c3: 'cy@example.com' };
const opts = { emailOf: d => emails[d.contactId] || '', isOverdue: d => d.id === 'i2' || d.id === 'i3' };
const picked = [D('i3', 'invoice', '1010', '2026-09-01', 'c3'), D('i1', 'invoice', '1002', '2026-09-01', 'c1'), D('i2', 'invoice', '1001', '2026-08-15', 'c2'),
  D('cn', 'credit', 'CN-1', '2026-09-03', 'c1'), D('sr', 'sreceipt', 'SR-1', '2026-09-04', 'c2'), D('b1', 'bill', 'B-9', '2026-09-02', 'c1')];

test('order: oldest first, then by number (1002 before 1010)', () => {
  assert.deepEqual(B.order(picked).map(d => d.id), ['i2', 'i1', 'i3', 'b1', 'cn', 'sr']);
});

test('send: invoices, credit notes and receipts with an email go; no email or a bill is skipped', () => {
  const p = B.plan('send', picked, opts);
  assert.deepEqual(p.go.map(d => d.id), ['i1', 'i3', 'cn']);
  assert.deepEqual(p.skip.map(s => [s.doc.id, s.why]), [['i2', 'noemail'], ['b1', 'kind'], ['sr', 'noemail']]);
});

test('remind: only overdue invoices with an email', () => {
  const p = B.plan('remind', picked, opts);
  assert.deepEqual(p.go.map(d => d.id), ['i3']);
  assert.deepEqual(Object.fromEntries(p.skip.map(s => [s.doc.id, s.why])), { i2: 'noemail', i1: 'notoverdue', b1: 'notoverdue', cn: 'notoverdue', sr: 'notoverdue' });
});

test('print takes every sales document (email doesn’t matter); mark takes invoices only', () => {
  assert.deepEqual(B.plan('print', picked, opts).go.map(d => d.id), ['i2', 'i1', 'i3', 'cn', 'sr']);
  const m = B.plan('mark', picked, opts);
  assert.deepEqual(m.go.map(d => d.id), ['i2', 'i1', 'i3']);
  assert.deepEqual(m.skip.map(s => s.why), ['kind', 'kind', 'kind']);
  assert.throws(() => B.plan('delete', picked, opts), /Unknown/);
  assert.deepEqual(B.plan('send', [], opts), { go: [], skip: [] });
});

test('runSequential: one at a time, a failure doesn’t stop the rest, the daily limit does', async () => {
  let running = 0, most = 0;
  const seen = [], progress = [];
  const r = await B.runSequential(['a', 'b', 'c', 'd'], async x => {
    running++; most = Math.max(most, running); seen.push(x);
    await new Promise(res => setTimeout(res, 2)); running--;
    if (x === 'b') throw new Error('The email server refused a recipient address.');
  }, (i, n) => progress.push(`${i}/${n}`));
  assert.equal(most, 1, 'never two at once');
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
  assert.deepEqual(progress, ['1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual(r.map(x => x.ok), [true, false, true, true]);
  assert.match(r[1].error, /refused/);
  assert.deepEqual(B.tally(r, [{}, {}]), { sent: 3, failed: 1, skipped: 2 });
  // Once the company's daily limit is reached, the rest aren't tried: they'd all fail the same way.
  const tried = [];
  const lim = await B.runSequential(['a', 'b', 'c'], async x => { tried.push(x); if (x === 'b') { const e = new Error('That’s 200 emails today for this company.'); e.status = 429; throw e; } });
  assert.deepEqual(tried, ['a', 'b']);
  assert.deepEqual(lim.map(x => [x.ok, x.error || '']), [[true, ''], [false, 'That’s 200 emails today for this company.'], [false, 'That’s 200 emails today for this company.']]);
});

/* ---------- combined PDF (docout.js with pdf.js, in a sandbox) ---------- */
function docoutSandbox() {
  const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const ctx = { TextEncoder, Uint8Array, Math, String, Number, Date, Object, Array, JSON, Promise, Error, console };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(pub('pdf.js'), ctx);
  vm.runInContext(`
    const S={company:{name:'Batch Co',lang:'en',taxRate:13},docs:[],entries:[],contacts:[{id:'c1',name:'Ana',email:'ana@example.com'}]};
    const r2=n=>Math.round(((+n)||0)*100)/100, pd=s=>new Date(s+'T12:00:00'), today=()=>'2026-10-11';
    const docStatus=d=>({k:'open',bal:+d.total||0}), paidOn=()=>0, acctName=()=>'Sales', contact=id=>S.contacts.find(c=>c.id===id);
    const splitTaxTotal=t=>[{name:'HST',rate:13,amount:t}], coUrl=u=>u;
  ` + pub('docout.js') + ';this.S=S;this.docPdf=docPdf;this.batchDocsPdf=batchDocsPdf;', ctx);
  return ctx;
}
const pages = bytes => Number(Buffer.from(bytes).toString('latin1').match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)[1]);
const inv = (id, number, n) => ({ id, kind: 'invoice', number, date: '2026-09-0' + (n % 9 + 1), due: '2026-10-30', contactId: 'c1', sub: 10 * n, tax: 0, total: 10 * n,
  lines: Array.from({ length: n }, (_, i) => ({ desc: `Line ${i + 1}`, account: 'a4000', qty: 1, rate: 10 })) });

test('combined PDF: one file, every invoice in order, pages add up, each numbered on its own', async () => {
  const c = docoutSandbox();
  const docs = [inv('a', '1001', 2), inv('b', '1002', 40), inv('c', '1003', 1)];
  c.S.docs = docs;
  const each = [];
  for (const d of docs) each.push(pages(await c.docPdf(d)));
  assert.deepEqual(each, [1, 2, 1], 'the long invoice runs to two pages');
  const out = Buffer.from(await c.batchDocsPdf(docs)).toString('latin1');
  assert.match(out, /^%PDF-1\.4/); assert.match(out, /%%EOF\n$/);
  assert.equal(pages(Buffer.from(out, 'latin1')), 4);
  const xref = Number(out.match(/startxref\n(\d+)/)[1]);
  assert.equal(out.slice(xref, xref + 4), 'xref');
  // In page order: 1001, then 1002 (two pages, "Page 1 of 2" and "Page 2 of 2"), then 1003; single pages aren't numbered.
  const at = s => out.indexOf(s);
  assert.ok(at('(1001)') > 0 && at('(1001)') < at('(1002)') && at('(1002)') < at('(1003)'));
  assert.equal((out.match(/\(Page 1 of 2\)/g) || []).length, 1);
  assert.equal((out.match(/\(Page 2 of 2\)/g) || []).length, 1);
  assert.ok(!/Page \d of 4/.test(out), 'not numbered as one long document');
  assert.equal(pages(await c.batchDocsPdf([docs[2]])), 1);
});

/* ---------- through the server: one mail route call per invoice, and Mark as sent ---------- */
let server, base, dir, co, cookie, smtp;
const got = [];
before(async () => {
  smtp = net.createServer(sock => {
    let mode = 'cmd', data = '', cur = { rcpt: [] }, buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (mode === 'data') { if (line === '.') { mode = 'cmd'; cur.data = data; got.push(cur); cur = { rcpt: [] }; data = ''; sock.write('250 queued\r\n'); } else data += line + '\r\n'; continue; }
        if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) sock.write('235 ok\r\n');
        else if (/^MAIL FROM/i.test(line)) sock.write('250 ok\r\n');
        else if (/^RCPT TO/i.test(line)) { cur.rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { mode = 'data'; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('500 what\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-batch-'));
  server = createApp({ dataDir: dir, autoBackup: false, mailAllowLocal: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Batch Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const doc = (kind, number, contactId, total, date = '2026-09-01') => ({ kind, number, date, due: '2026-09-30', contactId, lines: [{ desc: 'x', account: 'a4000', qty: 1, rate: total, taxCode: 'none' }], sub: total, tax: 0, total });
const post = (id, total) => ({ type: 'invoice', date: '2026-09-01', docId: id, lines: [{ account: 'a1200', debit: total, credit: 0 }, { account: 'a4000', debit: 0, credit: total }] });

test('batch send: the mail route is called once per invoice, in order; no email is skipped; a bad address fails alone', async () => {
  for (const [id, name, email] of [['c1', 'Ana', 'ana@example.com'], ['c2', 'Ben', ''], ['c3', 'Cy', 'not-an-address'], ['c4', 'Dee', 'dee@example.com']]) await call('PUT', `/api/c/records/contacts/${id}`, { name, kind: 'customer', email });
  const w = [];
  for (const [id, num, c, t] of [['i1', '1001', 'c1', 100], ['i2', '1002', 'c2', 200], ['i3', '1003', 'c3', 300], ['i4', '1004', 'c4', 400], ['i5', '1005', 'c1', 500]]) w.push({ op: 'set', collection: 'docs', id, data: doc('invoice', num, c, t) }, { op: 'set', collection: 'entries', id: 'd_' + id, data: post(id, t) });
  assert.equal((await call('POST', '/api/c/batch', { writes: w })).status, 200);
  assert.equal((await call('PUT', '/api/c/mail', { host: '127.0.0.1', port: smtp.address().port, security: 'none', user: 'books@batchco.ca', pass: 'pw-123456', fromName: 'Batch Co' })).status, 200);
  const st = (await call('GET', '/api/c/state')).json;
  const email = id => (st.contacts.find(c => c.id === id) || {}).email || '';
  const p = B.plan('send', st.docs.filter(d => d.kind === 'invoice'), { emailOf: d => email(d.contactId) });
  assert.deepEqual(p.go.map(d => d.number), ['1001', '1003', '1004', '1005']);
  assert.deepEqual(p.skip.map(s => [s.doc.number, s.why]), [['1002', 'noemail']]);
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  const before = got.length, calls = [];
  const results = await B.runSequential(p.go, async d => {
    calls.push(d.number);
    const r = await call('POST', '/api/c/mail/send', { to: email(d.contactId), subject: `Invoice ${d.number} from Batch Co`, text: 'Hello', attachments: [{ name: `Invoice-${d.number}.pdf`, data: pdf }], docIds: [d.id], what: 'invoice' });
    if (r.status !== 200) { const e = new Error(r.json.error); e.status = r.status; throw e; }
  });
  assert.deepEqual(calls, ['1001', '1003', '1004', '1005'], 'one call per invoice');
  assert.deepEqual(results.map(r => r.ok), [true, false, true, true]);
  assert.match(results[1].error, /isn’t an email address/);
  const mails = got.slice(before);
  assert.deepEqual(mails.map(m => m.rcpt[0]), ['RCPT TO:<ana@example.com>', 'RCPT TO:<dee@example.com>', 'RCPT TO:<ana@example.com>']);
  assert.match(mails[0].data, /filename="Invoice-1001\.pdf"/);
  const after = (await call('GET', '/api/c/state')).json.docs;
  const sent = id => (after.find(d => d.id === id).sent || []);
  for (const id of ['i1', 'i4', 'i5']) { assert.equal(sent(id).length, 1); assert.equal(sent(id)[0].what, 'invoice'); }
  assert.equal(sent('i2').length, 0, 'skipped: no email address'); assert.equal(sent('i3').length, 0, 'failed');
  assert.equal((await call('GET', '/api/c/mail')).json.sentToday, 3, 'the daily count is per address sent');
});

test('mark as sent: records "sent" like an email does, invoices only, checked', async () => {
  let r = await call('POST', '/api/c/docs/mark-sent', { docIds: ['i2', 'i3', 'i2'] });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.marked, 2);
  const docs = (await call('GET', '/api/c/state')).json.docs;
  for (const id of ['i2', 'i3']) {
    const s = docs.find(d => d.id === id).sent;
    assert.equal(s.length, 1); assert.equal(s[0].what, 'marked'); assert.equal(s[0].to, ''); assert.equal(s[0].by, 'Owner'); assert.ok(s[0].at > 0);
  }
  assert.equal((await call('POST', '/api/c/docs/mark-sent', { docIds: [] })).status, 400);
  assert.equal((await call('POST', '/api/c/docs/mark-sent', {})).status, 400);
  assert.equal((await call('POST', '/api/c/docs/mark-sent', { docIds: ['nope'] })).status, 404);
  await call('PUT', '/api/c/records/docs/cn1', { ...doc('credit', 'CN-1', 'c1', 10), due: '' });
  r = await call('POST', '/api/c/docs/mark-sent', { docIds: ['i1', 'cn1'] });
  assert.equal(r.status, 400); assert.match(r.json.error, /Only invoices/);
  assert.equal((await call('GET', '/api/c/state')).json.docs.find(d => d.id === 'i1').sent.length, 1, 'nothing marked when one is refused');
  assert.equal((await call('POST', '/api/c/docs/mark-sent', { docIds: Array.from({ length: 1001 }, (_, i) => 'x' + i) })).status, 400);
  // A closed period doesn't stop it: being sent isn't a change to the books.
  assert.equal((await call('PUT', '/api/c/closing', { date: '2026-09-30' })).status, 200);
  assert.equal((await call('POST', '/api/c/docs/mark-sent', { docIds: ['i4'] })).status, 200);
  assert.ok((await call('GET', '/api/c/audit')).json.rows.some(x => /marked 2 invoices as sent: 1002, 1003/.test(x.summary || '')));
});

test('PDF writer: the same logo on several pages is stored once', () => {
  const PDF = require('../public/pdf.js');
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc0000b080002000301011100ffd9', 'hex');
  const d = PDF.create();
  d.image(jpeg, 50, 40, 100, 50); d.addPage(); d.image(jpeg, 50, 40, 100, 50);
  const s = Buffer.from(d.output()).toString('latin1');
  assert.equal((s.match(/\/DCTDecode/g) || []).length, 1);
  assert.equal((s.match(/\/Im1 Do/g) || []).length, 2);
});
