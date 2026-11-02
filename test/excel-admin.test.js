'use strict';
require('./setup-payroll-on');
// Sumlora for Excel administration from the Bookkeeping overview. A fake Excel service
// verifies every signed request independently. Fictional firms only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createApp } = require('../src/server/app');
const { signAdminRequest, loadExcelAdminConfig, createExcelAdminClient, actorFor } = require('../src/server/excel-admin');

const PW = 'correct horse battery staple';
const SECRET = crypto.randomBytes(32);
const TENANT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FIRM = '0b9a0d2e-1f7c-4a51-9d0e-2b6c8f1a3e47';
const INV = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

// ---- fake Excel service: checks the signature exactly as the Excel API does
const seen = [];
let respond = () => [500, { error: 'unset' }];
const seenNonces = new Set();
function verify(req, body) {
  const h = req.headers;
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const canon = [req.method, req.url, h['x-sumlora-timestamp'], h['x-sumlora-nonce'], h['x-sumlora-actor'], bodyHash].join('\n');
  const want = crypto.createHmac('sha256', SECRET).update(canon).digest('hex');
  if (h['x-sumlora-key-id'] !== 'k1' || h['x-sumlora-signature'] !== want) return 'bad-signature';
  if (Math.abs(Date.now() / 1000 - Number(h['x-sumlora-timestamp'])) > 300) return 'stale-request';
  if (seenNonces.has(h['x-sumlora-nonce'])) return 'replayed-request';
  seenNonces.add(h['x-sumlora-nonce']);
  return null;
}
const excel = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const bad = verify(req, body);
    const [status, out] = bad ? [401, { error: bad }] : respond(req.method, req.url, body ? JSON.parse(body) : undefined);
    seen.push({ method: req.method, url: req.url, actor: req.headers['x-sumlora-actor'], body: body ? JSON.parse(body) : undefined, origin: req.headers.origin });
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
});

let app, base, admin, owner, dir, offApp, offBase, offAdmin;
async function req(base, cookie, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function boot(excelAdmin) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-excel-'));
  const s = createApp({ dataDir: d, autoBackup: false, excelAdmin });
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  const r = await req(b, null, 'POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Bookkeeping' });
  assert.equal(r.json.user.platformAdmin, true);
  return { s, b, cookie: r.cookie, d };
}

before(async () => {
  await new Promise(r => excel.listen(0, '127.0.0.1', r));
  const client = createExcelAdminClient({ baseUrl: `http://127.0.0.1:${excel.address().port}`, keyId: 'k1', secret: SECRET });
  ({ s: app, b: base, cookie: admin, d: dir } = await boot(client));
  ({ s: offApp, b: offBase, cookie: offAdmin } = await boot(null));
  // A second firm on the Bookkeeping server whose owner is NOT the platform administrator.
  await req(base, admin, 'PUT', '/api/firms/settings', { signups: 'approval' });
  await req(base, null, 'POST', '/api/auth/signup', { firmName: 'North Ledger', name: 'Nora', username: 'nora@north.ca', password: PW });
  const nl = (await req(base, admin, 'GET', '/api/firms')).json.firms.find(f => f.name === 'North Ledger');
  await req(base, admin, 'PUT', `/api/firms/${nl.id}`, { status: 'active' });
  owner = (await req(base, null, 'POST', '/api/auth/login', { username: 'nora@north.ca', password: PW })).cookie;
});
after(async () => { await app.shutdown(); await offApp.shutdown(); excel.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('signature matches the Excel API (shared test vector in both repositories)', () => {
  const h = signAdminRequest({ keyId: 'k1', secret: Buffer.alloc(32, 7), method: 'POST', path: '/v1/admin/firms', actor: 'sher@example.com',
    body: '{"name":"Fictional Maple CPA"}', now: 1793000000000, nonce: 'fixed-nonce-0123456789' });
  assert.equal(h['x-sumlora-signature'], '09e7823dfa608f825b418f62de0e560cbc429708f2e15e20dcc4a7fe7538429d');
  assert.equal(h['x-sumlora-timestamp'], '1793000000');
  assert.equal(actorFor({ username: 'sher@example.com' }), 'sher@example.com');
  assert.equal(actorFor({ username: 'name with spaces' }), 'name_with_spaces');
});

test('configuration: off unless all three settings are present and safe', () => {
  const secret = crypto.randomBytes(32).toString('base64');
  assert.equal(loadExcelAdminConfig({}), null);
  assert.equal(loadExcelAdminConfig({ EXCEL_ADMIN_API_URL: 'https://excel-api.example', EXCEL_ADMIN_KEY_ID: 'k1', EXCEL_ADMIN_HMAC_SECRET: secret }).baseUrl, 'https://excel-api.example');
  assert.throws(() => loadExcelAdminConfig({ EXCEL_ADMIN_API_URL: 'http://excel-api.example', EXCEL_ADMIN_KEY_ID: 'k1', EXCEL_ADMIN_HMAC_SECRET: secret }), /https/);
  assert.throws(() => loadExcelAdminConfig({ EXCEL_ADMIN_API_URL: 'https://excel-api.example/v1', EXCEL_ADMIN_KEY_ID: 'k1', EXCEL_ADMIN_HMAC_SECRET: secret }), /just the server address/);
  assert.throws(() => loadExcelAdminConfig({ EXCEL_ADMIN_API_URL: 'https://excel-api.example', EXCEL_ADMIN_KEY_ID: 'k1', EXCEL_ADMIN_HMAC_SECRET: 'c2hvcnQ=' }), /32 bytes/);
  assert.throws(() => loadExcelAdminConfig({ EXCEL_ADMIN_API_URL: 'https://excel-api.example', EXCEL_ADMIN_HMAC_SECRET: secret }), /KEY_ID/);
  assert.equal(loadExcelAdminConfig({ EXCEL_ADMIN_API_URL: 'http://127.0.0.1:9', EXCEL_ADMIN_KEY_ID: 'k1', EXCEL_ADMIN_HMAC_SECRET: secret, EXCEL_ADMIN_ALLOW_LOCAL_HTTP: '1' }).baseUrl, 'http://127.0.0.1:9');
});

test('not configured: overview says so and every action is refused with 503', async () => {
  const r = await req(offBase, offAdmin, 'GET', '/api/overview/excel');
  assert.deepEqual([r.status, r.json.connected, r.json.status], [200, false, 'not-configured']);
  const c = await req(offBase, offAdmin, 'POST', '/api/overview/excel/firms', { name: 'X' });
  assert.equal(c.status, 503); assert.match(c.json.error, /not connected/);
});

test('only the platform administrator can reach any Excel route; nothing is forwarded otherwise', async () => {
  const before = seen.length;
  for (const [m, u] of [['GET', '/api/overview/excel'], ['GET', '/api/overview/excel/firms'], ['POST', '/api/overview/excel/firms'],
    ['POST', `/api/overview/excel/firms/${FIRM}/suspend`], ['PUT', `/api/overview/excel/firms/${FIRM}/ai-budget`], ['GET', `/api/overview/excel/firms/${FIRM}/audit`]]) {
    assert.equal((await req(base, owner, m, u, m === 'GET' ? undefined : {})).status, 403, `${m} ${u}`);
    assert.equal((await req(base, null, m, u, m === 'GET' ? undefined : {})).status, 401, `${m} ${u} signed out`);
  }
  assert.equal(seen.length, before, 'no request reached the Excel service');
});

test('summary is read from the Excel service with the admin as signed actor', async () => {
  respond = () => [200, { firms: 3, members: 41, aiBudgetCents: 90000, aiSpentCents: 1234 }];
  const r = await req(base, admin, 'GET', '/api/overview/excel');
  assert.deepEqual(r.json, { connected: true, status: 'connected', firms: 3, members: 41, aiBudgetCents: 90000, aiSpentCents: 1234 });
  assert.deepEqual([seen.at(-1).url, seen.at(-1).actor, seen.at(-1).origin], ['/v1/admin/summary', 'sher@example.com', undefined]);
  respond = () => [200, { firms: -1 }];
  assert.equal((await req(base, admin, 'GET', '/api/overview/excel')).status, 503, 'malformed summaries are rejected');
});

test('create firm with first-administrator invitation; only allowed fields are forwarded', async () => {
  respond = (m, u, b) => u === '/v1/admin/firms' ? [201, { firm: { id: FIRM, name: b.name, status: 'active' } }]
    : [201, { invitation: { id: INV, email: b.email, role: b.role, expiresAt: '2026-11-09T00:00:00Z' }, inviteCode: 'C'.repeat(43), acceptUrl: 'https://x/install.html#invite=' + 'C'.repeat(43) }];
  const r = await req(base, admin, 'POST', '/api/overview/excel/firms', { name: 'Fictional Maple CPA', entraTenantId: TENANT, monthlyLimitCents: 2500,
    aiEnabled: true, adminEmail: 'owner@maple.example', expiresInDays: 7, seatLimit: 5, firmId: 'injected' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.firm.id, FIRM); assert.match(r.json.acceptUrl, /#invite=C{43}$/);
  const [create, invite] = seen.slice(-2);
  assert.deepEqual(create.body, { name: 'Fictional Maple CPA', entraTenantId: TENANT, monthlyLimitCents: 2500, aiEnabled: true });
  assert.deepEqual(invite.body, { email: 'owner@maple.example', role: 'firm_admin', expiresInDays: 7 });
  assert.equal(invite.url, `/v1/admin/firms/${FIRM}/invitations`);
});

test('firm is kept and reported when only the invitation fails', async () => {
  respond = (m, u) => u === '/v1/admin/firms' ? [201, { firm: { id: FIRM, name: 'Fictional Birch LLP' } }] : [400, { error: 'invalid-email' }];
  const r = await req(base, admin, 'POST', '/api/overview/excel/firms', { name: 'Fictional Birch LLP', entraTenantId: TENANT, monthlyLimitCents: 0, adminEmail: 'bad' });
  assert.equal(r.status, 200); assert.equal(r.json.firm.id, FIRM); assert.match(r.json.inviteError, /valid work email/);
});

test('Excel service errors become clear messages with safe status codes', async () => {
  respond = () => [409, { error: 'tenant-already-registered' }];
  let r = await req(base, admin, 'POST', '/api/overview/excel/firms', { name: 'Dup', entraTenantId: TENANT, monthlyLimitCents: 0 });
  assert.equal(r.status, 409); assert.match(r.json.error, /already has a Sumlora for Excel firm/);
  respond = () => [500, { error: 'internal-error' }];
  r = await req(base, admin, 'GET', '/api/overview/excel/firms');
  assert.equal(r.status, 503); assert.match(r.json.error, /not responding/);
  respond = () => [401, { error: 'bad-signature' }];
  r = await req(base, admin, 'GET', '/api/overview/excel/firms');
  assert.equal(r.status, 502); assert.match(r.json.error, /EXCEL_ADMIN_HMAC_SECRET/);
  const ov = await req(base, admin, 'GET', '/api/overview/excel');
  assert.deepEqual([ov.status, ov.json.connected, ov.json.status], [200, false, 'unavailable']);
});

test('unreachable Excel service and invalid ids', async () => {
  const dead = createExcelAdminClient({ baseUrl: 'http://127.0.0.1:9', keyId: 'k1', secret: SECRET, timeoutMs: 500 });
  const { s, b, cookie } = await boot(dead);
  try {
    assert.equal((await req(b, cookie, 'GET', '/api/overview/excel/firms')).status, 503);
    assert.equal((await req(b, cookie, 'GET', '/api/overview/excel')).json.status, 'unavailable');
  } finally { await s.shutdown(); }
  const before = seen.length;
  assert.equal((await req(base, admin, 'POST', '/api/overview/excel/firms/..%2F..%2Fsummary/suspend', { reason: 'x' })).status, 400);
  assert.equal((await req(base, admin, 'POST', `/api/overview/excel/firms/${FIRM}/invitations/not-a-uuid/revoke`)).status, 400);
  assert.equal(seen.length, before, 'invalid ids never reach the Excel service');
});

test('suspend, reactivate, budget, invitations, revoke and activity are forwarded and logged', async () => {
  respond = (m, u, b) => {
    if (u.endsWith('/suspend')) return [200, { firm: { id: FIRM, name: 'Maple', status: 'suspended' } }];
    if (u.endsWith('/reactivate')) return [200, { firm: { id: FIRM, name: 'Maple', status: 'active' } }];
    if (u.endsWith('/ai-budget')) return [200, { firm: { id: FIRM, monthlyLimitCents: b.monthlyLimitCents, aiEnabled: b.aiEnabled } }];
    if (u.endsWith('/invitations') && m === 'GET') return [200, { invitations: [] }];
    if (u.endsWith('/revoke')) return [200, { invitation: { id: INV, state: 'revoked' } }];
    if (u.includes('/audit')) return [200, { events: [] }];
    return [404, { error: 'unknown-route' }];
  };
  assert.equal((await req(base, admin, 'POST', `/api/overview/excel/firms/${FIRM}/suspend`, { reason: 'Fictional test' })).json.firm.status, 'suspended');
  assert.deepEqual(seen.at(-1).body, { reason: 'Fictional test' });
  assert.equal((await req(base, admin, 'POST', `/api/overview/excel/firms/${FIRM}/reactivate`, {})).json.firm.status, 'active');
  assert.equal((await req(base, admin, 'PUT', `/api/overview/excel/firms/${FIRM}/ai-budget`, { monthlyLimitCents: 500, aiEnabled: false })).json.firm.monthlyLimitCents, 500);
  assert.equal((await req(base, admin, 'GET', `/api/overview/excel/firms/${FIRM}/invitations`)).status, 200);
  assert.equal((await req(base, admin, 'POST', `/api/overview/excel/firms/${FIRM}/invitations/${INV}/revoke`)).json.invitation.state, 'revoked');
  await req(base, admin, 'GET', `/api/overview/excel/firms/${FIRM}/audit?limit=9999`);
  assert.equal(seen.at(-1).url, `/v1/admin/firms/${FIRM}/audit?limit=200`);
  const log = (await req(base, admin, 'GET', '/api/security/log')).json;
  const events = (log.log || log).map(e => e.event);
  for (const e of ['excel-firm-created', 'excel-firm-suspended', 'excel-firm-reactivated', 'excel-ai-budget']) assert.ok(events.includes(e), e);
});

test('overview panel: buttons only work when connected; firm names are escaped', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/overview.js'), 'utf8');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = vm.createContext({ esc, LOC: () => 'en-CA', T: s => s, S: {}, ME: { platformAdmin: true }, document: { addEventListener() {} }, console });
  vm.runInContext(src, ctx);
  vm.runInContext("OV_EXCEL={connected:false,status:'not-configured'}", ctx);
  const off = vm.runInContext('ovExcelPanel()', ctx);
  assert.match(off, /data-ov="excel-invite" disabled/); assert.match(off, /EXCEL_ADMIN_API_URL/);
  vm.runInContext("OV_EXCEL={connected:true,status:'connected',firms:2,members:9,aiBudgetCents:5000,aiSpentCents:100}", ctx);
  const on = vm.runInContext('ovExcelPanel()', ctx);
  assert.doesNotMatch(on, /disabled/); assert.match(on, /Manage Excel firms/);
  vm.runInContext("OV_EXCEL={connected:false,status:'unavailable',message:'<img src=x onerror=1>'}", ctx);
  assert.match(vm.runInContext('ovExcelPanel()', ctx), /&lt;img src=x onerror=1&gt;/);
  assert.equal(vm.runInContext("ovxCents('25.00')", ctx), 2500);
  assert.equal(vm.runInContext("ovxCents('10.555')", ctx), null);
  assert.equal(vm.runInContext("ovxCents('100000.01')", ctx), null);
});

test('a firm owner does not see the administrator’s Excel actions in their own log', async () => {
  const log = (await req(base, owner, 'GET', '/api/security/log')).json.log;
  assert.ok(!log.some(e => String(e.event).startsWith('excel-')));
});
