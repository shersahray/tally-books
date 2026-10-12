/*
 * Sumlora cash-basis postings.
 *
 * Works in the browser (window.TallyCash) and in Node (require) so the tests can check it.
 *
 * The books are kept on the accrual basis: an invoice posts its income and sales tax on the invoice date, against
 * accounts receivable; a bill posts its expenses and tax against accounts payable. Reports can instead be shown on
 * the cash basis, the way QuickBooks Online does it:
 *   - An invoice, bill, credit note or vendor credit posts nothing on its own date. Each time it's settled, the same
 *     share of every line (income, expense, sales tax, inventory cost) is posted on the settlement date, against
 *     A/R or A/P. Settled means a payment (or, for a credit, a refund) pointing at it, or a credit used on it.
 *   - The payment's own entry is unchanged (bank against A/R or A/P), so A/R and A/P net to nothing for what's been
 *     paid, and unpaid amounts never reach the books: A/R, A/P and their income, expenses and tax all drop out.
 *   - Sales receipts, expenses, deposits, journal entries and everything else are already cash and stay as they are.
 *   - Invoices and bills brought over from other software as open balances (carried) stay as they are: what they're
 *     for was counted before the books started here.
 * Every settlement posts a balanced entry, so debits still equal credits.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyCash = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const DOC_KINDS = new Set(['invoice', 'bill', 'credit', 'vcredit']);
  const isCredit = k => k === 'credit' || k === 'vcredit';

  /** A line's class: its own (classes on each line), else its transaction's. */
  const clsOf = (l, e) => (l.cls != null ? l.cls : e.cls) || '';
  /** Accrual postings, one per ledger line, in the same shape as the app's postings(). */
  function accrualPostings(entries) {
    const out = [];
    for (const e of entries) for (const l of e.lines || []) out.push({ e, account: l.account, debit: +l.debit || 0, credit: +l.credit || 0, memo: l.memo || '', date: e.date, cls: clsOf(l, e) });
    return out;
  }

  /** When and how much of each document was settled: { docId: [{date, amount, via}] }, oldest first. */
  function settlements(entries, docs) {
    const by = new Map(), add = (id, x) => { let a = by.get(id); if (!a) by.set(id, a = []); a.push(x); };
    for (const e of entries) if (e.applyTo && +e.amount) add(e.applyTo, { date: e.date, amount: +e.amount, via: e.id });
    // A credit used on an invoice (or bill) settles both on the credit's date, like a payment.
    for (const c of docs) {
      if (!isCredit(c.kind) || !Array.isArray(c.applied)) continue;
      for (const a of c.applied) {
        if (!a || !(+a.amount)) continue;
        add(c.id, { date: c.date, amount: +a.amount, via: c.id });
        add(a.docId, { date: c.date, amount: +a.amount, via: c.id });
      }
    }
    for (const a of by.values()) a.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    return by;
  }

  /**
   * Cash-basis postings for the whole ledger.
   * entries, docs: the company's records. control: a Set (or array) of the A/R and A/P account ids.
   * Returns postings like accrualPostings(); a document's postings carry a copy of its entry dated the day it was
   * settled ({...entry, date, cashVia}), so a report can still open the invoice or bill behind a line.
   */
  function cashPostings(entries, docs, control) {
    const ctl = control instanceof Set ? control : new Set(control || []);
    const docById = new Map(docs.map(d => [d.id, d]));
    const paid = settlements(entries, docs);
    const out = [];
    for (const e of entries) {
      const d = e.docId && docById.get(e.docId);
      const total = d ? +d.total || 0 : 0;
      const lines = (e.lines || []).map(l => ({ account: l.account, v: (+l.debit || 0) - (+l.credit || 0), memo: l.memo || '', cls: clsOf(l, e) })).filter(l => Math.abs(l.v) >= 0.005);
      const ctlLines = lines.filter(l => ctl.has(l.account)), rest = lines.filter(l => !ctl.has(l.account));
      // Not an invoice, bill or credit we can convert: already cash.
      if (!d || !DOC_KINDS.has(d.kind) || d.carried || !(total > 0) || !DOC_KINDS.has(e.type) || !ctlLines.length || !rest.length) {
        for (const l of e.lines || []) out.push({ e, account: l.account, debit: +l.debit || 0, credit: +l.credit || 0, memo: l.memo || '', date: e.date, cls: clsOf(l, e) });
        continue;
      }
      const done = lines.map(() => 0); // what's been posted so far from each line
      let settled = 0;
      for (const s of paid.get(d.id) || []) {
        if (settled >= total - 0.004) break;
        const amt = Math.min(s.amount, r2(total - settled));
        settled = r2(settled + amt);
        let part;
        if (settled >= total - 0.004) part = lines.map((l, i) => r2(l.v - done[i])); // fully settled: the rest, so rounding never lingers
        else {
          const f = amt / total;
          part = lines.map(l => r2(l.v * f));
          // Keep it balanced: any rounding goes on the largest income or expense line, so A/R or A/P matches the payment.
          const off = r2(part.reduce((t, v) => t + v, 0));
          if (off) { let k = -1; lines.forEach((l, i) => { if (!ctl.has(l.account) && (k < 0 || Math.abs(l.v) > Math.abs(lines[k].v))) k = i; }); part[k] = r2(part[k] - off); }
        }
        const se = { ...e, date: s.date, cashVia: s.via };
        part.forEach((v, i) => {
          if (Math.abs(v) < 0.005) return;
          done[i] = r2(done[i] + v);
          out.push({ e: se, account: lines[i].account, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0, memo: lines[i].memo, date: s.date, cls: lines[i].cls });
        });
      }
    }
    return out;
  }

  return { cashPostings, accrualPostings, settlements };
});
