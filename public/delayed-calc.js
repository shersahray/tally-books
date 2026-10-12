/*
 * Delayed charges and delayed credits, like QuickBooks Online's: work done or credit owed to a customer, noted now
 * and billed later. They aren't in the books until they're added to an invoice; then they're closed and linked to it
 * (invoiceId). A delayed credit goes on the invoice as a negative line. Deleting the invoice, or taking the lines
 * off it, opens them again.
 *
 * Works in the browser (window.TallyDelayed) and in Node (require), so the server and the tests use the same rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyDelayed = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KINDS = ['charge', 'credit'];
  const cents = n => Math.round((Number(n) || 0) * 100);

  /** The amount before sales tax: quantity × rate on each line, to the cent. Always positive (a credit is subtracted on the invoice). */
  const total = r => (r && Array.isArray(r.lines) ? r.lines : []).reduce((s, l) => s + cents((Number(l.qty) || 0) * (Number(l.rate) || 0)), 0) / 100;

  /** Open: not on an invoice, or on one that no longer exists. */
  const isOpen = (r, docs) => !r.invoiceId || !(docs || []).some(d => d.id === r.invoiceId);

  /** What a customer can add to an invoice: their open ones, and those already on this invoice (when editing it), oldest first. */
  function forInvoice(list, docs, contactId, invoiceId) {
    if (!contactId) return [];
    return (list || []).filter(r => r.contactId === contactId && (isOpen(r, docs) || (invoiceId && r.invoiceId === invoiceId)))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.created || 0) - (b.created || 0));
  }

  /**
   * The invoice lines for one: the same product, description, account, rate and tax code, a credit's quantity made
   * negative (so its amount is negative, and an inventory item on it comes back into stock), and `dl` (its id) so the
   * invoice knows which lines came from it. Each line keeps its class, or takes the delayed charge's own.
   */
  function invoiceLines(r) {
    const sign = r.kind === 'credit' ? -1 : 1;
    return (r.lines || []).filter(l => l && (Number(l.qty) || 0) * (Number(l.rate) || 0)).map(l => ({
      ...(l.item ? { item: l.item } : {}), desc: l.desc || '', account: l.account || '', qty: sign * (Number(l.qty) || 0),
      rate: Number(l.rate) || 0, taxCode: l.taxCode || 'std',
      ...(l.cls != null && l.cls !== '' ? { cls: l.cls } : r.cls ? { cls: r.cls } : {}), dl: r.id,
    }));
  }

  /**
   * After an invoice is saved with these lines: which delayed charges and credits to close (newly on it) and which to
   * open again (were on it, now aren't). linked: the ones whose invoiceId is this invoice now.
   */
  function links(list, invoiceId, lines) {
    const on = new Set((lines || []).map(l => l && l.dl).filter(Boolean));
    const byId = new Map((list || []).map(r => [r.id, r]));
    const close = [...on].filter(id => byId.has(id) && (byId.get(id).invoiceId !== invoiceId || byId.get(id).status !== 'closed'));
    const reopen = (list || []).filter(r => r.invoiceId === invoiceId && !on.has(r.id)).map(r => r.id);
    return { close, reopen };
  }

  /**
   * What to save after an invoice is saved (doc) or deleted (doc null): each delayed charge or credit closed and linked
   * to it, or opened again. Returns [{ id, data }] (data without id). The server and the demo both run this, so the
   * links follow the invoice's own lines and can't drift.
   */
  function sync(list, docId, doc) {
    const lines = doc && doc.kind === 'invoice' ? doc.lines : [];
    const { close, reopen } = links(list, docId, lines), byId = new Map((list || []).map(r => [r.id, r])), out = [];
    const strip = r => { const c = { ...r }; delete c.id; return c; };
    for (const id of close) out.push({ id, data: { ...strip(byId.get(id)), status: 'closed', invoiceId: docId } });
    for (const id of reopen) out.push({ id, data: { ...strip(byId.get(id)), status: 'open', invoiceId: '' } });
    return out;
  }

  return { KINDS, total, isOpen, forInvoice, invoiceLines, links, sync };
});
