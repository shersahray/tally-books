/*
 * Reconciliation suggestions: which transactions to tick so the difference to the statement is zero.
 *
 * It only suggests. Nothing is saved and nothing is finished: the person still sees the ticks, can change them,
 * and presses Finish themselves. A suggestion is made only when it is clear: the transactions already ticked
 * cover it, or exactly one set of the others closes the gap. If several sets fit, or none does, the ticks are
 * left alone and the reason is given, so a wrong guess can never be mistaken for a match.
 *
 * Works in the browser (window.TallyReconSuggest) and in Node (require), so the screen and the tests share the rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyReconSuggest = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cents = n => Math.round((Number(n) || 0) * 100);
  const MAX_LINES = 60;      // more uncleared lines than this: too many to search sensibly
  const MAX_STATES = 200000; // distinct running totals kept per step

  /**
   * @param {object} p
   * @param {{id:string, effect:number}[]} p.lines  uncleared transactions up to the statement date; `effect` is what each
   *        does to the balance as the statement shows it (a card charge is positive on a card statement)
   * @param {string[]} p.ticked   ids already ticked
   * @param {number} p.beginning  reconciled balance so far
   * @param {number} p.ending     statement ending balance
   * @returns {{status:'already'|'all'|'keep'|'unique'|'multiple'|'none'|'toolarge', ids?:string[], count?:number}}
   *   already: the current ticks already agree. all/keep/unique: `ids` is the full set to tick.
   */
  function suggest({ lines, ticked, beginning, ending }) {
    const L = (lines || []).map(l => ({ id: l.id, c: cents(l.effect) }));
    const have = new Set(ticked || []);
    const need = cents(ending) - cents(beginning);
    const sum = ids => L.reduce((s, l) => s + (ids.has(l.id) ? l.c : 0), 0);

    if (sum(have) === need) return { status: 'already', ids: [...have] };
    const everyone = new Set(L.map(l => l.id));
    if (L.length && sum(everyone) === need) return { status: 'all', ids: [...everyone] };

    // Keep what is ticked (e.g. lines matched from the bank feed) and look for the rest.
    const attempt = (fixed, pool) => {
      const gap = need - L.reduce((s, l) => s + (fixed.has(l.id) ? l.c : 0), 0);
      const r = subset(pool, gap);
      return r.status === 'unique' ? { status: 'unique', ids: [...fixed, ...r.ids] } : r;
    };
    const rest = L.filter(l => !have.has(l.id));
    if (have.size && rest.length) {
      const r = attempt(have, rest);
      if (r.status === 'unique') return { ...r, status: 'keep' };
      if (r.status === 'multiple' || r.status === 'toolarge') return r;
    }
    return attempt(new Set(), L);
  }

  /** Subsets of `pool` whose amounts add up to `target` (cents): 'unique' with the ids, 'multiple', 'none' or 'toolarge'. */
  function subset(pool, target) {
    if (pool.length > MAX_LINES) return { status: 'toolarge' };
    // layers[i]: running total -> number of ways (capped at 2) using only the first i lines
    const layers = [new Map([[0, 1]])];
    for (const l of pool) {
      const prev = layers[layers.length - 1], next = new Map(prev);
      for (const [s, n] of prev) next.set(s + l.c, Math.min(2, (next.get(s + l.c) || 0) + n));
      if (next.size > MAX_STATES) return { status: 'toolarge' };
      layers.push(next);
    }
    const ways = layers[pool.length].get(target) || 0;
    if (!ways) return { status: 'none' };
    if (ways > 1) return { status: 'multiple' };
    const ids = []; let t = target;
    for (let i = pool.length; i > 0; i--) {
      if (layers[i - 1].has(t)) continue; // the one way there doesn't use this line
      ids.push(pool[i - 1].id); t -= pool[i - 1].c;
    }
    return { status: 'unique', ids };
  }

  /** A sentence for the screen. */
  function message(r) {
    switch (r.status) {
      case 'already': return 'The ticks already agree with the statement.';
      case 'all': return 'Ticked everything: together it matches the statement.';
      case 'keep': return 'Kept your ticks and added the rest that makes it match. Check them against the statement.';
      case 'unique': return 'Ticked the one set of transactions that matches the statement. Check them against the statement.';
      case 'multiple': return 'More than one combination fits, so nothing was changed. Tick against the statement instead.';
      case 'toolarge': return 'Too many uncleared transactions to search. Tick against the statement, or reconcile a shorter period.';
      default: return 'No combination of these transactions matches the statement, so something is missing or different. Nothing was changed.';
    }
  }

  return { suggest, message, cents };
});
