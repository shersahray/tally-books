'use strict';
// Accountant tools: attachments, questions to the client, adjusting and reversing entries, saved reports.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server/app');
const PDF = require('../public/pdf.js');

let server, base, dir, co, owner, client;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-review-'));
  server = createApp({ dataDir: dir, autoBackup: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', username: 'owner@example.com', password: 'correct horse battery staple' }) });
  owner = r.headers.get('set-cookie').split(';')[0];
  co = (await call(owner, 'POST', '/api/companies', { name: 'Review Co', province: 'ON' })).json.company.id;
  const link = (await call(owner, 'POST', '/api/users', { name: 'Pat', username: 'pat@example.com', role: 'client', companies: [co], invite: true })).json.user.link;
  const a = await fetch(base + '/api/auth/link/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link, password: 'purple walrus harbour lantern' }) });
  client = a.headers.get('set-cookie').split(';')[0];
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(ck, method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie: ck }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const je = (date, amt = 100, extra = {}) => ({ type: 'journal', date, memo: 'test', lines: [{ account: 'a6600', debit: amt, credit: 0 }, { account: 'a1000', debit: 0, credit: amt }], ...extra });
const pdf = () => { const d = PDF.create(); d.text(40, 40, 'Lease'); return Buffer.from(d.output()).toString('base64'); };

test('attachments: upload, read, and removed with their transaction', async () => {
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/e1', je('2026-09-01'))).status, 200);
  assert.equal((await call(owner, 'POST', '/api/c/attachments', { target: 'entries', targetId: 'nope', fileName: 'x.pdf', data: pdf() })).status, 404);
  assert.equal((await call(owner, 'POST', '/api/c/attachments', { target: 'entries', targetId: 'e1', fileName: 'x.exe', data: Buffer.from('MZ hello').toString('base64') })).status, 400);
  assert.equal((await call(client, 'POST', '/api/c/attachments', { target: 'entries', targetId: 'e1', fileName: 'lease.pdf', data: pdf() })).status, 403);
  const up = await call(owner, 'POST', '/api/c/attachments', { target: 'entries', targetId: 'e1', fileName: 'lease.pdf', data: pdf() });
  assert.equal(up.status, 200);
  const st = (await call(owner, 'GET', '/api/c/state')).json;
  const att = st.attachments.find(a => a.id === up.json.id);
  assert.equal(att.name, 'lease.pdf'); assert.equal(att.mediaType, 'application/pdf');
  const f = await fetch(`${base}/api/c/${co}/files/${att.fileId}`, { headers: { cookie: client } });
  assert.equal(f.status, 200, 'the client can open it');
  // Attachments can't be made or changed by a plain write.
  assert.equal((await call(owner, 'PUT', '/api/c/records/attachments/zz', { ...att, targetId: 'e1' })).status, 403);
  assert.equal((await call(client, 'DELETE', `/api/c/records/attachments/${att.id}`)).status, 403);
  // Deleting the transaction removes the file too.
  assert.equal((await call(owner, 'DELETE', '/api/c/records/entries/e1')).status, 200);
  assert.equal((await call(owner, 'GET', '/api/c/state')).json.attachments.length, 0);
  assert.equal((await fetch(`${base}/api/c/${co}/files/${att.fileId}`, { headers: { cookie: owner } })).status, 404);
});

test('questions: the team asks, the client answers, the team resolves', async () => {
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/e2', je('2026-09-02', 339))).status, 200);
  assert.equal((await call(owner, 'POST', '/api/c/questions', { target: 'entries', targetId: 'e2', text: '' })).status, 400);
  const q = await call(owner, 'POST', '/api/c/questions', { target: 'entries', targetId: 'e2', text: 'What was this for?' });
  assert.equal(q.status, 200);
  let st = (await call(client, 'GET', '/api/c/state')).json.questions[0];
  assert.equal(st.status, 'open'); assert.match(st.label, /339\.00/);
  assert.equal((await call(client, 'POST', `/api/c/questions/${q.json.id}/reply`, { text: 'Yoga mats' })).status, 200);
  st = (await call(owner, 'GET', '/api/c/state')).json.questions[0];
  assert.equal(st.status, 'answered'); assert.equal(st.thread.length, 2); assert.equal(st.thread[1].role, 'client');
  assert.equal((await call(client, 'POST', `/api/c/questions/${q.json.id}/resolve`)).status, 403, 'only the team resolves');
  assert.equal((await call(owner, 'POST', `/api/c/questions/${q.json.id}/resolve`)).status, 200);
  assert.equal((await call(owner, 'GET', '/api/c/state')).json.questions[0].status, 'resolved');
  assert.equal((await call(owner, 'PUT', '/api/c/records/questions/x', st)).status, 403, 'no plain writes');
  // A client can ask too; it shows as answered (waiting on the team).
  const cq = await call(client, 'POST', '/api/c/questions', { target: 'entries', targetId: 'e2', text: 'Can you move this to supplies?' });
  assert.equal((await call(owner, 'GET', '/api/c/state')).json.questions.find(x => x.id === cq.json.id).status, 'answered');
  // Deleting the transaction removes its questions.
  assert.equal((await call(owner, 'DELETE', '/api/c/records/entries/e2')).status, 200);
  assert.equal((await call(owner, 'GET', '/api/c/state')).json.questions.length, 0);
});

test('adjusting and reversing entries, cash flow sections and saved reports are checked', async () => {
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/j1', je('2026-09-30', 250, { adjusting: 'yes', reverseOn: '2026-09-30' }))).status, 400, 'reversal must be later');
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/j1', je('2026-09-30', 250, { adjusting: 'yes', reverseOn: '2026-10-01' }))).status, 200);
  assert.equal((await call(owner, 'PUT', '/api/c/records/entries/rv_j1', je('2026-10-01', 250, { reversalOf: 'j1' }))).status, 200);
  const st = (await call(owner, 'GET', '/api/c/state')).json;
  assert.equal(st.entries.find(e => e.id === 'j1').adjusting, true);
  assert.equal(st.entries.find(e => e.id === 'rv_j1').reversalOf, 'j1');
  assert.equal((await call(owner, 'PUT', '/api/c/records/accounts/a2400', { code: '2400', name: 'Loan payable', type: 'Liability', cf: 'bogus' })).status, 200);
  assert.equal((await call(owner, 'GET', '/api/c/state')).json.accounts.find(a => a.id === 'a2400').cf, '');
  const s = (await call(owner, 'GET', '/api/c/state')).json.company;
  const r = await call(owner, 'PUT', '/api/c/settings', { ...s, savedReports: [{ id: 'r1', name: 'Q CF', tab: 'cf', period: 'custom', from: '2026-07-01', to: 'nope', compare: 'quarters', evil: '<x>' }, { id: '', name: 'no id' }], notDuplicates: ['a|b'] });
  assert.equal(r.status, 200);
  const c = (await call(owner, 'GET', '/api/c/state')).json.company;
  assert.deepEqual(c.savedReports, [{ id: 'r1', name: 'Q CF', tab: 'cf', period: 'custom', from: '2026-07-01', to: '', compare: 'quarters', acct: '' }]);
  assert.deepEqual(c.notDuplicates, ['a|b']);
  assert.equal((await call(client, 'PUT', '/api/c/settings', { ...s })).status, 403, 'clients can’t save reports or settings');
});

test('GIFI codes: new charts get them, the server checks them, added accounts get a likely one', async () => {
  const G = require('../public/gifi.js');
  assert.equal(G.describe('8811'), 'Office stationery and supplies');
  assert.equal(G.describe('8811', 'fr'), 'Papeterie et fournitures de bureau');
  assert.equal(G.problem('', 'Asset'), '');
  assert.match(G.problem('8811', 'Asset'), /1000 to 2599/);
  assert.match(G.problem('88', 'Expense'), /4 digits/);
  assert.equal(G.problem('9270', 'Expense'), '');
  assert.equal(G.problem('9990', 'Expense'), '', 'income taxes');
  assert.equal(G.suggest({ type: 'Expense', name: 'Employer payroll taxes' }), '8622');
  assert.equal(G.suggest({ type: 'Expense', name: 'Frais bancaires' }), '8715');
  assert.equal(G.suggest({ type: 'Liability', name: 'Anything', detail: 'payroll_cra' }), '2627');
  assert.equal(G.suggest({ type: 'Equity', name: 'Opening balance equity', detail: 'ob' }), '');

  const accts = (await call(owner, 'GET', '/api/c/state')).json.accounts;
  const by = code => accts.find(a => a.code === code);
  assert.equal(by('1000').gifi, '1002');
  assert.equal(by('1500').gifi, '1740');
  assert.equal(by('2200').gifi, '2680');
  assert.equal(by('6400').gifi, '8811');
  assert.equal(by('3900').gifi, '', 'nothing sensible to suggest');

  const put = (id, data) => call(owner, 'PUT', `/api/c/records/accounts/${id}`, data);
  const r = await put('a1500', { ...by('1500'), gifi: '8811' });
  assert.equal(r.status, 400); assert.match(r.json.error, /Asset accounts/);
  assert.equal((await put('a1500', { ...by('1500'), gifi: '17x4' })).status, 400);
  assert.equal((await put('a1500', { ...by('1500'), gifi: '1774' })).status, 200);
  // Added without a code (as payroll and sales tax do): a likely one. Added with a blank code: left blank.
  assert.equal((await put('aPay', { code: '7110', name: 'Employer payroll taxes', type: 'Expense', detail: 'payroll_tax' })).status, 200);
  assert.equal((await put('aBlank', { code: '6990', name: 'Bank charges 2', type: 'Expense', detail: '', gifi: '' })).status, 200);
  const after = (await call(owner, 'GET', '/api/c/state')).json.accounts;
  assert.equal(after.find(a => a.id === 'aPay').gifi, '8622');
  assert.equal(after.find(a => a.id === 'aBlank').gifi, '');
  assert.equal(after.find(a => a.id === 'a1500').gifi, '1774');
  // Saving without the field keeps the code it had.
  const { gifi, ...noGifi } = after.find(a => a.id === 'a1500');
  assert.equal((await put('a1500', { ...noGifi, name: 'Computers' })).status, 200);
  assert.equal((await call(owner, 'GET', '/api/c/state')).json.accounts.find(a => a.id === 'a1500').gifi, '1774');
});
