/* Deposits on estimates (customer prepayments), shared by the browser, the server and the tests.
 * An estimate can ask for a deposit (a percent of its total or a fixed amount). Money received is a liability
 * until there's an invoice: Dr Bank, Cr Customer deposits (entry type 'custdeposit', pointing at the estimate).
 * When the estimate becomes an invoice, the deposit is used on it: Dr Customer deposits, Cr A/R ('depapply',
 * with applyTo = the invoice, so it counts as settled on the invoice like a payment). A cancelled job gets
 * its deposit back: Dr Customer deposits, Cr Bank ('deprefund'). Sales tax is reported on the invoice, not
 * on the deposit, so the deposit entries have no tax lines.
 * Works in the browser (window.TallyDeposits) and in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyDeposits = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const TYPES = ['custdeposit', 'depapply', 'deprefund'];
  const METHODS = ['etransfer', 'cheque', 'cash', 'card', 'other'];
  // An account already in the chart that's for customer deposits (it gets the job instead of a second one being made).
  const NAME_RE = /^(customer deposits( and retainers)?|dépôts (et provisions )?des clients)$/i;
  const ACCOUNT_DESC = 'Deposits customers paid before being invoiced. Used on the invoice when the estimate becomes one. Sales tax is reported on the invoice.';

  /** The deposit an estimate asks for, in dollars (0 when none). A percent is of the estimate's total, tax included. */
  function requested(est) {
    const d = est && est.deposit;
    if (!d || !(Number(d.value) > 0)) return 0;
    return d.kind === 'percent' ? r2((Number(est.total) || 0) * Number(d.value) / 100) : r2(d.value);
  }

  /** What's been received, used on invoices and refunded on an estimate, and what's still available. */
  function forEstimate(estId, entries, exceptId) {
    let received = 0, applied = 0, refunded = 0;
    const list = [];
    for (const e of entries || []) {
      if (e.estimateId !== estId || e.id === exceptId || !TYPES.includes(e.type)) continue;
      const a = Number(e.amount) || 0;
      if (e.type === 'custdeposit') received += a; else if (e.type === 'depapply') applied += a; else refunded += a;
      list.push(e);
    }
    received = r2(received); applied = r2(applied); refunded = r2(refunded);
    list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.created || 0) - (y.created || 0)));
    return { received, applied, refunded, available: r2(received - applied - refunded), list };
  }

  /** What's still to be paid toward the requested deposit (a refunded deposit isn't asked for again). */
  function outstanding(est, entries) {
    const s = forEstimate(est.id, entries);
    return Math.max(0, r2(requested(est) - s.received));
  }

  /** Deposits received and not used yet, by customer: { contactId: amount }. They're a credit for the customer. */
  function byCustomer(estimates, entries) {
    const out = {};
    for (const est of estimates || []) {
      const a = forEstimate(est.id, entries).available;
      if (a > 0.004) out[est.contactId] = r2((out[est.contactId] || 0) + a);
    }
    return out;
  }

  /** The ledger lines for each kind: dep is the Customer deposits account, other the bank or the A/R account. */
  function lines(type, dep, other, amount) {
    const a = r2(amount);
    return type === 'custdeposit'
      ? [{ account: other, debit: a, credit: 0 }, { account: dep, debit: 0, credit: a }]
      : [{ account: dep, debit: a, credit: 0 }, { account: other, debit: 0, credit: a }];
  }

  return { TYPES, METHODS, NAME_RE, ACCOUNT_DESC, requested, forEstimate, outstanding, byCustomer, lines, r2 };
});
