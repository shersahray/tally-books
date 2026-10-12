'use strict';
// Workflow reminders (Plus) on the server: settings validation, plan gating, the check making each reminder once,
// dismiss and snooze, custom roles, customer emails (logged, limited) and the daily digest to staff.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createApp } = require('../src/server/app');

let server, base, dir, owner, co, myFirm, smtp, staff, staffId, arClerk, arId, ownerId;
const got = []; // messages the test mail server received
const PW = 'correct horse battery staple';
const TODAY = '2026-10-12';
async function req(cookie, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
const c = url => `/api/c/${co}${url}`;
const state = who => req(who, 'GET', c('/state')).then(r => r.json);
async function settings(patch, who = owner) {
  const { rev, closingDate, closingPassword, hasCode, ...co0 } = (await state(owner)).company;
  return req(who, 'PUT', c('/settings'), { ...co0, ...patch });
}
async function person(name, username, extra) {
  const r = await req(owner, 'POST', '/api/users', { name, username, password: 'temporary pass 123', role: 'staff', ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const login = await req(null, 'POST', '/api/auth/login', { username, password: 'temporary pass 123' });
  assert.equal((await req(login.cookie, 'POST', '/api/auth/password', { current: 'temporary pass 123', password: name + ' picks a long phrase' })).status, 200);
  return { id: r.json.user.id, cookie: login.cookie };
}
const inv = (number, due, total, contactId = 'ana') => ({ kind: 'invoice', number, contactId, date: '2026-08-01', due, lines: [{ desc: 'Work', account: 'a4000', qty: 1, rate: total, taxCode: 'none' }], sub: total, tax: 0, total });
const bill = (number, due, total) => ({ kind: 'bill', number, contactId: 've', date: '2026-09-01', due, lines: [{ desc: 'Stuff', account: 'a6500', qty: 1, rate: total, taxCode: 'none' }], sub: total, tax: 0, total });

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
        else if (/^MAIL FROM/i.test(line)) { cur.from = line; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO/i.test(line)) { cur.rcpt.push(line); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { mode = 'data'; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
        else sock.write('500 what\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-workflows-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false, autoWorkflows: false, mailAllowLocal: true, now: () => new Date(TODAY + 'T09:00:00') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await req(null, 'POST', '/api/auth/setup', { name: 'Sher', username: 'sher@example.com', password: PW, firmName: 'Sher Bookkeeping' });
  owner = s.cookie; ownerId = s.json.user.id;
  co = (await req(owner, 'POST', '/api/companies', { name: 'Maple Dental', province: 'ON' })).json.company.id;
  myFirm = (await req(owner, 'GET', '/api/firms')).json.myFirm;
  assert.equal((await req(owner, 'PUT', c('/records/contacts/ana'), { kind: 'customer', name: 'Ana', email: 'ana@client.example' })).status, 200);
  assert.equal((await req(owner, 'PUT', c('/records/contacts/bo'), { kind: 'customer', name: 'Bo' })).status, 200);
  assert.equal((await req(owner, 'PUT', c('/records/contacts/ve'), { kind: 'vendor', name: 'Supplier' })).status, 200);
  ({ id: staffId, cookie: staff } = await person('Sam Staff', 'sam@example.com'));
  const role = (await req(owner, 'POST', '/api/roles', { name: 'AR clerk', perms: { sales: 'edit' } })).json.role.id;
  ({ id: arId, cookie: arClerk } = await person('Ada Clerk', 'ada@example.com', { customRole: role }));
});
after(async () => { await server.shutdown(); smtp.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('settings: checked and cleaned; people must be in the firm; Settings area needed', async () => {
  let r = await settings({ workflows: { rules: { billDue: { on: true, days: 900 } } } });
  assert.equal(r.status, 400); assert.match(r.json.error, /0 to 365/);
  r = await settings({ workflows: { rules: { billDue: { on: true, who: 'people', people: ['u_nobody'] } } } });
  assert.equal(r.status, 400, 'someone not in the firm is dropped, leaving nobody'); assert.match(r.json.error, /at least one person/);
  r = await settings({ workflows: { rules: { billDue: { on: true, who: 'approvers' } } } });
  assert.equal(r.status, 400);
  r = await settings({ workflows: 'yes' });
  assert.equal(r.status, 400);
  r = await settings({ workflows: { rules: { invoiceOverdue: { on: true, days: 7, repeat: 7, customer: true }, billDue: { on: true, days: 3, who: 'people', people: [staffId, 'u_other'] }, junk: { on: true } } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const wf = (await state(owner)).company.workflows;
  assert.deepEqual(Object.keys(wf.rules).sort(), ['billDue', 'invoiceOverdue']);
  assert.deepEqual(wf.rules.billDue.people, [staffId]);
  // The AR clerk's role has no Settings: what they send for the rules is ignored (as for every Settings setting).
  r = await settings({ workflows: { rules: {} } }, arClerk);
  assert.equal(r.status, 200);
  assert.deepEqual((await state(owner)).company.workflows, wf);
});

test('the check makes each reminder once, for people whose role can see it', async () => {
  const w = [
    { op: 'set', collection: 'docs', id: 'i1', data: inv('1001', '2026-10-01', 300) },     // 11 days late
    { op: 'set', collection: 'docs', id: 'i2', data: inv('1002', '2026-10-10', 100) },     // 2 days late: not yet
    { op: 'set', collection: 'docs', id: 'i3', data: inv('1003', '2026-09-20', 50, 'bo') }, // late, no email address
    { op: 'set', collection: 'docs', id: 'b1', data: bill('B1', '2026-10-14', 80) },        // due in 2 days
  ];
  assert.equal((await req(owner, 'POST', c('/batch'), { writes: w })).status, 200);
  let out = await server.checkWorkflows(co);
  assert.equal(out.created, 3, JSON.stringify(out));
  out = await server.checkWorkflows(co);
  assert.equal(out.created, 0, 'checked again: nothing new');
  const mine = (await state(owner)).reminders;
  assert.deepEqual(mine.map(r => r.rule + ':' + r.id).sort(), ['invoiceOverdue:i1', 'invoiceOverdue:i3']);
  const sam = (await state(staff)).reminders;
  assert.deepEqual(sam.map(r => r.rule + ':' + r.id).sort(), ['billDue:b1', 'invoiceOverdue:i1', 'invoiceOverdue:i3'], 'Sam is chosen for bills');
  const ada = (await state(arClerk)).reminders;
  assert.deepEqual(ada.map(r => r.id).sort(), ['i1', 'i3'], 'the AR clerk sees invoices, not bills');
  // Paying the invoice takes it off everyone's list at the next check.
  assert.equal((await req(owner, 'PUT', c('/records/entries/p1'), { type: 'payment', date: '2026-10-12', contactId: 'bo', applyTo: 'i3', amount: 50, bank: 'a1000', lines: [{ account: 'a1000', debit: 50, credit: 0 }, { account: 'a1200', debit: 0, credit: 50 }] })).status, 200);
  await server.checkWorkflows(co);
  assert.deepEqual((await state(owner)).reminders.map(r => r.id), ['i1']);
});

test('customer email: sent once from the company’s mailbox, logged; no address is logged once', async () => {
  const before = got.length;
  // Not sent without the company's mailbox.
  const audit0 = (await req(owner, 'GET', c('/audit'))).json.rows;
  assert.ok(!audit0.some(r => /workflow: emailed/.test(r.summary)));
  assert.equal(got.length, before);
  assert.equal((await req(owner, 'PUT', c('/mail'), { host: '127.0.0.1', port: smtp.address().port, security: 'none', user: 'books@maple.example', pass: 'pw-123', fromName: 'Maple Dental' })).status, 200);
  // Another overdue invoice, for a customer with no email address.
  assert.equal((await req(owner, 'PUT', c('/records/docs/i4'), inv('1004', '2026-09-20', 40, 'bo'))).status, 200);
  await server.checkWorkflows(co);
  assert.equal(got.length, before + 1, 'one email: to Ana');
  assert.match(got[got.length - 1].rcpt[0], /ana@client\.example/);
  const body = Buffer.from(got[got.length - 1].data.split('\r\n\r\n').slice(2).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(body, /invoice 1001, with \$300\.00 still owing/);
  await server.checkWorkflows(co);
  assert.equal(got.length, before + 1, 'not again until the next repeat');
  const rows = (await req(owner, 'GET', c('/audit'))).json.rows;
  assert.equal(rows.filter(r => /workflow: emailed payment reminder for invoice #1001 to ana@client\.example/.test(r.summary)).length, 1);
  assert.equal(rows.filter(r => /no payment reminder for invoice #1004 sent: the customer has no email address/.test(r.summary)).length, 1, 'logged once');
  assert.equal(rows.find(r => /emailed payment reminder/.test(r.summary)).username, 'workflow');
  const i1 = (await state(owner)).docs.find(d => d.id === 'i1');
  assert.equal(i1.sent.slice(-1)[0].what, 'reminder');
  assert.equal((await req(owner, 'GET', c('/mail'))).json.sentToday >= 1, true, 'counted in the daily limit');
});

test('daily digest to staff from the server’s mailbox, at most once a day', async () => {
  assert.equal((await req(owner, 'PUT', '/api/sysmail', { host: '127.0.0.1', port: smtp.address().port, security: 'none', user: 'noreply@sumlora.example', pass: 'pw-456' })).status, 200);
  const r = await settings({ workflows: { rules: { invoiceOverdue: { on: true, days: 7, repeat: 7, customer: true }, billDue: { on: true, days: 3, who: 'people', people: [staffId], digest: true } } } });
  assert.equal(r.status, 200);
  assert.equal((await req(owner, 'PUT', c('/records/docs/b2'), bill('B2', '2026-10-13', 20))).status, 200);
  const n = got.length;
  const out = await server.checkWorkflows(co);
  assert.equal(out.digests, 1, JSON.stringify(out));
  assert.equal(got.length, n + 1);
  assert.match(got[got.length - 1].rcpt[0], /sam@example\.com/);
  assert.equal((await req(owner, 'PUT', c('/records/docs/b3'), bill('B3', '2026-10-13', 30))).status, 200);
  assert.equal((await server.checkWorkflows(co)).digests, 0, 'one a day');
});

test('dismiss and snooze: only one’s own reminders, for oneself', async () => {
  const sam = (await state(staff)).reminders;
  const b = sam.find(r => r.rule === 'billDue');
  assert.equal((await req(owner, 'POST', c('/reminders/' + encodeURIComponent(b.key)), { action: 'dismiss' })).status, 404, 'not in the owner’s list');
  assert.equal((await req(staff, 'POST', c('/reminders/' + encodeURIComponent(b.key)), { action: 'snooze', days: 99 })).status, 400);
  assert.equal((await req(staff, 'POST', c('/reminders/' + encodeURIComponent(b.key)), { action: 'snooze', days: 3 })).status, 200);
  assert.ok(!(await state(staff)).reminders.some(r => r.key === b.key), 'snoozed');
  const i = (await state(owner)).reminders.find(r => r.id === 'i1');
  assert.equal((await req(owner, 'POST', c('/reminders/' + encodeURIComponent(i.key)), { action: 'dismiss' })).status, 200);
  assert.ok(!(await state(owner)).reminders.some(r => r.id === 'i1'));
  assert.ok((await state(staff)).reminders.some(r => r.id === 'i1'), 'still in Sam’s list');
  await server.checkWorkflows(co);
  assert.ok(!(await state(owner)).reminders.some(r => r.id === 'i1'), 'a check doesn’t bring it back');
});

test('plan: rules can’t be turned on without the feature, and the check stops', async () => {
  assert.equal((await req(owner, 'POST', c('/workflows/check'), {})).status, 200);
  assert.equal((await req(owner, 'PUT', `/api/firms/${myFirm}`, { plan: 'essentials' })).status, 200);
  assert.deepEqual((await state(owner)).reminders, [], 'no reminders shown');
  const r = await settings({ workflows: { rules: { bankReview: { on: true } } } });
  assert.equal(r.status, 403); assert.match(r.json.error, /Workflow reminders isn’t part/);
  assert.equal((await settings({ workflows: { rules: {} } })).status, 200, 'turning everything off is fine');
  assert.equal((await req(owner, 'POST', c('/workflows/check'), {})).status, 403);
  assert.equal((await req(owner, 'POST', c('/reminders/x'), { action: 'dismiss' })).status, 403);
  assert.equal((await server.checkWorkflows(co)).skipped, true);
  assert.equal((await req(owner, 'PUT', `/api/firms/${myFirm}`, { plan: 'plus' })).status, 200);
});

test('reminders are server-only: not changed by settings, backups don’t carry them', async () => {
  const before = JSON.stringify((await state(owner)).reminders);
  assert.equal((await settings({ reminders: { items: {} } })).status, 200);
  assert.equal(JSON.stringify((await state(owner)).reminders), before);
});
