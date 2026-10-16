/*
 * Year-end files: the accountant's working file for one company's year-end (a compilation engagement to start with).
 *
 * A year-end file holds:
 *   - a snapshot of the trial balance at the year-end (and the prior year's, for comparatives), taken from the books
 *     and kept as it was, so later changes to the books don't move the numbers under the accountant;
 *   - a leadsheet for each account (Cash, Accounts receivable, Revenue…), suggested from the account and changeable;
 *   - the accountant's adjusting entries (AJEs), which change the leadsheets at once and can be posted back to the books.
 *
 * Only the firm's staff see year-end files; clients never do. The feature is "coming soon" for now (plans.js).
 * Works in the browser (window.TallyEngage) and in Node (require), so the server checks the same rules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyEngage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Engagement types. Compilation (CSRS 4200, the Notice to Reader's replacement) first; others can follow.
  const KINDS = { compilation: 'Compilation' };
  const STATUS = ['open', 'final'];

  // Sumlora's own leadsheets, in the order they appear on the financial statements. side: which statement.
  const LEADSHEETS = [
    { code: 'A', label: 'Cash', side: 'bs', type: 'Asset' },
    { code: 'B', label: 'Short-term investments', side: 'bs', type: 'Asset' },
    { code: 'C', label: 'Accounts receivable', side: 'bs', type: 'Asset' },
    { code: 'D', label: 'Inventory', side: 'bs', type: 'Asset' },
    { code: 'E', label: 'Prepaid expenses and other current assets', side: 'bs', type: 'Asset' },
    { code: 'F', label: 'Due from related parties', side: 'bs', type: 'Asset' },
    { code: 'G', label: 'Capital assets', side: 'bs', type: 'Asset' },
    { code: 'H', label: 'Intangible and other assets', side: 'bs', type: 'Asset' },
    { code: 'AA', label: 'Bank indebtedness', side: 'bs', type: 'Liability' },
    { code: 'BB', label: 'Accounts payable and accrued liabilities', side: 'bs', type: 'Liability' },
    { code: 'CC', label: 'Government remittances and sales taxes payable', side: 'bs', type: 'Liability' },
    { code: 'DD', label: 'Income taxes payable', side: 'bs', type: 'Liability' },
    { code: 'EE', label: 'Deferred revenue', side: 'bs', type: 'Liability' },
    { code: 'FF', label: 'Long-term debt', side: 'bs', type: 'Liability' },
    { code: 'GG', label: 'Due to shareholders and related parties', side: 'bs', type: 'Liability' },
    { code: 'SC', label: 'Share capital', side: 'bs', type: 'Equity' },
    { code: 'RE', label: 'Retained earnings', side: 'bs', type: 'Equity' },
    { code: 'R', label: 'Revenue', side: 'is', type: 'Income' },
    { code: 'COS', label: 'Cost of sales', side: 'is', type: 'Cost of Goods Sold' },
    { code: 'X', label: 'Operating expenses', side: 'is', type: 'Expense' },
    { code: 'OI', label: 'Other income and expenses', side: 'is', type: 'Income' },
    { code: 'IT', label: 'Income taxes', side: 'is', type: 'Expense' },
  ];
  const BY_CODE = Object.fromEntries(LEADSHEETS.map(l => [l.code, l]));
  /** The opening retained earnings line (earnings of earlier years) on every snapshot. */
  const RE_OPEN = 'RE-OPEN';

  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const has = (s, re) => re.test(String(s || '').toLowerCase());

  /** The leadsheet an account most likely belongs on, from its type, detail, GIFI code and name. */
  function suggest(a) {
    a = a || {};
    const g = parseInt(a.gifi, 10), n = a.name, d = a.detail || '';
    if (a.id === RE_OPEN) return 'RE';
    switch (a.type) {
      case 'Asset':
        if (d === 'bank' || (g >= 1000 && g <= 1007) || has(n, /\b(cash|chequing|checking|savings|petty)\b/)) return 'A';
        if (d === 'ar' || (g >= 1060 && g <= 1074) || has(n, /receivable/)) return has(n, /shareholder|related|director|officer/) ? 'F' : 'C';
        if ((g >= 1120 && g <= 1127) || has(n, /inventor/)) return 'D';
        if ((g >= 1180 && g <= 1182) || has(n, /\b(term deposit|gic|investment)/)) return g >= 2180 ? 'H' : 'B';
        if ((g >= 2180 && g <= 2220) || has(n, /shareholder|related part|director|officer|due from/)) return 'F';
        if (d === 'capital' || (g >= 1600 && g <= 2009) || has(n, /equipment|vehicle|building|furniture|computer|leasehold|land|depreciation|amorti[sz]ation/)) return has(n, /goodwill|intangible|patent|trademark|licen[cs]e/) ? 'H' : 'G';
        if ((g >= 2010 && g <= 2178) || has(n, /goodwill|intangible|patent|trademark/)) return 'H';
        if (g >= 2180) return 'H';
        return 'E';
      case 'Liability':
        if (g === 2600 || has(n, /overdraft|bank indebtedness|line of credit/)) return 'AA';
        if (['tax', 'qst', 'pst', 'payroll_cra', 'payroll_rq', 'payroll_other'].includes(d) || (g >= 2680 && g <= 2685 && !has(n, /income tax/)) || has(n, /gst|hst|qst|pst|source deduction|remittance|wsib|eht/)) return 'CC';
        if (g === 2690 || has(n, /income tax/)) return 'DD';
        if ((g >= 2780 && g <= 2783) || (g >= 3260 && g <= 3262) || has(n, /shareholder|director|related part|due to/)) return 'GG';
        if (g === 2860 || has(n, /deferred revenue|unearned|customer deposit/)) return 'EE';
        if ((g >= 2700 && g <= 2707) || (g >= 3140 && g <= 3220) || has(n, /loan|mortgage|long-term|note payable|lease obligation/)) return 'FF';
        return 'BB';
      case 'Equity':
        if ((g >= 3500 && g <= 3541) || has(n, /share capital|common shares|preferred shares|capital stock/)) return 'SC';
        return 'RE';
      case 'Income':
        if ((g >= 8090 && g <= 8299 && g !== 8089) || has(n, /interest income|gain on|foreign exchange|other income|dividend income/)) return 'OI';
        return 'R';
      case 'Cost of Goods Sold':
        return 'COS';
      case 'Expense':
        if ((g >= 9990 && g <= 9995) || has(n, /income tax expense|current income taxes|provision for income tax/)) return 'IT';
        if (has(n, /loss on|gain on disposal/)) return 'OI';
        return 'X';
      default:
        return 'X';
    }
  }

  /** The leadsheet used for a line of the file: the accountant's choice, or the suggestion. */
  const leadOf = (file, line) => {
    const m = file && file.map && file.map[line.account];
    return BY_CODE[m] ? m : suggest({ ...line, id: line.account });
  };

  /** Net effect of the adjusting entries on each account (debits positive). */
  function ajeTotals(file) {
    const t = {};
    for (const j of (file && file.ajes) || []) for (const l of j.lines || []) t[l.account] = r2((t[l.account] || 0) + (Number(l.debit) || 0) - (Number(l.credit) || 0));
    return t;
  }

  /** Is an adjusting entry balanced, with at least one amount? Returns an error message, or ''. */
  function ajeProblem(j) {
    if (!j || !Array.isArray(j.lines) || j.lines.filter(l => (Number(l.debit) || 0) || (Number(l.credit) || 0)).length < 2) return 'An adjusting entry needs at least two lines with amounts.';
    let d = 0, c = 0;
    for (const l of j.lines) { d += Math.round((Number(l.debit) || 0) * 100); c += Math.round((Number(l.credit) || 0) * 100); }
    if (d !== c) return `Debits and credits don’t balance (off by ${((d - c) / 100).toFixed(2)}).`;
    return '';
  }

  /**
   * The working trial balance: each line with its unadjusted balance (from the snapshot), adjustments, adjusted
   * balance, prior year and leadsheet. Accounts used only in adjusting entries (made after the snapshot) are added.
   * accounts: the company's chart of accounts, for names of accounts that aren't in the snapshot.
   */
  function workingTb(file, accounts) {
    const adj = ajeTotals(file), rows = [], seen = new Set();
    for (const l of (file && file.snapshot && file.snapshot.lines) || []) {
      seen.add(l.account);
      const a = adj[l.account] || 0;
      rows.push({ ...l, adj: a, final: r2(l.cur + a), lead: leadOf(file, l) });
    }
    for (const [id, a] of Object.entries(adj)) {
      if (seen.has(id)) continue;
      const acc = (accounts || []).find(x => x.id === id) || { name: 'Account no longer in the books', type: 'Expense' };
      const l = { account: id, code: acc.code || '', name: acc.name, type: acc.type, detail: acc.detail || '', gifi: acc.gifi || '', cur: 0, prior: 0 };
      rows.push({ ...l, adj: a, final: r2(a), lead: leadOf(file, l) });
    }
    return rows;
  }

  /** Leadsheets with their lines and totals (unadjusted, adjustments, adjusted, prior), in statement order. */
  function leadsheets(file, accounts) {
    const tb = workingTb(file, accounts);
    return LEADSHEETS.map(ls => {
      const lines = tb.filter(r => r.lead === ls.code);
      const sum = k => r2(lines.reduce((s, r) => s + (r[k] || 0), 0));
      return { ...ls, lines, cur: sum('cur'), adj: sum('adj'), final: sum('final'), prior: sum('prior') };
    }).filter(ls => ls.lines.some(r => Math.abs(r.cur) >= 0.005 || Math.abs(r.adj) >= 0.005 || Math.abs(r.prior) >= 0.005));
  }

  /** Net income (positive = profit) from a working trial balance column ('cur', 'final' or 'prior'). */
  function netIncome(tb, col) {
    return r2(-tb.filter(r => ['Income', 'Cost of Goods Sold', 'Expense'].includes(r.type)).reduce((s, r) => s + (r[col] || 0), 0));
  }

  /** Differences between the snapshot and the books now: [{ account, name, was, now }]. current: { account: balance }. */
  function changedSince(file, current) {
    const out = [], snap = {};
    for (const l of (file && file.snapshot && file.snapshot.lines) || []) snap[l.account] = l;
    const ids = new Set([...Object.keys(snap), ...Object.keys(current || {})]);
    for (const id of ids) {
      const was = snap[id] ? snap[id].cur : 0, now = r2((current || {})[id] || 0);
      if (Math.abs(was - now) >= 0.005) out.push({ account: id, name: snap[id] ? snap[id].name : '', was, now });
    }
    return out;
  }

  return { KINDS, STATUS, LEADSHEETS, BY_CODE, RE_OPEN, suggest, leadOf, ajeTotals, ajeProblem, workingTb, leadsheets, netIncome, changedSince };
});
