'use strict';
// Workflow reminders (Plus): the rules in public/workflows.js, each template due / not due, repeats, dismiss and snooze, roles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../public/workflows.js');

const T0 = '2026-10-12';
const owner = { id: 'u1', role: 'owner', perms: null, username: 'o@x.ca', approver: true };
const staff = { id: 'u2', role: 'staff', perms: null, username: 's@x.ca' };
const salesOnly = { id: 'u3', role: 'staff', perms: { sales: 'edit' }, username: 'ar@x.ca' };
const client = { id: 'u4', role: 'client', perms: null, username: 'c@x.ca' };
const people = [owner, staff, salesOnly, client];
const on = (k, extra = {}) => ({ rules: { [k]: { on: true, ...extra } } });
const books = extra => ({ company: { name: 'Co', fyStart: 1, filingFreq: 'quarterly', taxName: 'HST' }, contacts: [{ id: 'c1', name: 'Ana' }, { id: 'v1', name: 'Vendor' }], ...extra });
const ev = (settings, b, extra = {}) => W.evaluate({ settings, books: b, people, today: T0, features: { payroll: true, billApprovals: true }, ...extra });
const inv = (id, due, total = 100, extra = {}) => ({ id, kind: 'invoice', number: id.toUpperCase(), contactId: 'c1', date: '2026-08-01', due, total, ...extra });

test('settings are cleaned: defaults, limits, unknown templates dropped, bad values refused', () => {
  assert.deepEqual(W.clean(undefined), { rules: {} });
  const c = W.clean({ rules: { invoiceOverdue: { on: true }, nonsense: { on: true } } });
  assert.deepEqual(Object.keys(c.rules), ['invoiceOverdue']);
  assert.equal(c.rules.invoiceOverdue.days, 7);
  assert.equal(c.rules.invoiceOverdue.repeat, 7);
  assert.equal(c.rules.invoiceOverdue.who, 'staff');
  assert.equal(c.rules.invoiceOverdue.customer, false);
  assert.equal('customer' in W.clean(on('billDue')).rules.billDue, false, 'only invoices and estimates email customers');
  assert.throws(() => W.clean({ rules: { billDue: { on: true, days: 400 } } }), /0 to 365/);
  assert.throws(() => W.clean({ rules: { billDue: { on: true, days: 2.5 } } }), /0 to 365/);
  assert.throws(() => W.clean({ rules: { invoiceOverdue: { on: true, repeat: -1 } } }), /every 0 to 365/);
  assert.throws(() => W.clean({ rules: { billDue: { on: true, who: 'approvers' } } }), /who gets reminded/, 'approvers only for bills waiting for approval');
  assert.throws(() => W.clean({ rules: { billDue: { on: true, who: 'people', people: [] } } }), /at least one person/);
  assert.deepEqual(W.clean({ rules: { billDue: { on: false, who: 'people', people: [] } } }).rules.billDue.people, [], 'off: fine to leave empty');
  assert.deepEqual(W.clean({ rules: { billDue: { who: 'owners', people: ['u1'] } } }).rules.billDue.people, [], 'people kept only when chosen');
  assert.throws(() => W.clean({ rules: [] }), /must be an object/);
  assert.throws(() => W.clean('x'), /must be an object/);
});

test('invoice overdue: due, not due, paid, repeat interval', () => {
  const b = books({ docs: [inv('i1', '2026-10-01'), inv('i2', '2026-10-10'), inv('i3', '2026-09-01'), inv('i4', '2026-09-01', 50)], entries: [{ applyTo: 'i4', amount: 50 }] });
  const hits = ev(on('invoiceOverdue', { days: 7, repeat: 7 }), b);
  assert.deepEqual(hits.map(h => h.id).sort(), ['i1', 'i3'], '11 and 41 days late; 2 days is too soon; paid is done');
  const i3 = hits.find(h => h.id === 'i3');
  assert.equal(i3.key, 'invoiceOverdue|i3|2026-09-01|4', '41 days late: the 5th reminder (days 7, 14, 21, 28, 35)');
  assert.equal(i3.vars.amount, 100);
  assert.equal(ev(on('invoiceOverdue', { days: 7, repeat: 0 }), b).find(h => h.id === 'i3').key, 'invoiceOverdue|i3|2026-09-01|0', 'no repeat: one key');
  // A credit note used on it counts as paid.
  const b2 = books({ docs: [inv('i1', '2026-10-01'), { id: 'cr', kind: 'credit', total: 100, applied: [{ docId: 'i1', amount: 100 }] }] });
  assert.equal(ev(on('invoiceOverdue'), b2).length, 0);
  // days 0 still means at least one day late.
  assert.equal(ev(on('invoiceOverdue', { days: 0 }), books({ docs: [inv('i1', T0)] })).length, 0);
  assert.equal(ev(on('invoiceOverdue', { days: 0 }), books({ docs: [inv('i1', '2026-10-11')] })).length, 1);
});

test('bill coming due: within N days, not too far ahead, not long past, not paid', () => {
  const bill = (id, due, extra = {}) => ({ id, kind: 'bill', number: id, contactId: 'v1', date: '2026-09-01', due, total: 200, ...extra });
  const b = books({ docs: [bill('b1', '2026-10-14'), bill('b2', '2026-10-20'), bill('b3', '2026-10-12'), bill('b4', '2026-08-01'), bill('b5', '2026-10-13')], entries: [{ applyTo: 'b5', amount: 200 }] });
  assert.deepEqual(ev(on('billDue', { days: 3 }), b).map(h => h.id).sort(), ['b1', 'b3']);
  assert.equal(ev(on('billDue', { days: 3 }), b)[0].key, 'billDue|b1|2026-10-14');
});

test('bill waiting for approval: since it was sent for approval; only approvers, never who entered it', () => {
  const at = Date.parse('2026-10-08T15:00:00');
  const b = books({ docs: [
    { id: 'b1', kind: 'bill', contactId: 'v1', date: '2026-09-01', total: 900, approval: { status: 'waiting', enteredBy: 's@x.ca', history: [{ action: 'submitted', at }] } },
    { id: 'b2', kind: 'bill', contactId: 'v1', date: '2026-09-01', total: 900, approval: { status: 'approved', history: [{ action: 'submitted', at }] } },
    { id: 'b3', kind: 'bill', contactId: 'v1', date: '2026-10-11', total: 900, approval: { status: 'waiting', enteredBy: 'o@x.ca', history: [] } },
  ] });
  const hits = ev(on('billApproval', { days: 2 }), b);
  assert.deepEqual(hits.map(h => h.id), ['b1'], 'b2 approved; b3 only a day');
  assert.equal(hits[0].key, 'billApproval|b1|2026-10-08');
  assert.deepEqual(hits[0].to, ['u1'], 'approvers: the owner (u2 entered it and isn’t an approver)');
  const approverStaff = { ...staff, approver: true };
  assert.deepEqual(W.evaluate({ settings: on('billApproval', { days: 2 }), books: b, people: [owner, approverStaff], today: T0, features: { billApprovals: true }, owners: 1 })[0].to, ['u1'], 'an approver who entered the bill isn’t reminded');
  // The only owner entered it: they're reminded (they can approve their own).
  const b4 = books({ docs: [{ ...b.docs[0], approval: { ...b.docs[0].approval, enteredBy: 'o@x.ca' } }] });
  assert.deepEqual(W.evaluate({ settings: on('billApproval', { days: 2 }), books: b4, people: [owner], today: T0, features: { billApprovals: true }, owners: 1 })[0].to, ['u1']);
  assert.deepEqual(W.evaluate({ settings: on('billApproval', { days: 2 }), books: b4, people: [owner, { ...owner, id: 'u9', username: 'o2@x.ca' }], today: T0, features: { billApprovals: true }, owners: 2 })[0].to, ['u9'], 'two owners: the other one');
  assert.equal(ev(on('billApproval'), b, { features: { billApprovals: false } }).length, 0, 'approvals off: nothing');
});

test('bank lines waiting: grouped by account, by when they came in', () => {
  const imp = d => Date.parse(d + 'T10:00:00');
  const b = books({ accounts: [{ id: 'a1', name: 'Chequing' }], bankTxns: [
    { id: 't1', account: 'a1', status: 'new', date: '2026-09-01', imported: imp('2026-10-01') },
    { id: 't2', account: 'a1', status: 'new', date: '2026-09-02', imported: imp('2026-09-30') },
    { id: 't3', account: 'a1', status: 'new', date: '2026-09-02', imported: imp('2026-10-10') },
    { id: 't4', account: 'a1', status: 'added', date: '2026-09-02', imported: imp('2026-09-01') },
  ] });
  const hits = ev(on('bankReview', { days: 7 }), b);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].key, 'bankReview|a1');
  assert.equal(hits[0].vars.count, 2);
  assert.equal(hits[0].due, '2026-09-30');
  assert.match(W.describe(hits[0], 'en', T0), /2 bank lines in Chequing have waited 7 days/);
});

test('estimate not accepted: from when it was sent; accepted, invoiced or expired ones are left out', () => {
  const sentAt = Date.parse('2026-10-01T09:00:00');
  const est = (id, extra) => ({ id, number: id, contactId: 'c1', date: '2026-09-01', total: 500, status: 'open', ...extra });
  const b = books({ estimates: [est('e1', { sent: [{ at: sentAt, what: 'estimate' }] }), est('e2', { sent: [{ at: Date.parse('2026-10-10T09:00:00') }] }), est('e3', { status: 'accepted' }), est('e4', { invoiceId: 'i1' }), est('e5', { expires: '2026-10-01' }), est('e6', {})] });
  const hits = ev(on('estimateFollowup', { days: 7 }), b);
  assert.deepEqual(hits.map(h => h.id), ['e1', 'e6'], 'e6 was never emailed from here: its date counts');
  assert.equal(hits[0].key, 'estimateFollowup|e1|2026-10-01');
  // The follow-up email itself doesn't count as a new sending.
  const b2 = books({ estimates: [est('e1', { sent: [{ at: sentAt, what: 'estimate' }, { at: Date.parse('2026-10-09T09:00:00'), what: 'followup' }] })] });
  assert.equal(ev(on('estimateFollowup', { days: 7 }), b2)[0].key, 'estimateFollowup|e1|2026-10-01');
});

test('payroll remittance coming due: unpaid source deductions within N days', () => {
  const run = (payDate, cpp) => ({ payDate, lines: [{ ded: { cpp, fedTax: 100 }, er: { cpp } }] });
  const b = books({ company: { name: 'Co', payroll: { remitFreq: 'monthly' } }, payruns: [run('2026-09-25', 50), run('2026-08-25', 50)], entries: [{ type: 'payremit', agency: 'cra', period: '2026-08', amount: 200 }] });
  const hits = ev(on('payrollRemit', { days: 5 }), b);
  assert.equal(hits.length, 1, 'September’s is due October 15; August’s is paid');
  assert.equal(hits[0].key, 'payrollRemit|cra|2026-09');
  assert.equal(hits[0].due, '2026-10-15');
  assert.equal(hits[0].vars.amount, 200);
  assert.equal(ev(on('payrollRemit', { days: 2 }), b).length, 0, 'not within 2 days');
  assert.equal(ev(on('payrollRemit', { days: 5 }), b, { features: { payroll: false } }).length, 0, 'payroll off');
  const q = books({ company: { name: 'Co', payroll: { remitFreq: 'quarterly' } }, payruns: [run('2026-09-25', 50)] });
  assert.equal(ev(on('payrollRemit', { days: 5 }), q)[0].key, 'payrollRemit|cra|2026-Q3');
});

test('sales tax return coming due: not filed, within N days', () => {
  const accounts = [{ id: 'tx', detail: 'tax' }, { id: 'bk', detail: 'bank' }];
  const entries = [{ date: '2026-08-10', lines: [{ account: 'tx', credit: 13 }] }];
  const b = books({ accounts, entries, filings: [] });
  // Q3 (Jul–Sep) is due Oct 31: within 20 days, not within 7.
  assert.equal(ev(on('salesTaxDue', { days: 7 }), b).length, 0);
  const hits = ev(on('salesTaxDue', { days: 20 }), b);
  assert.deepEqual(hits.map(h => h.key), ['salesTaxDue|gst|2026-09-30']);
  assert.equal(hits[0].due, '2026-10-31');
  assert.match(W.describe(hits[0], 'en', T0, { money: String, date: s => s }), /HST return for 2026-07-01 to 2026-09-30 is due 2026-10-31/);
  assert.equal(ev(on('salesTaxDue', { days: 20 }), books({ accounts, entries, filings: [{ tax: 'gst', from: '2026-07-01', to: '2026-09-30' }] })).length, 0, 'filed');
});

test('receipts not dealt with: one reminder for the inbox', () => {
  const up = d => Date.parse(d + 'T10:00:00');
  const b = books({ receipts: [{ id: 'r1', status: 'inbox', uploadedAt: up('2026-10-01') }, { id: 'r2', status: 'inbox', uploadedAt: up('2026-10-11') }, { id: 'r3', status: 'done', uploadedAt: up('2026-09-01') }] });
  const hits = ev(on('receiptsInbox', { days: 3 }), b);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].vars.count, 1);
  assert.equal(hits[0].key, 'receiptsInbox|inbox');
});

test('who: owners, everyone, chosen people; roles that can’t see the area; never clients', () => {
  const b = books({ docs: [{ id: 'b1', kind: 'bill', contactId: 'v1', due: '2026-10-13', total: 10 }, inv('i1', '2026-10-01')] });
  assert.deepEqual(ev(on('invoiceOverdue'), b)[0].to, ['u1', 'u2', 'u3'], 'everyone who can see Sales');
  assert.deepEqual(ev(on('billDue'), b)[0].to, ['u1', 'u2'], 'the Sales-only role can’t see bills');
  assert.deepEqual(ev(on('invoiceOverdue', { who: 'owners' }), b)[0].to, ['u1']);
  assert.deepEqual(ev(on('invoiceOverdue', { who: 'people', people: ['u3', 'u4'] }), b)[0].to, ['u3'], 'a client is never reminded');
  assert.deepEqual(ev(on('billDue', { who: 'people', people: ['u3'] }), b)[0].to, [], 'chosen, but the role can’t see it');
  assert.equal(ev({ rules: { invoiceOverdue: { on: false } } }, b).length, 0, 'off');
});

test('sync: each reminder once; still there keeps marks; gone is done; nobody to remind adds nothing', () => {
  const hit = (key, to = ['u1', 'u2']) => ({ key, rule: 'invoiceOverdue', area: 'sales', col: 'docs', id: 'i1', due: '2026-10-01', vars: { number: '1', amount: 100 }, to });
  let s = W.sync(null, [hit('invoiceOverdue|i1|2026-10-01|0')], 1000);
  assert.equal(s.created.length, 1);
  s = W.sync(s.store, [hit('invoiceOverdue|i1|2026-10-01|0')], 2000);
  assert.equal(s.created.length, 0, 'checked again: not made again');
  assert.equal(s.changed, false, 'nothing changed');
  // Dismissed by one person stays dismissed for them only.
  let st = W.act(s.store, 'invoiceOverdue|i1|2026-10-01|0', 'u1', 'dismiss', 0, T0);
  assert.equal(W.forUser(st, 'u1', T0).length, 0);
  assert.equal(W.forUser(st, 'u2', T0).length, 1);
  s = W.sync(st, [hit('invoiceOverdue|i1|2026-10-01|0')], 3000);
  assert.equal(W.forUser(s.store, 'u1', T0).length, 0, 'a later check keeps it dismissed');
  // Snoozed: back the day the snooze ends.
  st = W.act(s.store, 'invoiceOverdue|i1|2026-10-01|0', 'u2', 'snooze', 3, T0);
  assert.equal(W.forUser(st, 'u2', T0).length, 0);
  assert.equal(W.forUser(st, 'u2', '2026-10-14').length, 0);
  assert.equal(W.forUser(st, 'u2', '2026-10-15').length, 1);
  assert.throws(() => W.act(st, 'invoiceOverdue|i1|2026-10-01|0', 'u2', 'snooze', 31, T0), /1 to 30/);
  assert.throws(() => W.act(st, 'invoiceOverdue|i1|2026-10-01|0', 'u9', 'dismiss', 0, T0), /isn’t in your list/, 'someone else’s');
  assert.throws(() => W.act(st, 'nope', 'u2', 'dismiss', 0, T0), /isn’t in your list/);
  // The next repeat is a new reminder (and shows again for the person who dismissed the last one).
  s = W.sync(st, [hit('invoiceOverdue|i1|2026-10-01|1')], 4000);
  assert.equal(s.created.length, 1);
  assert.equal(W.forUser(s.store, 'u1', T0).length, 1);
  assert.ok(s.store.items['invoiceOverdue|i1|2026-10-01|0'].done, 'the earlier one is done');
  // Paid: nothing found, so it's done and leaves the lists.
  s = W.sync(s.store, [], 5000);
  assert.equal(W.forUser(s.store, 'u1', T0).length, 0);
  // Coming back (unpaid again) brings back a done key.
  s = W.sync(s.store, [hit('invoiceOverdue|i1|2026-10-01|1')], 6000);
  assert.equal(s.created.length, 1);
  // Nobody to remind: nothing kept.
  assert.equal(W.sync(null, [hit('x|1', [])], 1).created.length, 0);
  // Done ones are let go after 60 days.
  const old = W.sync(W.sync(null, [hit('k|1')], 1).store, [], 2).store;
  assert.ok(old.items['k|1']);
  assert.equal(W.sync(old, [], 2 + 61 * 864e5).store.items['k|1'], undefined);
  // Roles: an area the person can't see any more is left out of their list.
  assert.equal(W.forUser(s.store, 'u1', T0, a => a !== 'sales').length, 0);
});

test('customer emails: at most once per repeat; failures tried the next day', () => {
  assert.equal(W.customerDue(undefined, T0, 7), true);
  assert.equal(W.customerDue({ day: '2026-10-10', ok: true }, T0, 7), false);
  assert.equal(W.customerDue({ day: '2026-10-05', ok: true }, T0, 7), true);
  assert.equal(W.customerDue({ day: '2026-09-01', ok: true }, T0, 0), false, 'no repeat: once');
  assert.equal(W.customerDue({ day: T0, ok: false }, T0, 7), false);
  assert.equal(W.customerDue({ day: '2026-10-11', ok: false }, T0, 7), true);
  const [subj, text] = W.customerEmail('invoice', { company: 'Co', name: 'Ana', num: 'I1', amount: '$100.00', due: 'Oct 1, 2026', pay: 'Pay by e-Transfer.' });
  assert.equal(subj, 'Reminder: invoice I1 is past due');
  assert.match(text, /\$100\.00 still owing, was due on Oct 1, 2026[\s\S]*Pay by e-Transfer/);
  assert.match(W.customerEmail('estimate', { company: 'Co', name: 'Ana', num: 'E1', amount: '$5', due: '' }, 'fr')[0], /^Suivi : soumission E1/);
});

test('describe: English and French for each template', () => {
  const f = { money: n => '$' + n, date: s => s };
  for (const k of W.KEYS) {
    const r = { rule: k, due: '2026-10-01', vars: { number: '9', who: 'Ana', amount: 5, count: 2, account: 'Chequing', days: 3, agency: 'cra', period: '2026-09', tax: 'GST/HST', from: '2026-07-01', to: '2026-09-30' } };
    assert.ok(W.describe(r, 'en', T0, f).length > 10, k);
    assert.ok(W.describe(r, 'fr', T0, f).length > 10, k);
  }
  assert.equal(W.describe({ rule: 'invoiceOverdue', due: '2026-10-01', vars: { number: '9', who: 'Ana', amount: 5 } }, 'en', T0, f), 'Invoice #9 for Ana is 11 days overdue ($5 owing).');
});
