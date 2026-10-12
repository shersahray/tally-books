/*
 * Sumlora report filters and attribution: which postings a filtered report adds up, which customer a transaction
 * belongs to (for the profit and loss by customer), and the rows of the transaction list.
 *
 * Works in the browser (window.TallyRepFilter) and in Node (require) so the tests can check it.
 *
 * A filter is { cust: [...], vend: [...], acct: [...], cls: [...], tag: [...] } (ids; '__none' in cust, vend or cls means
 * "without one"). Filters of different kinds stack (a posting must pass every one that's set), except customers and
 * vendors: a transaction has one name, so those two together mean "this customer or that vendor".
 * Tags don't exist in the books yet; a filter on them works once transactions carry tags: [ids].
 *
 * Postings are the app's: { e (the transaction), account, debit, credit, memo, date, cls }. cls is the line's class
 * (classes on each line) or else the transaction's; postings without it use the transaction's. ctx tells the module about names:
 * { kind: contactId -> 'customer' | 'vendor' | '', projCust: projectId -> customer id or '' }.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyRepFilter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = ['cust', 'vend', 'acct', 'cls', 'tag'];
  const MAX = 200;
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100 + 0;

  /** A filter as saved: only the kinds that are set, each a sorted list of unique short ids. null when nothing is set. */
  function clean(f) {
    if (!f || typeof f !== 'object') return null;
    const out = {};
    for (const k of KEYS) {
      if (!Array.isArray(f[k])) continue;
      const ids = [...new Set(f[k].filter(x => typeof x === 'string' && x && x.length <= 120))].slice(0, MAX).sort();
      if (ids.length) out[k] = ids;
    }
    return Object.keys(out).length ? out : null;
  }
  /** A short text that's the same for the same filter, for caching and for comparing saved reports. */
  const key = f => { const c = clean(f); return c ? JSON.stringify(c) : ''; };
  /** The filter without some kinds (for a report that has its own control for them). */
  const without = (f, ...ks) => { const c = clean(f); if (!c) return null; for (const k of ks) delete c[k]; return clean(c); };

  /** The customer a transaction belongs to: its name when that's a customer, else its project's customer, else ''. */
  function custOf(e, ctx) {
    if (e.contactId && ctx.kind(e.contactId) === 'customer') return e.contactId;
    if (e.proj) { const c = ctx.projCust(e.proj); if (c) return c; }
    return '';
  }
  /** A posting's class ('' for none): its own when it carries one, else its transaction's. */
  const clsOf = p => (p.cls !== undefined ? p.cls || '' : (p.e && p.e.cls) || '');
  /** The vendor on a transaction, or ''. */
  const vendOf = (e, ctx) => (e.contactId && ctx.kind(e.contactId) === 'vendor' ? e.contactId : '');

  /** A test for one posting. Built once per filter so a long ledger is checked quickly. */
  function matcher(f, ctx) {
    const c = clean(f);
    if (!c) return () => true;
    const set = k => (c[k] ? new Set(c[k]) : null);
    const cu = set('cust'), ve = set('vend'), ac = set('acct'), cl = set('cls'), tg = set('tag');
    return p => {
      const e = p.e;
      if (ac && !ac.has(p.account)) return false;
      if (cl && !cl.has(clsOf(p) || '__none')) return false;
      if (tg && !(Array.isArray(e.tags) && e.tags.some(t => tg.has(t)))) return false;
      if (cu || ve) {
        const okC = cu && cu.has(custOf(e, ctx) || '__none'), okV = ve && ve.has(vendOf(e, ctx) || '__none');
        if (!okC && !okV) return false;
      }
      return true;
    };
  }
  /** The postings that pass the filter (the same list when there's no filter). */
  function apply(postings, f, ctx) {
    if (!clean(f)) return postings;
    const m = matcher(f, ctx);
    return postings.filter(m);
  }

  /**
   * Customers for a profit and loss by customer, from the postings in [from, to] on income, cost of goods sold and
   * expense accounts (plTypes: accountId -> type). The busiest `top` customers by sales (then by costs) get a column;
   * the rest share "Other customers"; transactions with no customer go to "Not specified".
   * Returns { top: [ids], other: [ids], none: bool }.
   */
  function rankCustomers(postings, { from, to, types, ctx, top = 8 }) {
    const by = new Map(); let none = false;
    for (const p of postings) {
      if ((from && p.date < from) || (to && p.date > to)) continue;
      const t = types(p.account); if (t !== 'Income' && t !== 'Expense' && t !== 'Cost of Goods Sold') continue;
      const amt = p.debit - p.credit; if (!amt) continue;
      const c = custOf(p.e, ctx);
      if (!c) { none = true; continue; }
      const o = by.get(c) || { inc: 0, act: 0 };
      if (t === 'Income') o.inc -= amt; o.act += Math.abs(amt);
      by.set(c, o);
    }
    const ids = [...by.entries()].filter(([, o]) => o.act >= 0.005).sort((a, b) => b[1].inc - a[1].inc || b[1].act - a[1].act || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
    return { top: ids.slice(0, top), other: ids.slice(top), none };
  }
  /** A column's customer test: one id, '__none' (no customer), or a list of ids (other customers). */
  function custTest(sel, ctx) {
    if (Array.isArray(sel)) { const s = new Set(sel); return e => s.has(custOf(e, ctx)); }
    if (sel === '__none') return e => !custOf(e, ctx);
    return e => custOf(e, ctx) === sel;
  }
  const custKey = sel => (Array.isArray(sel) ? '[' + sel.join(',') + ']' : sel || '');

  /**
   * The transaction list: one row per transaction (per payment of an invoice or bill on the cash basis) with its
   * postings in [from, to] that passed the filter.
   *   account: the account shown (the bank, card, A/R or A/P side, or the filtered accounts), split: the other accounts,
   *   amount: the transaction's total, or with an account filter the net (debits less credits) on those accounts.
   * isMain(accountId) tells which accounts are the "money" side of a transaction.
   */
  function txRows(postings, { from, to, filter, isMain }) {
    const by = new Map();
    for (const p of postings) {
      if ((from && p.date < from) || (to && p.date > to)) continue;
      let g = by.get(p.e); if (!g) by.set(p.e, g = []); g.push(p);
    }
    const byAcct = !!(clean(filter) || {}).acct, out = [];
    for (const [e, ps] of by) {
      const accts = [...new Set(ps.map(p => p.account))];
      let shown, amount;
      if (byAcct) { shown = accts; amount = r2(ps.reduce((s, p) => s + p.debit - p.credit, 0)); }
      else {
        const main = ps.find(p => isMain(p.account)) || ps.slice().sort((a, b) => b.debit - a.debit)[0];
        shown = [main.account]; amount = r2(ps.reduce((s, p) => s + p.debit, 0));
      }
      const all = [...new Set((e.lines || []).map(l => l.account).concat(accts))];
      // classes: the classes on the transaction's lines in the report (several when it's split by class).
      const classes = [...new Set(ps.map(clsOf).filter(Boolean))];
      out.push({ e, date: ps[0].date, accounts: shown, split: all.filter(a => !shown.includes(a)), amount, classes });
    }
    return out;
  }
  /** Sort rows on one column. vals(row) gives that column's value (a number sorts as a number). Ties keep date order. */
  function sortRows(rows, val, dir) {
    const d = dir === 'desc' ? -1 : 1;
    const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' }));
    return rows.map((r, i) => ({ r, i, v: val(r) })).sort((a, b) => d * cmp(a.v, b.v) || (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.i - b.i)).map(x => x.r);
  }

  /** Per-account sums of postings in [from, to] for which test(e) holds: Map accountId -> debit less credit. */
  function sums(postings, { from, to, test }) {
    const m = new Map();
    for (const p of postings) {
      if ((from && p.date < from) || (to && p.date > to) || (test && !test(p.e))) continue;
      m.set(p.account, r2((m.get(p.account) || 0) + p.debit - p.credit));
    }
    return m;
  }

  return { KEYS, clean, key, without, custOf, vendOf, clsOf, matcher, apply, rankCustomers, custTest, custKey, txRows, sortRows, sums };
});
