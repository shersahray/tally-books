'use strict';
// Year-end files are coming soon, but the administrator can let one firm (their own) try them early on real books.
// Run in a fresh Node without SUMLORA_YEAREND, as the live server runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const script = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApp } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server', 'app.js'))});
const P = require(${JSON.stringify(path.join(__dirname, '..', 'public', 'plans.js'))});
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-early-'));
  const server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, autoWorkflows: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  const req = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null), ck: r.headers.get('set-cookie') }; };
  const s = await req('POST', '/api/auth/setup', { name: 'Sher', username: 's@example.com', password: 'correct horse battery staple', firmName: 'Sher Bookkeeping' });
  cookie = s.ck.split(';')[0];
  const co = (await req('POST', '/api/companies', { name: 'Maple', province: 'ON' })).json.company.id;
  const st = (await req('GET', '/api/c/' + co + '/state')).json;
  const bank = st.accounts.find(a => a.detail === 'bank').id, sales = st.accounts.find(a => a.type === 'Income').id;
  const file = { yearEnd: '2025-12-31', snapshot: { lines: [{ account: bank, name: 'B', type: 'Asset', cur: 10, prior: 0 }, { account: sales, name: 'S', type: 'Income', cur: -10, prior: 0 }] } };
  const out = {};
  out.before = (await req('PUT', '/api/c/' + co + '/records/engagements/y1', file)).status;
  const firms = (await req('GET', '/api/firms')).json, me = { id: firms.myFirm };
  out.payrollEarly = (await req('PUT', '/api/firms/' + me.id, { early: ['payroll'] })).status;
  out.early = (await req('PUT', '/api/firms/' + me.id, { early: ['yearEndFiles'] })).status;
  out.firmEarly = (await req('GET', '/api/auth/me')).json.user.firmEarly;
  out.after = (await req('PUT', '/api/c/' + co + '/records/engagements/y1', file)).status;
  out.seen = (await req('GET', '/api/c/' + co + '/state')).json.engagements.length;
  out.payroll = (await req('PUT', '/api/c/' + co + '/records/employees/e1', { name: 'Ann', province: 'ON' })).status;
  out.planCheck = [P.featureOn('seed', {}, 'yearEndFiles', {}, ['yearEndFiles']), P.featureOn('thrive', {}, 'yearEndFiles', {}, []), P.featureOn('thrive', {}, 'payroll', {}, ['payroll'])];
  console.log(JSON.stringify(out));
  server.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });`;

test('a firm can try year-end files early; everyone else (and payroll) stays coming soon', () => {
  const env = { ...process.env }; delete env.SUMLORA_YEAREND; delete env.SUMLORA_PAYROLL;
  const r = JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(r.before, 403, 'coming soon');
  assert.equal(r.payrollEarly, 400, 'payroll can’t be tried early');
  assert.equal(r.early, 200);
  assert.deepEqual(r.firmEarly, ['yearEndFiles']);
  assert.equal(r.after, 200, 'on for this firm');
  assert.equal(r.seen, 1);
  assert.equal(r.payroll, 403, 'payroll still coming soon');
  assert.deepEqual(r.planCheck, [true, false, false], 'early access works on any plan, only for the firm that has it, and never for payroll');
});
