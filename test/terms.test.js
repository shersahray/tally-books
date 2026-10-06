'use strict';
// Terms of service and Privacy policy: people agree before using Sumlora, and agree again when the version changes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const { TERMS_VERSION } = require('../src/server/legal');

let server, base, dir;
const PW = 'correct horse battery staple';
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-terms-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, requireTerms: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('terms: the owner agrees when creating the account, and it’s recorded', async () => {
  const no = await call('POST', '/api/auth/setup', { name: 'Owner', username: 'owner@example.com', password: PW });
  assert.equal(no.status, 400); assert.match(no.json.error, /Tick the box/);
  const r = await call('POST', '/api/auth/setup', { name: 'Owner', username: 'owner@example.com', password: PW, acceptTerms: true });
  assert.equal(r.status, 200);
  const me = (await call('GET', '/api/auth/me', undefined, r.cookie)).json;
  assert.deepEqual([me.terms.version, me.terms.accepted], [TERMS_VERSION, true]);
  assert.equal(me.user.terms.v, TERMS_VERSION); assert.ok(me.user.terms.at > 0);
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  assert.equal(users.users[0].terms.v, TERMS_VERSION, 'kept with the account');
  assert.ok(fs.readFileSync(path.join(dir, 'signins.log'), 'utf8').includes('terms-accepted'));
});

test('terms: invited people agree; a password reset doesn’t ask; a new version asks everyone again', async () => {
  const owner = (await call('POST', '/api/auth/login', { username: 'owner@example.com', password: PW })).cookie;
  const co = (await call('POST', '/api/companies', { name: 'Terms Co', province: 'ON' }, owner)).json.company.id;
  const link = (await call('POST', '/api/users', { name: 'Staff', username: 'staff@example.com', role: 'staff', companies: [co], invite: true }, owner)).json.user.link;
  assert.equal((await call('POST', '/api/auth/link/accept', { token: link, password: 'staff long phrase here' })).status, 400, 'must tick the box');
  const st = await call('POST', '/api/auth/link/accept', { token: link, password: 'staff long phrase here', acceptTerms: true });
  assert.equal(st.status, 200);
  assert.equal((await call('GET', `/api/c/${co}/state`, undefined, st.cookie)).status, 200);

  // The owner's agreement is cleared, as when a new version comes out: books stay closed until they agree again.
  const f = path.join(dir, 'users.json'), d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.users.find(u => u.username === 'owner@example.com').terms.v = 'older';
  fs.writeFileSync(f, JSON.stringify(d));
  server.auth.data = JSON.parse(fs.readFileSync(f, 'utf8'));
  const blocked = await call('GET', `/api/c/${co}/state`, undefined, owner);
  assert.equal(blocked.status, 403); assert.equal(blocked.json.mustAgree, true);
  const me = (await call('GET', '/api/auth/me', undefined, owner)).json;
  assert.deepEqual([me.terms.accepted, me.terms.before], [false, true]);
  assert.equal((await call('POST', '/api/auth/terms', { version: 'older', accept: true }, owner)).status, 409, 'an out-of-date page can’t agree');
  assert.equal((await call('POST', '/api/auth/terms', { version: TERMS_VERSION }, owner)).status, 400, 'must tick');
  assert.equal((await call('POST', '/api/auth/terms', { version: TERMS_VERSION, accept: true }, owner)).status, 200);
  assert.equal((await call('GET', `/api/c/${co}/state`, undefined, owner)).status, 200);

  // A password reset link doesn't ask again.
  const users = (await call('GET', '/api/users', undefined, owner)).json.users;
  const staffId = users.find(u => u.username === 'staff@example.com').id;
  const reset = (await call('POST', `/api/users/${staffId}/link`, {}, owner)).json;
  assert.equal(reset.kind, 'reset');
  assert.equal((await call('POST', '/api/auth/link/accept', { token: reset.token, password: 'another long phrase' })).status, 200);
});

test('terms: the pages are public, in English and French', async () => {
  for (const p of ['terms', 'terms-fr', 'privacy', 'privacy-fr', 'data-agreement', 'data-agreement-fr']) {
    const res = await fetch(`${base}/legal/${p}.html`);
    assert.equal(res.status, 200, p);
    const t = await res.text();
    assert.ok(t.includes('legal.css') && t.includes('Sumlora'));
  }
  assert.match(await (await fetch(`${base}/legal/terms-fr.html`)).text(), /Conditions d’utilisation/);
});
