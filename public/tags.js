/*
 * Tags: free-form labels on transactions, like QuickBooks Online's tags. A transaction can have several
 * (unlike a class, which is one per transaction and drives the profit and loss by class). Tags can sit in
 * groups ("Event": "Trade show", "Open house"). The list is a company setting; transactions keep tag ids.
 *
 * Works in the browser (window.TallyTags) and in Node (require), so the server checks tags with the same
 * rules, and the tests can check the "Money in and out by tag" totals.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyTags = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_PER_TXN = 20, MAX_TAGS = 500, MAX_GROUPS = 50, NAME_MAX = 40;
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const clip = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

  /** The company's tag groups and tags as saved: names trimmed, no duplicates (a tag's name is unique within its group). */
  function cleanList(groupsIn, tagsIn) {
    const gSeen = new Set(), groups = [];
    for (const g of (Array.isArray(groupsIn) ? groupsIn : []).filter(isObj)) {
      const id = String(g.id || '').slice(0, 40), name = clip(g.name);
      if (!id || !name || gSeen.has(name.toLowerCase()) || groups.some(x => x.id === id)) continue;
      gSeen.add(name.toLowerCase()); groups.push({ id, name });
      if (groups.length >= MAX_GROUPS) break;
    }
    const gIds = new Set(groups.map(g => g.id)), seen = new Set(), tags = [];
    for (const t of (Array.isArray(tagsIn) ? tagsIn : []).filter(isObj)) {
      const id = String(t.id || '').slice(0, 40), name = clip(t.name), group = gIds.has(t.group) ? t.group : '';
      const k = group + '\u0000' + name.toLowerCase();
      if (!id || !name || seen.has(k) || tags.some(x => x.id === id)) continue;
      seen.add(k); tags.push({ id, name, group });
      if (tags.length >= MAX_TAGS) break;
    }
    return { groups, tags };
  }

  /**
   * The tags on a transaction: a list of known tag ids, at most 20, each once.
   * Returns null when there are none. Throws a plain-English Error for anything else.
   */
  function cleanTags(v, known) {
    if (v === undefined || v === null || v === '') return null;
    if (!Array.isArray(v)) throw new Error('Tags must be a list.');
    const ids = [...new Set(v.map(x => String(x)))];
    if (ids.length > MAX_PER_TXN) throw new Error(`Use at most ${MAX_PER_TXN} tags on a transaction.`);
    const k = known instanceof Set ? known : new Set(known || []);
    if (ids.some(id => !k.has(id))) throw new Error('A tag on this transaction doesn’t exist. Add it under Settings → Tags first.');
    return ids.length ? ids : null;
  }

  /** Every ledger line as { e, account, debit, credit, date } (the browser's postings() shape). */
  function postingsOf(entries) {
    const out = [];
    for (const e of entries || []) for (const l of e.lines || []) out.push({ e, account: l.account, debit: +l.debit || 0, credit: +l.credit || 0, date: e.date });
    return out;
  }

  /**
   * Money in and out by tag for a period: income (credits less debits on income accounts) and expenses
   * (debits less credits on expense and cost of goods sold accounts) of the transactions carrying each tag.
   * A transaction with two tags counts under both, so tags don't add up to the profit and loss; "none"
   * holds the transactions with no tag. typeOf: account id → account type.
   * Returns { by: { tagId: { in, out, net, n } }, none: { in, out, net, n } }.
   */
  function summary(postings, typeOf, from, to) {
    const type = typeof typeOf === 'function' ? typeOf : id => (typeOf instanceof Map ? typeOf.get(id) : (typeOf || {})[id]);
    const by = {}, none = { in: 0, out: 0, net: 0, n: 0 }, counted = new Map();
    const add = (b, k, v, e) => { b[k] += v; let s = counted.get(b); if (!s) counted.set(b, s = new Set()); if (!s.has(e)) { s.add(e); b.n++; } };
    for (const p of postings || []) {
      if ((from && p.date < from) || (to && p.date > to)) continue;
      const t = type(p.account);
      const k = t === 'Income' ? 'in' : t === 'Expense' || t === 'Cost of Goods Sold' ? 'out' : '';
      if (!k) continue;
      const v = k === 'in' ? (p.credit || 0) - (p.debit || 0) : (p.debit || 0) - (p.credit || 0);
      const tags = Array.isArray(p.e && p.e.tags) ? p.e.tags : [];
      if (!tags.length) add(none, k, v, p.e);
      for (const id of new Set(tags)) add(by[id] = by[id] || { in: 0, out: 0, net: 0, n: 0 }, k, v, p.e);
    }
    for (const b of [...Object.values(by), none]) { b.in = r2(b.in); b.out = r2(b.out); b.net = r2(b.in - b.out); }
    return { by, none };
  }

  /** Where a tag is used: transactions, invoices and bills, bank rules and bank lines already added. */
  const has = (r, id) => Array.isArray(r && r.tags) && r.tags.includes(id);
  function usage(state, id) {
    return (state.entries || []).filter(r => has(r, id)).length + (state.docs || []).filter(r => has(r, id)).length
      + (state.rules || []).filter(r => has(r, id)).length + (state.bankTxns || []).filter(r => has(r && r.cat, id)).length;
  }

  return { MAX_PER_TXN, MAX_TAGS, MAX_GROUPS, NAME_MAX, cleanList, cleanTags, postingsOf, summary, usage };
});
