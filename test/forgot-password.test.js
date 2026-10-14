'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
// "Forgot your password?" on the sign-in screen, unlocking a locked-out account, and the administrator's
// sign-in help for another firm's owners.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createApp } = require('../src/server/app');

let server, base, dir, smtp, admin, co;
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-forgot-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, mailAllowLocal: true, requireTerms: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple', firmName: 'Sher Books' })).cookie;
  co = (await call('POST', '/api/companies', { name: 'Shop Co', province: 'ON' }, admin)).json.company.id;
});
after(async () => { await server.shutdown(); smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
/** A person with a password: invited, then accepted. */
async function person(name, email, role = 'client') {
  const u = (await call('POST', '/api/users', { name, username: email, role, companies: role === 'client' ? [co] : [], invite: true }, admin)).json.user;
  const r = await call('POST', '/api/auth/link/accept', { token: u.link, password: 'first chosen phrase here' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return u;
}
const bodyOf = m => Buffer.from(m.data.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('--tb-')[0].replace(/\s+/g, ''), 'base64').toString();
async function nextMail(n) { for (let i = 0; i < 40 && got.length <= n; i++) await new Promise(r => setTimeout(r, 50)); return got[n]; }
const settle = () => new Promise(r => setTimeout(r, 400)); // long enough for an email that would be sent to arrive

test('Forgot your password?: off until the server has a mailbox', async () => {
  assert.equal((await call('GET', '/api/auth/me')).json.forgot, undefined);
  const r = await call('POST', '/api/auth/forgot', { username: 'sher@example.com' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Ask your bookkeeper/);
});

test('Forgot your password?: emails a one-hour reset link to a real account, and nothing else gives it away', async () => {
  const cfg = { host: '127.0.0.1', port: smtp.address().port, security: 'none', user: 'info@sumlora.example', pass: 'app-password-456', fromName: 'Sumlora' };
  const s = (await call('PUT', '/api/sysmail', cfg, admin)).json;
  assert.equal(s.forgot, true);
  assert.equal(s.appUrl, base, 'links point to the address the administrator used');
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.status, 401);
  assert.equal(me.json.forgot, true, 'the sign-in screen shows the button');

  await person('Bo Lee', 'bo@shop.example');
  const n = got.length;
  const r = await call('POST', '/api/auth/forgot', { username: ' Bo@Shop.example ' });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  const m = await nextMail(n);
  assert.ok(m, 'the email was sent');
  assert.ok(m.rcpt[0].includes('bo@shop.example'));
  const text = bodyOf(m);
  const link = text.match(/(http\S+#link=)(\S+)/);
  assert.equal(link[1], `${base}/#link=`);
  const token = decodeURIComponent(link[2]);
  assert.deepEqual((await call('POST', '/api/auth/link', { token })).json, { name: 'Bo Lee', username: 'bo@shop.example', kind: 'reset' });
  const users = (await call('GET', '/api/users', undefined, admin)).json.users;
  const bo = users.find(u => u.username === 'bo@shop.example');
  assert.equal(bo.linkPending, 'reset');
  const log = (await call('GET', '/api/security/log', undefined, admin)).json.log;
  assert.ok(log.some(e => e.event === 'reset-requested' && e.username === 'bo@shop.example'), 'it’s in the sign-in activity');

  // Asking again within 5 minutes doesn't replace the link they just got.
  assert.equal((await call('POST', '/api/auth/forgot', { username: 'bo@shop.example' })).status, 200);
  await settle();
  assert.equal(got.length, n + 1);

  // The link works once, and signs them in with the new password.
  const acc = await call('POST', '/api/auth/link/accept', { token, password: 'a fresh new phrase' });
  assert.equal(acc.status, 200, JSON.stringify(acc.json));
  assert.equal((await call('POST', '/api/auth/link', { token })).status, 410);
  assert.equal((await call('POST', '/api/auth/login', { username: 'bo@shop.example', password: 'a fresh new phrase' })).status, 200);
});

test('Forgot your password?: same answer and no email for unknown, invited or turned-off accounts', async () => {
  const inv = (await call('POST', '/api/users', { name: 'Cy', username: 'cy@shop.example', role: 'client', companies: [co], invite: true }, admin)).json.user;
  const off = await person('Di', 'di@shop.example');
  await call('PUT', `/api/users/${off.id}`, { disabled: true }, admin);
  const n = got.length;
  for (const username of ['nobody@shop.example', 'cy@shop.example', 'di@shop.example']) {
    const r = await call('POST', '/api/auth/forgot', { username });
    assert.deepEqual([r.status, r.json], [200, { ok: true }], username);
  }
  await settle();
  assert.equal(got.length, n, 'nothing was sent');
  // The invitation still works: it wasn't replaced.
  assert.equal((await call('POST', '/api/auth/link', { token: inv.link })).json.kind, 'invite');
});

test('unlock: an owner lets a locked-out person try again now', async () => {
  const u = await person('Eve', 'eve@shop.example', 'staff');
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { username: 'eve@shop.example', password: 'not the right one' });
  assert.equal((await call('POST', '/api/auth/login', { username: 'eve@shop.example', password: 'first chosen phrase here' })).status, 429);
  let eve = (await call('GET', '/api/users', undefined, admin)).json.users.find(x => x.id === u.id);
  assert.equal(eve.locked, true, 'shown as locked on Users & security');
  const r = await call('POST', `/api/users/${u.id}/unlock`, {}, admin);
  assert.equal(r.status, 200);
  assert.equal(r.json.user.locked, false);
  assert.equal((await call('POST', '/api/auth/login', { username: 'eve@shop.example', password: 'first chosen phrase here' })).status, 200);
  const log = (await call('GET', '/api/security/log', undefined, admin)).json.log;
  assert.ok(log.some(e => e.event === 'unlocked' && e.username === 'eve@shop.example' && e.by === 'sher@example.com'));
});

test('sign-in help: the administrator can help another firm’s owners, and only owners', async () => {
  const inv = (await call('POST', '/api/firms/invite', { firmName: 'Maple Firm', name: 'Ana', email: 'ana@maple.example', plan: 'seed' }, admin)).json;
  const ana = (await call('POST', '/api/auth/link/accept', { token: inv.user.link, password: 'violet harbour tram ninety', acceptTerms: true }));
  assert.equal(ana.status, 200, JSON.stringify(ana.json));
  const fid = inv.firm.id, aid = inv.user.id;
  // Ana's own staff member.
  const staff = (await call('POST', '/api/users', { name: 'Gus', username: 'gus@maple.example', role: 'staff', companies: [], invite: true }, ana.cookie)).json.user;

  // Not for anyone but the administrator.
  assert.equal((await call('GET', `/api/firms/${fid}/owners`, undefined, ana.cookie)).status, 403);
  assert.equal((await call('POST', `/api/firms/${fid}/owners/${aid}/link`, {}, ana.cookie)).status, 403);

  const owners = (await call('GET', `/api/firms/${fid}/owners`, undefined, admin)).json;
  assert.equal(owners.firm.name, 'Maple Firm');
  assert.deepEqual(owners.owners.map(o => o.username), ['ana@maple.example']);
  // Only the firm's owners: not its staff, and not someone from another firm through this firm's address.
  assert.equal((await call('POST', `/api/firms/${fid}/owners/${staff.id}/link`, {}, admin)).status, 404);
  const sherId = (await call('GET', '/api/users', undefined, admin)).json.users.find(u => u.username === 'sher@example.com').id;
  assert.equal((await call('POST', `/api/firms/${fid}/owners/${sherId}/link`, {}, admin)).status, 404);

  // Locked out: unlock.
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { username: 'ana@maple.example', password: 'not the right one' });
  assert.equal((await call('GET', `/api/firms/${fid}/owners`, undefined, admin)).json.owners[0].locked, true);
  assert.equal((await call('POST', `/api/firms/${fid}/owners/${aid}/unlock`, {}, admin)).json.user.locked, false);

  // Forgot their password: a reset link that the administrator can also email from the server's mailbox.
  const l = (await call('POST', `/api/firms/${fid}/owners/${aid}/link`, {}, admin)).json;
  assert.equal(l.kind, 'reset');
  assert.equal(l.user.username, 'ana@maple.example');
  const n = got.length;
  const em = await call('POST', `/api/users/${aid}/email-link`, { token: l.token, subject: 'Reset your Sumlora password', text: `Hi Ana,\n\n${base}/#link=${l.token}\n` }, admin);
  assert.equal(em.status, 200, JSON.stringify(em.json));
  assert.ok((await nextMail(n)).rcpt[0].includes('ana@maple.example'));
  assert.equal((await call('POST', '/api/auth/link/accept', { token: l.token, password: 'a brand new maple phrase' })).status, 200);

  // Lost phone: reset two-step sign-in (only when it's on).
  assert.equal((await call('POST', `/api/firms/${fid}/owners/${aid}/reset2fa`, {}, admin)).status, 409);
});

test('Forgot your password?: at most 5 requests an hour from one network', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/auth/forgot', { username: 'nobody@shop.example' });
  assert.equal(last.status, 429);
});
