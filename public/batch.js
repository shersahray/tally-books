/*
 * Batch actions on the Sales list: which of the ticked documents each action takes, and running sends one at a time.
 * Works in the browser (window.TallyBatch) and in Node (require) so the tests can check it.
 *
 *   send   — email each invoice, credit note or sales receipt to its customer (skip: no email address)
 *   remind — email a reminder for each overdue invoice (skip: not overdue, no email address)
 *   print  — one combined PDF of the invoices, credit notes and sales receipts (bills have no PDF, so they're skipped)
 *   mark   — record invoices as sent without emailing them (sent some other way: by hand, in person, by post)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyBatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SALE = ['invoice', 'credit', 'sreceipt'];
  const ACTIONS = ['send', 'remind', 'print', 'mark'];

  /** Oldest first, then by number (1002 before 1010), so a printed stack or a run of emails follows the books. */
  function order(docs) {
    return docs.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true }));
  }

  /**
   * Split the ticked documents into those the action goes ahead with and those it skips, and why.
   * o.emailOf(doc) → the customer's email address ('' when none); o.isOverdue(doc) → true when past due with a balance.
   * Returns { go: [doc], skip: [{ doc, why }] } with why one of 'kind' (not something this action does), 'notoverdue', 'noemail'.
   */
  function plan(action, docs, o = {}) {
    if (!ACTIONS.includes(action)) throw new Error('Unknown batch action: ' + action);
    const go = [], skip = [];
    for (const d of order(docs || [])) {
      const why = action === 'remind' ? (d.kind !== 'invoice' || !(o.isOverdue && o.isOverdue(d)) ? 'notoverdue' : '')
        : action === 'mark' ? (d.kind !== 'invoice' ? 'kind' : '')
        : !SALE.includes(d.kind) ? 'kind' : '';
      if (why) { skip.push({ doc: d, why }); continue; }
      if ((action === 'send' || action === 'remind') && !String((o.emailOf && o.emailOf(d)) || '').trim()) { skip.push({ doc: d, why: 'noemail' }); continue; }
      go.push(d);
    }
    return { go, skip };
  }

  /**
   * Send one at a time (the mail route counts each address toward the company's daily limit, and mailboxes
   * throttle bursts). One failure doesn't stop the rest; but once the daily limit is reached (429) every later
   * send would fail the same way, so the rest are marked failed with that reason without trying.
   * sendOne(item) → promise; onProgress(i, total, item) is called before each one.
   * Returns [{ item, ok, error }] in order.
   */
  async function runSequential(items, sendOne, onProgress) {
    const out = [];
    let stop = null;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (stop) { out.push({ item, ok: false, error: stop }); continue; }
      if (onProgress) onProgress(i + 1, items.length, item);
      try { await sendOne(item); out.push({ item, ok: true }); }
      catch (e) {
        const error = String((e && e.message) || e || 'Unknown error');
        out.push({ item, ok: false, error });
        if (e && e.status === 429) stop = error;
      }
    }
    return out;
  }

  /** Counts for the summary: sent, skipped and failed. */
  function tally(results, skipped) {
    return { sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, skipped: (skipped || []).length };
  }

  return { SALE, ACTIONS, order, plan, runSequential, tally };
});
