'use strict';
// Licence codes for the desktop app: a trial, codes that turn it on until a date, view only after that.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const L = require('../src/server/licence');

const PW = 'correct horse battery staple';
const dirs = [], servers = [];
after(async () => { for (const s of servers) await s.shutdown(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-lic-')); dirs.push(d); return d; };

async function start(opts) {
  const server = createApp({ autoBackup: false, ...opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* file */ }
    return { status: res.status, json, text };
  };
  const r = await req('POST', '/api/auth/setup', { name: 'Owner', username: 'o@example.com', password: PW, firmName: 'Firm' });
  assert.equal(r.status, 200);
  cookie = (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'o@example.com', password: PW }) })).headers.get('set-cookie').split(';')[0];
  return { server, req };
}

async function start2(opts) {
  const server = createApp({ autoBackup: false, ...opts });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'o@example.com', password: PW }) })).headers.get('set-cookie').split(';')[0];
  const req = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { server, req };
}

// Your own Sumlora (no licensing): make the key and codes there.
let seller, pub, code, codeRec;
test('the seller makes a licence key and codes in their own Sumlora', async () => {
  const at = new Date(2026, 9, 2, 12);
  let tick = 0;
  seller = await start({ dataDir: tmp(), now: () => new Date(at.getTime() + 1000 * tick++) });
  const { req } = seller;
  let r = await req('GET', '/api/auth/me');
  assert.equal(r.json.licence.on, false); assert.equal(r.json.licence.canIssue, true);
  assert.equal((await req('POST', '/api/licences', { name: 'Maple Dental', plan: 'plus', until: '2027-10-01' })).status, 409, 'key first');
  r = await req('POST', '/api/licences/key', {});
  assert.equal(r.status, 200);
  pub = r.json.key.publicKey;
  assert.match(pub, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await req('POST', '/api/licences/key', {})).status, 409, 'only one key: a new one would break every code');
  for (const bad of [{ name: '', plan: 'plus', until: '2027-10-01' }, { name: 'X', plan: 'gold', until: '2027-10-01' }, { name: 'X', plan: 'plus', until: '2026-01-01' }, { name: 'X', plan: 'plus', until: '2026-02-30' }, { name: 'X', plan: 'plus', until: '2035-01-01' }]) {
    assert.equal((await req('POST', '/api/licences', bad)).status, 400, JSON.stringify(bad));
  }
  r = await req('POST', '/api/licences', { name: '  Maple   Dental ', email: 'pay@maple.ca', plan: 'essentials', until: '2027-10-01' });
  assert.equal(r.status, 200);
  codeRec = r.json.licence; code = codeRec.code;
  assert.match(code, /^TB1-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(codeRec.name, 'Maple Dental');
  const read = L.readCode(code, [pub]);
  assert.ok(read.at >= at.getTime() - 1000 && read.at < at.getTime() + 60000, 'when it was made, signed with it');
  delete read.at;
  assert.deepEqual(read, { id: codeRec.id, name: 'Maple Dental', plan: 'essentials', until: '2027-10-01', issued: '2026-10-02' });
  const list = (await req('GET', '/api/licences')).json;
  assert.equal(list.issued.length, 1); assert.equal(list.licensing, false);
  // A copy of the key, to keep safe.
  r = await req('GET', '/api/licences/key/download');
  assert.equal(r.status, 200); assert.equal(r.json.format, 'tally-books-licence-key'); assert.equal(r.json.key.x, pub);
});

test('codes can’t be made up or changed', () => {
  const [body, sig] = code.slice(4).split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url'));
  p.u = '2099-12-31';
  const forged = 'TB1-' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + sig;
  assert.throws(() => L.readCode(forged, [pub]), /isn’t valid/);
  assert.throws(() => L.readCode(code.slice(0, -3), [pub]), /isn’t valid|incomplete/);
  assert.throws(() => L.readCode('hello', [pub]), /isn’t a Sumlora licence code/);
  const { privateKey } = require('node:crypto').generateKeyPairSync('ed25519');
  const other = L.makeCode({ id: 'x', name: 'Copycat', plan: 'plus', until: '2030-01-01', issued: '2026-01-01' }, privateKey);
  assert.throws(() => L.readCode(other, [pub]), /isn’t valid/, 'someone else’s key');
  // Pasted from an email: line breaks, spaces and quotes don't matter.
  assert.equal(L.readCode(`“${code.slice(0, 40)}\n  ${code.slice(40)} ”`, [pub]).name, 'Maple Dental');
});

test('a client’s desktop: trial, then view only, then a code turns it back on with its plan', async () => {
  let at = new Date(2026, 9, 2, 9);
  const appDir = tmp();
  const { req } = await start({ dataDir: tmp(), licenceDir: appDir, licenceKeys: [pub], now: () => at });
  let me = (await req('GET', '/api/auth/me')).json;
  assert.equal(me.licence.state, 'trial'); assert.equal(me.licence.daysLeft, 29); assert.equal(me.licence.until, '2026-10-31');
  assert.equal(me.user.firmPlan, 'plus', 'the trial has everything');
  assert.equal(me.licence.canIssue, false, 'a client’s copy doesn’t make codes');
  assert.equal((await req('GET', '/api/licences')).status, 403);
  assert.equal((await req('POST', '/api/licences/key', {})).status, 403);
  const co = (await req('POST', '/api/companies', { name: 'Maple Dental', province: 'ON' })).json.company.id;
  const emp = { name: 'Pat', prov: 'ON', freq: 'biweekly', payType: 'salary', rate: 52000, td1Fed: '' };
  assert.equal((await req('PUT', `/api/c/${co}/records/employees/e1`, emp)).status, 200);

  // Trial over: everything can be read, nothing changed.
  at = new Date(2026, 10, 1, 9);
  me = (await req('GET', '/api/auth/me')).json;
  assert.equal(me.licence.state, 'trial-ended'); assert.equal(me.licence.canChange, false);
  let r = await req('PUT', `/api/c/${co}/records/contacts/k1`, { name: 'Client', kind: 'customer' });
  assert.equal(r.status, 402); assert.equal(r.json.licence, true); assert.match(r.json.error, /trial has ended/);
  assert.equal((await req('POST', '/api/companies', { name: 'Another' })).status, 402);
  assert.equal((await req('GET', `/api/c/${co}/state`)).status, 200, 'the books still open');
  assert.equal((await req('GET', `/api/c/${co}/backup`)).status, 200, 'and can be exported');

  // The client pays; the seller sends a code.
  assert.equal((await req('PUT', '/api/licence', { code: code.replace('TB1-', 'TB1-x') })).status, 400);
  r = await req('PUT', '/api/licence', { code: '\n' + code + '\n' });
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'active'); assert.equal(r.json.name, 'Maple Dental'); assert.equal(r.json.plan, 'essentials'); assert.equal(r.json.until, '2027-10-01');
  assert.equal((await req('GET', '/api/auth/me')).json.user.firmPlan, 'essentials', 'the code’s plan applies');
  assert.equal((await req('PUT', `/api/c/${co}/records/contacts/k1`, { name: 'Client', kind: 'customer' })).status, 200);
  r = await req('PUT', `/api/c/${co}/records/employees/e2`, { ...emp, name: 'Sam' });
  assert.equal(r.status, 403, 'payroll isn’t in Essentials'); assert.match(r.json.error, /plan/);
  assert.ok((await req('GET', `/api/c/${co}/state`)).json.employees.some(e => e.id === 'e1'), 'records from the trial are kept');

  // Near the end: a reminder; just after: 14 more days to renew.
  at = new Date(2027, 8, 15, 9);
  me = (await req('GET', '/api/auth/me')).json;
  assert.equal(me.licence.state, 'active'); assert.equal(me.licence.renewSoon, true); assert.equal(me.licence.daysLeft, 16);
  at = new Date(2027, 9, 10, 9);
  me = (await req('GET', '/api/auth/me')).json;
  assert.equal(me.licence.state, 'grace'); assert.equal(me.licence.readOnlyFrom, '2027-10-16');
  assert.equal((await req('PUT', `/api/c/${co}/records/contacts/k2`, { name: 'Two', kind: 'customer' })).status, 200);
  at = new Date(2027, 9, 16, 9);
  r = await req('PUT', `/api/c/${co}/records/contacts/k3`, { name: 'Three', kind: 'customer' });
  assert.equal(r.status, 402); assert.match(r.json.error, /ended on 2027-10-01/);

  // Turning the computer's clock back doesn't bring the licence back.
  at = new Date(2027, 5, 1, 9);
  assert.equal((await req('GET', '/api/auth/me')).json.licence.state, 'ended');
  at = new Date(2027, 9, 16, 9);

  // Renewal: a new code for another year turns it back on, and can move the client to Plus.
  const renewal = (await seller.req('POST', '/api/licences', { name: 'Maple Dental', plan: 'plus', until: '2028-10-01', renews: codeRec.id })).json.licence;
  assert.equal(renewal.renews, codeRec.id);
  r = await req('PUT', '/api/licence', { code: renewal.code });
  assert.equal(r.json.state, 'active'); assert.equal(r.json.plan, 'plus');
  assert.equal((await req('PUT', `/api/c/${co}/records/employees/e2`, { ...emp, name: 'Sam' })).status, 200);
  // The old email's code can't replace the renewal.
  assert.equal((await req('PUT', '/api/licence', { code })).status, 409);
  // The licence belongs to the computer (the app's folder), not the books.
  assert.ok(fs.existsSync(path.join(appDir, 'licence.json')));
});

test('only an administrator enters a code; a code long past its end is refused', async () => {
  const at = new Date(2029, 0, 10, 9);
  const { req } = await start({ dataDir: tmp(), licenceDir: tmp(), licenceKeys: [pub], now: () => at });
  const r = await req('PUT', '/api/licence', { code });
  assert.equal(r.status, 400); assert.match(r.json.error, /ended on 2027-10-01/);
});

test('the seller’s own desktop copy: its key makes it licensed, and a key can be brought back from a copy', async () => {
  const keyCopy = (await seller.req('GET', '/api/licences/key/download')).json;
  const appDir = tmp();
  const at = new Date(2026, 9, 2, 9);
  const { req } = await start({ dataDir: tmp(), licenceDir: appDir, licenceKeys: [pub], now: () => at });
  assert.equal((await req('GET', '/api/auth/me')).json.licence.state, 'trial');
  // A key that isn't the one in this build can't be brought in.
  const crypto = require('node:crypto');
  const jwk = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  assert.equal((await req('POST', '/api/licences/key/restore', { format: 'tally-books-licence-key', key: { x: jwk.x, d: jwk.d } })).status, 409);
  assert.equal((await req('POST', '/api/licences/key/restore', { format: 'tally-books-licence-key', key: { x: pub, d: jwk.d } })).status, 400, 'a damaged key file');
  const r = await req('POST', '/api/licences/key/restore', keyCopy);
  assert.equal(r.status, 200); assert.equal(r.json.inBuild, true); assert.equal(r.json.issued.length, 2, 'the list of codes comes with it');
  const me = (await req('GET', '/api/auth/me')).json;
  assert.equal(me.licence.state, 'issuer'); assert.equal(me.licence.canIssue, true); assert.equal(me.user.firmPlan, 'plus');
  assert.equal((await req('POST', '/api/licences', { name: 'Birch Cafe', plan: 'plus', until: '2027-10-01' })).status, 200);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(appDir, 'licence-issuer.json')).mode & 0o077, 0, 'the key file is private');
});

test('review fixes: a public key alone doesn’t make a copy the seller’s; deleting licence.json doesn’t restart the trial; newer codes fix mistakes and a clock that jumped ahead', async () => {
  let at = new Date(2026, 9, 2, 9);
  const appDir = tmp(), dataDir = tmp();
  let app = await start({ dataDir, licenceDir: appDir, licenceKeys: [pub], now: () => at });
  // Only the public key (it's in the installed app): not the seller's copy.
  fs.writeFileSync(path.join(appDir, 'licence-issuer.json'), JSON.stringify({ key: { x: pub } }));
  assert.equal((await app.req('GET', '/api/auth/me')).json.licence.state, 'trial');
  fs.writeFileSync(path.join(appDir, 'licence-issuer.json'), JSON.stringify({ key: { x: pub, d: 'A'.repeat(43) } }));
  assert.equal((await app.req('GET', '/api/auth/me')).json.licence.state, 'trial', 'nor with a made-up private key');
  fs.rmSync(path.join(appDir, 'licence-issuer.json'));

  // Trial over; deleting the licence file and restarting doesn't give a new trial.
  at = new Date(2026, 10, 5, 9);
  assert.equal((await app.req('GET', '/api/auth/me')).json.licence.state, 'trial-ended');
  await app.server.shutdown();
  fs.rmSync(path.join(appDir, 'licence.json'));
  app = await start2({ dataDir, licenceDir: appDir, licenceKeys: [pub], now: () => at });
  assert.equal((await app.req('GET', '/api/auth/me')).json.licence.state, 'trial-ended');

  // The clock once jumped to 2031 (a bad battery): the licence shows as ended…
  at = new Date(2031, 0, 1, 9);
  await app.req('GET', '/api/auth/me');
  at = new Date(2026, 10, 5, 9);
  // …but a code made after that (the seller's date is signed) puts things right.
  const fresh = (await seller.req('POST', '/api/licences', { name: 'Clock Co', plan: 'plus', until: '2027-11-04' })).json.licence;
  let r = await app.req('PUT', '/api/licence', { code: fresh.code });
  assert.equal(r.status, 200); assert.equal(r.json.state, 'active');
  // The seller typed the wrong year and sends a corrected code: the newer code wins even though it ends sooner.
  const wrong = (await seller.req('POST', '/api/licences', { name: 'Clock Co', plan: 'plus', until: '2028-11-04' })).json.licence;
  assert.equal((await app.req('PUT', '/api/licence', { code: wrong.code })).json.until, '2028-11-04');
  const fixed = (await seller.req('POST', '/api/licences', { name: 'Clock Co', plan: 'plus', until: '2027-11-04', renews: wrong.id })).json.licence;
  assert.equal((await app.req('PUT', '/api/licence', { code: fixed.code })).json.until, '2027-11-04');
  assert.equal((await app.req('PUT', '/api/licence', { code: wrong.code })).status, 409, 'the mistaken one can’t come back');
});

test('a key copy with odd entries brings in only well-formed ones', async () => {
  const copy = (await seller.req('GET', '/api/licences/key/download')).json;
  const { req } = await start({ dataDir: tmp() });
  const r = await req('POST', '/api/licences/key/restore', { ...copy, issued: [...copy.issued, { id: '"><img src=x onerror=alert(1)>', plan: 'plus', until: '2027-01-01', issued: '2026-01-01', code: 'TB1-x' }, 'junk'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.issued.length, copy.issued.length);
});

test('the client creates their account with the licence code: checked first, then Sumlora is activated', async () => {
  const at = new Date(2026, 9, 4, 9);
  const fresh = async trialDays => {
    const server = createApp({ dataDir: tmp(), licenceDir: tmp(), licenceKeys: [pub], licenceTrialDays: trialDays, autoBackup: false, now: () => at });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, cookie) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
    };
    return call;
  };
  const owner = { firmName: 'Maple Dental', name: 'Mia', username: 'mia@maple.ca', password: PW };
  const good = (await seller.req('POST', '/api/licences', { name: 'Maple Dental', plan: 'essentials', until: '2027-10-03' })).json.licence.code;

  // With a free trial: the setup screen offers the field, a code is optional.
  let call = await fresh(30);
  let me = await call('GET', '/api/auth/me');
  assert.deepEqual(me.json.licenceSetup, { required: false, trialDays: 30 });
  let r = await call('POST', '/api/auth/setup', { ...owner, licenceCode: good.slice(0, -4) + 'AAAA' });
  assert.equal(r.status, 400, 'a wrong code is refused…');
  assert.equal((await call('GET', '/api/auth/me')).json.setup, true, '…and no account was made');
  r = await call('POST', '/api/auth/setup', { ...owner, licenceCode: good });
  assert.equal(r.status, 200);
  me = await call('GET', '/api/auth/me', null, r.cookie);
  assert.equal(me.json.licence.state, 'active'); assert.equal(me.json.licence.name, 'Maple Dental'); assert.equal(me.json.user.firmPlan, 'essentials');

  // No trial (SUMLORA_TRIAL_DAYS = 0): a code is needed to create the account.
  call = await fresh(0);
  assert.deepEqual((await call('GET', '/api/auth/me')).json.licenceSetup, { required: true, trialDays: 0 });
  r = await call('POST', '/api/auth/setup', owner);
  assert.equal(r.status, 400); assert.match(r.json.error, /licence code/);
  r = await call('POST', '/api/auth/setup', { ...owner, licenceCode: good });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/auth/me', null, r.cookie)).json.licence.state, 'active');

  // Servers without licensing (your own server, the web version) don't ask.
  call = await (async () => { const s = createApp({ dataDir: tmp(), autoBackup: false }); await new Promise(res => s.listen(0, '127.0.0.1', res)); servers.push(s); const b = `http://127.0.0.1:${s.address().port}`; return async (m, u) => ({ json: await (await fetch(b + u, { method: m })).json() }); })();
  assert.equal((await call('GET', '/api/auth/me')).json.licenceSetup, undefined);
});

test('with no trial, a copy without a code is view only until one is entered', () => {
  const dir = tmp();
  const lic = new L.Licence(dir, { publicKeys: [pub], trialDays: 0, now: () => new Date(2026, 9, 4) });
  const st = lic.status();
  assert.equal(st.state, 'none'); assert.equal(st.canChange, false);
});
