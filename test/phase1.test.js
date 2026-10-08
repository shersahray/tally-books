'use strict';
// Products and services, sales receipts, saved sales reports, and invitation emails from the server's mailbox.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createApp } = require('../src/server/app');

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-phase1-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, mailAllowLocal: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Shop Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('products and services: checked, unique names, kept while in use', async () => {
  assert.equal((await call('PUT', '/api/c/records/items/i1', { name: '' })).status, 400);
  assert.equal((await call('PUT', '/api/c/records/items/i1', { name: 'Bookkeeping', sold: true, incomeAccount: 'a6000' })).status, 400, 'an expense account isn’t an income account');
  assert.equal((await call('PUT', '/api/c/records/items/i1', { name: 'Bookkeeping', sold: true, incomeAccount: 'a4000', price: '250', taxCode: 'std' })).status, 200);
  assert.equal((await call('PUT', '/api/c/records/items/i2', { name: 'bookkeeping ', sold: true, incomeAccount: 'a4000' })).status, 409, 'same name');
  const st = (await call('GET', '/api/c/state')).json;
  assert.deepEqual([st.items[0].price, st.items[0].incomeAccount, st.items[0].sold, st.items[0].bought], [250, 'a4000', true, false]);
  // Used on an invoice line: can't be deleted.
  await call('PUT', '/api/c/records/contacts/c1', { name: 'Ana', kind: 'customer' });
  assert.equal((await call('PUT', '/api/c/records/docs/d1', { kind: 'invoice', number: '1001', date: '2026-09-01', due: '2026-10-01', contactId: 'c1', lines: [{ item: 'i1', desc: 'Bookkeeping', account: 'a4000', qty: 1, rate: 250, taxCode: 'none' }], sub: 250, tax: 0, total: 250 })).status, 200);
  assert.equal((await call('DELETE', '/api/c/records/items/i1')).status, 409);
});

test('sales receipts: paid on the spot into a bank account', async () => {
  const sr = { kind: 'sreceipt', number: 'SR-1001', date: '2026-09-02', contactId: 'c1', lines: [{ item: 'i1', desc: 'Bookkeeping', account: 'a4000', qty: 1, rate: 100, taxCode: 'none' }], sub: 100, tax: 0, total: 100 };
  assert.equal((await call('PUT', '/api/c/records/docs/s1', sr)).status, 400, 'needs the account the money went into');
  assert.equal((await call('PUT', '/api/c/records/docs/s1', { ...sr, depositTo: 'a4000' })).status, 400, 'not a bank account');
  const r = await call('POST', '/api/c/batch', { writes: [
    { op: 'set', collection: 'docs', id: 's1', data: { ...sr, depositTo: 'a1000' } },
    { op: 'set', collection: 'entries', id: 'd_s1', data: { type: 'salesreceipt', date: '2026-09-02', docId: 's1', ref: 'SR-1001', contactId: 'c1', lines: [{ account: 'a1000', debit: 100, credit: 0 }, { account: 'a4000', debit: 0, credit: 100, taxCode: 'none' }] } }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const st = (await call('GET', '/api/c/state')).json;
  assert.equal(st.docs.find(d => d.id === 's1').depositTo, 'a1000');
  assert.equal(st.entries.find(e => e.id === 'd_s1').type, 'salesreceipt');
});

test('the new sales and expense reports can be saved', async () => {
  const cur = (await call('GET', '/api/c/state')).json.company;
  const r = await call('PUT', '/api/c/settings', { ...cur, savedReports: [{ id: 'r1', name: 'Top customers', tab: 'sc', period: 'ytd' }, { id: 'r2', name: 'By product', tab: 'si', period: 'fy' }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const saved = (await call('GET', '/api/c/state')).json.company.savedReports;
  assert.deepEqual(saved.map(x => x.tab), ['sc', 'si']);
});

test('invitation email: set up by the administrator, sent only with the current link, to that person', async () => {
  assert.deepEqual((await call('GET', '/api/sysmail')).json.configured, false);
  const u = (await call('POST', '/api/users', { name: 'Bo Lee', username: 'bo@shop.example', role: 'client', companies: [co], invite: true })).json.user;
  assert.equal((await call('POST', `/api/users/${u.id}/email-link`, { token: u.link, subject: 'x', text: u.link })).status, 409, 'no mailbox yet');
  const cfg = { host: '127.0.0.1', port: smtp.address().port, security: 'none', user: 'noreply@sumlora.example', pass: 'app-password-456', fromName: 'Sumlora' };
  const s = (await call('PUT', '/api/sysmail', cfg)).json;
  assert.equal(s.fromEmail, 'noreply@sumlora.example');
  assert.ok(!JSON.stringify(s).includes('app-password-456'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'sysmail.json')).mode & 0o077, 0);
  assert.equal((await call('POST', '/api/sysmail/test', {})).status, 200);
  assert.equal((await call('POST', `/api/users/${u.id}/email-link`, { token: 'wrong', subject: 'x', text: 'wrong' })).status, 410);
  assert.equal((await call('POST', `/api/users/${u.id}/email-link`, { token: u.link, subject: 'x', text: 'no link here' })).status, 400);
  const before = got.length;
  const r = await call('POST', `/api/users/${u.id}/email-link`, { token: u.link, subject: 'Your Sumlora account', text: `Hi Bo,\n\nOpen https://example/#link=${u.link}\n` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(got.length, before + 1);
  const m = got.at(-1);
  assert.ok(m.rcpt[0].includes('bo@shop.example'));
  assert.ok(/Reply-To: sher@example.com/i.test(m.data), 'replies go to the person who invited');
  const part = m.data.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('--tb-')[0];
  assert.ok(Buffer.from(part.replace(/\s+/g, ''), 'base64').toString().includes(u.link), 'the link is in the message');
});
