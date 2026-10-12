'use strict';
// Cash-basis reports: invoices and bills counted when they're paid, in proportion (public/cashbasis.js),
// and the company setting and saved reports that keep the choice.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cashPostings, accrualPostings, settlements } = require('../public/cashbasis.js');
const { createApp } = require('../src/server/app');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100 + 0;
const TYPE = { bank: 'Asset', ar: 'Asset', ap: 'Liability', hst: 'Liability', sales: 'Income', consult: 'Income', rent: 'Expense', supplies: 'Expense', equity: 'Equity' };
const CTL = new Set(['ar', 'ap']);

// Ledger lines the way the app posts them (docPostLines, payForm, refundForm).
const invoice = (id, date, lines, taxRate = 0.13) => {
  const sub = r2(lines.reduce((s, [, v]) => s + v, 0)), tax = r2(sub * taxRate), total = r2(sub + tax);
  return {
    doc: { id, kind: 'invoice', date, total, sub, tax },
    entry: { id: 'd_' + id, type: 'invoice', date, docId: id, lines: [{ account: 'ar', debit: total, credit: 0 }, ...lines.map(([a, v]) => ({ account: a, debit: 0, credit: v })), ...(tax ? [{ account: 'hst', debit: 0, credit: tax }] : [])] },
  };
};
const bill = (id, date, lines, taxRate = 0.13) => {
  const sub = r2(lines.reduce((s, [, v]) => s + v, 0)), tax = r2(sub * taxRate), total = r2(sub + tax);
  return {
    doc: { id, kind: 'bill', date, total, sub, tax },
    entry: { id: 'd_' + id, type: 'bill', date, docId: id, lines: [...lines.map(([a, v]) => ({ account: a, debit: v, credit: 0 })), ...(tax ? [{ account: 'hst', debit: tax, credit: 0 }] : []), { account: 'ap', debit: 0, credit: total }] },
  };
};
const credit = (id, date, account, amount, applied, taxRate = 0.13) => {
  const tax = r2(amount * taxRate), total = r2(amount + tax);
  return {
    doc: { id, kind: 'credit', date, total, applied },
    entry: { id: 'd_' + id, type: 'credit', date, docId: id, lines: [{ account, debit: amount, credit: 0 }, { account: 'hst', debit: tax, credit: 0 }, { account: 'ar', debit: 0, credit: total }] },
  };
};
const payment = (id, date, docId, amount) => ({ id, type: 'payment', date, applyTo: docId, amount, lines: [{ account: 'bank', debit: amount, credit: 0 }, { account: 'ar', debit: 0, credit: amount }] });
const billPayment = (id, date, docId, amount) => ({ id, type: 'billpayment', date, applyTo: docId, amount, lines: [{ account: 'ap', debit: amount, credit: 0 }, { account: 'bank', debit: 0, credit: amount }] });

// What a report adds up: an account's balance (debits − credits) for postings in [from, to].
const raw = (ps, account, from, to) => r2(ps.filter(p => p.account === account && (!from || p.date >= from) && (!to || p.date <= to)).reduce((s, p) => s + p.debit - p.credit, 0));
const pl = (ps, from, to) => {
  let inc = 0, exp = 0;
  for (const [a, t] of Object.entries(TYPE)) { if (t === 'Income') inc -= raw(ps, a, from, to); if (t === 'Expense') exp += raw(ps, a, from, to); }
  return { inc: r2(inc), exp: r2(exp), net: r2(inc - exp) };
};
/** Assets = liabilities + equity (with net income) at a date, and debits = credits. */
const balances = (ps, to) => {
  let A = 0, L = 0, E = 0;
  for (const [a, t] of Object.entries(TYPE)) { const v = raw(ps, a, null, to); if (t === 'Asset') A += v; else if (t === 'Liability') L -= v; else if (t === 'Equity') E -= v; }
  const ni = pl(ps, null, to).net, dr = ps.filter(p => p.date <= to).reduce((s, p) => s + p.debit, 0), cr = ps.filter(p => p.date <= to).reduce((s, p) => s + p.credit, 0);
  return { A: r2(A), LE: r2(L + E + ni), dr: r2(dr), cr: r2(cr) };
};
const ok = (ps, dates) => { for (const d of dates) { const b = balances(ps, d); assert.equal(b.A, b.LE, `balance sheet balances on ${d}`); assert.equal(b.dr, b.cr, `debits = credits on ${d}`); } };

test('partial payment of an invoice with HST recognises the same share of income and tax', () => {
  const inv = invoice('i1', '2026-03-05', [['sales', 800], ['consult', 200]]); // 1,000 + 130 HST = 1,130
  const entries = [inv.entry, payment('p1', '2026-03-20', 'i1', 565)], docs = [inv.doc];
  const acc = accrualPostings(entries), cash = cashPostings(entries, docs, CTL);
  // Accrual: all of it in March, with 565 still owing.
  assert.equal(raw(acc, 'sales'), -800); assert.equal(raw(acc, 'ar'), 565);
  // Cash: half was paid, so half of every line, on the payment date.
  assert.equal(raw(cash, 'sales'), -400); assert.equal(raw(cash, 'consult'), -100); assert.equal(raw(cash, 'hst'), -65);
  assert.equal(raw(cash, 'sales', '2026-03-01', '2026-03-19'), 0, 'nothing before it was paid');
  assert.equal(raw(cash, 'ar'), 0, 'A/R drops out on the cash basis');
  assert.equal(raw(cash, 'bank'), 565);
  assert.ok(cash.filter(p => p.e.docId === 'i1').every(p => p.date === '2026-03-20' && p.e.cashVia === 'p1'), 'posted on the payment date, linked to the invoice');
  ok(cash, ['2026-03-10', '2026-03-20', '2026-12-31']);
  // Paid in full later: everything, with no rounding left over.
  entries.push(payment('p2', '2026-04-02', 'i1', 565));
  const c2 = cashPostings(entries, docs, CTL);
  assert.equal(raw(c2, 'sales'), -800); assert.equal(raw(c2, 'hst'), -130); assert.equal(raw(c2, 'ar'), 0);
  assert.equal(pl(c2, '2026-04-01', '2026-04-30').inc, 500);
});

test('odd amounts stay balanced and land exactly on the total', () => {
  const inv = invoice('i2', '2026-01-10', [['sales', 99.99], ['consult', 33.33]]);
  const entries = [inv.entry, payment('a', '2026-01-11', 'i2', 10), payment('b', '2026-01-12', 'i2', 33.33), payment('c', '2026-01-13', 'i2', r2(inv.doc.total - 43.33))];
  const cash = cashPostings(entries, [inv.doc], CTL);
  for (const d of ['2026-01-11', '2026-01-12', '2026-01-13']) {
    const day = cash.filter(p => p.date === d && p.e.docId === 'i2');
    assert.equal(r2(day.reduce((s, p) => s + p.debit - p.credit, 0)), 0, `the share posted on ${d} balances`);
  }
  assert.equal(raw(cash, 'sales'), -99.99); assert.equal(raw(cash, 'consult'), -33.33); assert.equal(raw(cash, 'hst'), -inv.doc.tax);
  ok(cash, ['2026-01-11', '2026-01-12', '2026-01-13']);
});

test('a bill paid in two parts across two periods', () => {
  const b = bill('b1', '2026-05-28', [['rent', 2000], ['supplies', 400]]); // 2,400 + 312 = 2,712
  const entries = [b.entry, billPayment('bp1', '2026-06-10', 'b1', 1000), billPayment('bp2', '2026-07-15', 'b1', 1712)];
  const cash = cashPostings(entries, [b.doc], CTL);
  assert.equal(pl(cash, '2026-05-01', '2026-05-31').exp, 0, 'nothing in May, when the bill came in');
  const june = pl(cash, '2026-06-01', '2026-06-30').exp, july = pl(cash, '2026-07-01', '2026-07-31').exp;
  assert.equal(june, r2(2400 * 1000 / 2712)); assert.equal(r2(june + july), 2400);
  assert.equal(raw(cash, 'hst', '2026-06-01', '2026-06-30'), r2(312 * 1000 / 2712), 'input tax credit follows the payment');
  assert.equal(raw(cash, 'ap', null, '2026-06-30'), 0); assert.equal(raw(cash, 'ap'), 0);
  // Accrual P&L for May is unchanged.
  assert.equal(pl(accrualPostings(entries), '2026-05-01', '2026-05-31').exp, 2400);
  ok(cash, ['2026-05-31', '2026-06-30', '2026-07-31']);
});

test('a credit note applied to an invoice settles both, like a payment', () => {
  const inv = invoice('i3', '2026-02-01', [['sales', 1000]]); // 1,130
  const cn = credit('c1', '2026-02-15', 'sales', 200, [{ docId: 'i3', amount: 226 }]); // 226
  const entries = [inv.entry, cn.entry, payment('p3', '2026-03-01', 'i3', 904)], docs = [inv.doc, cn.doc];
  const s = settlements(entries, docs);
  assert.deepEqual(s.get('i3').map(x => [x.date, x.amount]), [['2026-02-15', 226], ['2026-03-01', 904]]);
  const cash = cashPostings(entries, docs, CTL);
  // On Feb 15: 226 of the invoice (200 income, 26 tax) and the whole credit (−200, −26) net to nothing.
  assert.equal(pl(cash, '2026-02-01', '2026-02-28').inc, 0);
  assert.equal(raw(cash, 'hst', null, '2026-02-28'), 0);
  // In March the cash received: 904 = 800 income + 104 HST.
  assert.equal(pl(cash, '2026-03-01', '2026-03-31').inc, 800);
  assert.equal(raw(cash, 'hst'), -104);
  assert.equal(raw(cash, 'ar'), 0);
  ok(cash, ['2026-02-01', '2026-02-15', '2026-03-31']);
  // A credit not used yet posts nothing on the cash basis.
  const cn2 = credit('c2', '2026-04-01', 'sales', 50, []);
  const c2 = cashPostings([...entries, cn2.entry], [...docs, cn2.doc], CTL);
  assert.equal(pl(c2, '2026-04-01', '2026-04-30').inc, 0);
  // Refunded: the refund settles the credit.
  const refund = { id: 'rf', type: 'refund', date: '2026-04-20', applyTo: 'c2', amount: 56.5, lines: [{ account: 'ar', debit: 56.5, credit: 0 }, { account: 'bank', debit: 0, credit: 56.5 }] };
  const c3 = cashPostings([...entries, cn2.entry, refund], [...docs, cn2.doc], CTL);
  assert.equal(pl(c3, '2026-04-01', '2026-04-30').inc, -50); assert.equal(raw(c3, 'ar'), 0);
  ok(c3, ['2026-04-30']);
});

test('sales receipts, expenses, deposits and journal entries are unchanged', () => {
  const sr = { id: 'd_s1', type: 'salesreceipt', date: '2026-08-01', docId: 's1', lines: [{ account: 'bank', debit: 113, credit: 0 }, { account: 'sales', debit: 0, credit: 100 }, { account: 'hst', debit: 0, credit: 13 }] };
  const ex = { id: 'x1', type: 'expense', date: '2026-08-02', lines: [{ account: 'supplies', debit: 50, credit: 0 }, { account: 'bank', debit: 0, credit: 50 }] };
  const je = { id: 'j1', type: 'journal', date: '2026-08-03', lines: [{ account: 'bank', debit: 1000, credit: 0 }, { account: 'equity', debit: 0, credit: 1000 }] };
  const docs = [{ id: 's1', kind: 'sreceipt', date: '2026-08-01', total: 113 }];
  const entries = [sr, ex, je], acc = accrualPostings(entries), cash = cashPostings(entries, docs, CTL);
  const strip = ps => ps.map(p => [p.e.id, p.account, p.debit, p.credit, p.date]);
  assert.deepEqual(strip(cash), strip(acc));
  // A journal entry to A/R isn't touched either.
  const jar = { id: 'j2', type: 'journal', date: '2026-08-04', lines: [{ account: 'ar', debit: 10, credit: 0 }, { account: 'sales', debit: 0, credit: 10 }] };
  assert.equal(raw(cashPostings([jar], [], CTL), 'ar'), 10);
});

test('an invoice brought over as an open balance stays as it is', () => {
  const doc = { id: 'o1', kind: 'invoice', date: '2025-12-01', total: 500, carried: true };
  const entry = { id: 'd_o1', type: 'invoice', date: '2025-12-01', docId: 'o1', lines: [{ account: 'ar', debit: 500, credit: 0 }, { account: 'ar', debit: 0, credit: 500 }] };
  const cash = cashPostings([entry, payment('po', '2026-01-05', 'o1', 500)], [doc], CTL);
  assert.equal(raw(cash, 'bank'), 500); assert.equal(raw(cash, 'ar'), -500, 'the payment clears what the trial balance brought in');
});

test('P&L and balance sheet balance on the cash basis with everything together', () => {
  const i = invoice('i9', '2026-01-15', [['sales', 3000]]), b = bill('b9', '2026-01-20', [['rent', 1200]]), j = invoice('i10', '2026-02-01', [['consult', 750]]);
  const cn = credit('c9', '2026-02-10', 'sales', 300, [{ docId: 'i9', amount: 339 }]);
  const entries = [i.entry, b.entry, j.entry, cn.entry, payment('p9', '2026-02-05', 'i9', 1000), billPayment('q9', '2026-02-25', 'b9', 678), payment('p10', '2026-03-31', 'i10', 847.5),
    { id: 'je', type: 'journal', date: '2026-01-01', lines: [{ account: 'bank', debit: 5000, credit: 0 }, { account: 'equity', debit: 0, credit: 5000 }] }];
  const docs = [i.doc, b.doc, j.doc, cn.doc], cash = cashPostings(entries, docs, CTL);
  ok(cash, ['2026-01-31', '2026-02-10', '2026-02-28', '2026-03-31']);
  ok(accrualPostings(entries), ['2026-01-31', '2026-03-31']);
  // On the cash basis, net income is the cash in and out (before tax) and A/R, A/P are nil.
  assert.equal(raw(cash, 'ar'), 0); assert.equal(raw(cash, 'ap'), 0);
  const bank = raw(cash, 'bank') - 5000, net = pl(cash, null, '2026-12-31').net, tax = -raw(cash, 'hst');
  assert.equal(r2(net + tax), r2(bank), 'net income plus tax collected = cash moved');
});

/* ---------- the company setting and saved reports ---------- */
let server, base, dir, co, cookie;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-cash-'));
  server = createApp({ dataDir: dir, autoBackup: false, autoFeeds: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Sher', username: 'sher@example.com', password: 'correct horse battery staple' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
  co = (await call('POST', '/api/companies', { name: 'Cash Co', province: 'ON' })).json.company.id;
});
after(async () => { await server.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
async function call(method, url, body) {
  const res = await fetch(base + url.replace('/c/', `/c/${co}/`), { method, headers: { 'Content-Type': 'application/json', cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const company = async () => (await call('GET', '/api/c/state')).json.company;

test('settings: reports default to accrual, can be set to cash, and saved reports keep the choice', async () => {
  const c0 = await company();
  assert.equal(c0.reportBasis, 'accrual');
  assert.equal((await call('PUT', '/api/c/settings', { ...c0, reportBasis: 'cash' })).status, 200);
  assert.equal((await company()).reportBasis, 'cash');
  assert.equal((await call('PUT', '/api/c/settings', { ...c0, reportBasis: 'modified cash' })).status, 200);
  assert.equal((await company()).reportBasis, 'accrual', 'anything else is accrual');
  const c1 = await company();
  assert.equal((await call('PUT', '/api/c/settings', { ...c1, savedReports: [
    { id: 'r1', name: 'Cash P&L', tab: 'pl', period: 'fy', basis: 'cash' },
    { id: 'r2', name: 'Accrual BS', tab: 'bs', period: 'fy', basis: 'accrual' },
    { id: 'r3', name: 'Odd', tab: 'pl', period: 'fy', basis: '<b>x</b>' },
    { id: 'r4', name: 'Older', tab: 'pl', period: 'fy' },
  ] })).status, 200);
  assert.deepEqual((await company()).savedReports.map(r => [r.id, r.basis]), [['r1', 'cash'], ['r2', 'accrual'], ['r3', undefined], ['r4', undefined]]);
});
