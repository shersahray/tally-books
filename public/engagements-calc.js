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

  /* ---------- financial statements ---------- */
  // Where each leadsheet goes on the balance sheet. Assets are shown as debits, liabilities and equity as credits.
  const BS_GROUPS = [
    { key: 'ca', label: 'Current assets', codes: ['A', 'B', 'C', 'D', 'E'], sign: 1 },
    { key: 'la', label: 'Long-term assets', codes: ['F', 'G', 'H'], sign: 1 },
    { key: 'cl', label: 'Current liabilities', codes: ['AA', 'BB', 'CC', 'DD', 'EE'], sign: -1 },
    { key: 'll', label: 'Long-term liabilities', codes: ['FF', 'GG'], sign: -1 },
  ];
  const isDividend = r => /dividend/i.test(r.name || '');

  /**
   * The financial statements from a year-end file, in presentation signs (assets, liabilities, equity, revenue and
   * expenses all positive in their normal direction). Each amount is { cur, prior }: cur is the adjusted figure.
   *   bs: groups of leadsheet lines with totals, share capital, retained earnings, and the totals that must agree
   *   is: revenue, cost of sales, gross profit, each operating expense account, other items, income taxes, net income
   *   re: retained earnings at the start, net income, dividends, other changes, at the end
   */
  function statements(file, accounts) {
    const tb = workingTb(file, accounts);
    const pick = (rows, sign) => ({ cur: r2(sign * rows.reduce((s, r) => s + r.final, 0)), prior: r2(sign * rows.reduce((s, r) => s + r.prior, 0)) });
    const add = (...xs) => ({ cur: r2(xs.reduce((s, x) => s + x.cur, 0)), prior: r2(xs.reduce((s, x) => s + x.prior, 0)) });
    const neg = x => ({ cur: -x.cur, prior: -x.prior });
    const of = code => tb.filter(r => r.lead === code);
    const nz = x => Math.abs(x.cur) >= 0.005 || Math.abs(x.prior) >= 0.005;
    // Income statement
    const revenue = pick(of('R'), -1), cos = pick(of('COS'), 1), gross = add(revenue, neg(cos));
    const opex = of('X').map(r => ({ label: r.name, account: r.account, ...pick([r], 1) })).filter(nz).sort((a, b) => a.label.localeCompare(b.label));
    const opexTotal = add(...opex.map(x => x), { cur: 0, prior: 0 });
    const other = pick(of('OI'), -1); // other income, less other expenses
    const beforeTax = add(gross, neg(opexTotal), other), taxes = pick(of('IT'), 1), net = add(beforeTax, neg(taxes));
    // Retained earnings: the opening balance, net income, dividends, and any other retained earnings lines.
    const reRows = of('RE');
    const opening = pick(reRows.filter(r => r.account === RE_OPEN), -1);
    const dividends = pick(reRows.filter(r => r.account !== RE_OPEN && isDividend(r)), 1);
    const otherRe = pick(reRows.filter(r => r.account !== RE_OPEN && !isDividend(r)), -1);
    const closing = add(opening, net, neg(dividends), otherRe);
    // Balance sheet
    const groups = BS_GROUPS.map(g => {
      const lines = g.codes.map(c => ({ code: c, label: BY_CODE[c].label, ...pick(of(c), g.sign) })).filter(nz);
      return { key: g.key, label: g.label, lines, total: add(...lines, { cur: 0, prior: 0 }) };
    });
    const G = Object.fromEntries(groups.map(g => [g.key, g]));
    const shareCapital = pick(of('SC'), -1);
    const assets = add(G.ca.total, G.la.total), liabilities = add(G.cl.total, G.ll.total), equity = add(shareCapital, closing);
    const totalLE = add(liabilities, equity);
    const off = { cur: r2(assets.cur - totalLE.cur), prior: r2(assets.prior - totalLE.prior) };
    return {
      is: { revenue, cos, gross, opex, opexTotal, other, beforeTax, taxes, net },
      re: { opening, net, dividends, other: otherRe, closing },
      bs: { groups, assets, liabilities, shareCapital, retained: closing, equity, totalLE, off },
    };
  }

  /* ---------- GIFI (T2 Schedules 100 and 125) ---------- */
  const GR = (g, a, b) => g >= a && g <= b;
  /**
   * The GIFI figures for the T2 from the adjusted trial balance: [{ schedule, code, cur, prior }], with the totals CRA
   * expects, plus { missing }: accounts with a balance but no GIFI code (they're left out until they get one).
   * Schedule 100 amounts are positive for assets and for liabilities and equity (contra accounts negative); Schedule 125
   * amounts are positive for revenue and for expenses. Retained earnings come from the statements, not from accounts.
   */
  function gifi(file, accounts) {
    const tb = workingTb(file, accounts), by = {}, missing = [];
    const put = (sch, code, cur, prior) => { const k = sch + code; by[k] = by[k] || { schedule: sch, code, cur: 0, prior: 0 }; by[k].cur = r2(by[k].cur + cur); by[k].prior = r2(by[k].prior + prior); };
    for (const r of tb) {
      if (r.lead === 'RE') continue; // retained earnings come from the statement of retained earnings
      if (Math.abs(r.final) < 0.005 && Math.abs(r.prior) < 0.005) continue;
      // An account's GIFI code as it is now in the chart of accounts (it may have been filled in after the snapshot).
      const acc = (accounts || []).find(a => a.id === r.account), g = parseInt((acc && acc.gifi) || r.gifi, 10);
      if (!g) { missing.push({ account: r.account, name: r.name, type: r.type }); continue; }
      if (r.type === 'Asset') put('100', String(g), r.final, r.prior);
      else if (r.type === 'Liability' || r.type === 'Equity') put('100', String(g), -r.final, -r.prior);
      else if (r.type === 'Income') put('125', String(g), -r.final, -r.prior);
      else put('125', String(g), r.final, r.prior);
    }
    const st = statements(file, accounts);
    const lines = Object.values(by);
    const sum = (sch, test) => lines.filter(l => l.schedule === sch && test(+l.code)).reduce((s, l) => ({ cur: r2(s.cur + l.cur), prior: r2(s.prior + l.prior) }), { cur: 0, prior: 0 });
    const tot = (sch, code, x) => { if (Math.abs(x.cur) >= 0.005 || Math.abs(x.prior) >= 0.005 || ['2599', '3640', '9999', '3849'].includes(code)) lines.push({ schedule: sch, code, cur: x.cur, prior: x.prior, total: true }); };
    const ca = sum('100', g => GR(g, 1000, 1598)), assets = sum('100', g => GR(g, 1000, 2589));
    const cl = sum('100', g => GR(g, 2600, 3138)), ll = sum('100', g => GR(g, 3140, 3449)), liab = sum('100', g => GR(g, 2600, 3498));
    const shares = sum('100', g => GR(g, 3500, 3599) || GR(g, 3610, 3619));
    const re = st.re, eq = { cur: r2(shares.cur + re.closing.cur), prior: r2(shares.prior + re.closing.prior) };
    tot('100', '1599', ca); tot('100', '2599', assets); tot('100', '3139', cl); tot('100', '3450', ll); tot('100', '3499', liab);
    lines.push({ schedule: '100', code: '3600', cur: re.closing.cur, prior: re.closing.prior });
    tot('100', '3620', eq); tot('100', '3640', { cur: r2(liab.cur + eq.cur), prior: r2(liab.prior + eq.prior) });
    tot('100', '3660', re.opening); tot('100', '3680', re.net); tot('100', '3700', re.dividends);
    if (Math.abs(re.other.cur) >= 0.005 || Math.abs(re.other.prior) >= 0.005) lines.push({ schedule: '100', code: '3740', cur: re.other.cur, prior: re.other.prior });
    tot('100', '3849', re.closing);
    const rev = sum('125', g => GR(g, 8000, 8298)), cos = sum('125', g => GR(g, 8300, 8517));
    const opex = sum('125', g => GR(g, 8520, 9366)), taxes = sum('125', g => GR(g, 9990, 9995));
    const exp = { cur: r2(cos.cur + opex.cur), prior: r2(cos.prior + opex.prior) };
    const before = { cur: r2(rev.cur - exp.cur), prior: r2(rev.prior - exp.prior) };
    tot('125', '8299', rev); tot('125', '8518', cos); tot('125', '8519', { cur: r2(rev.cur - cos.cur), prior: r2(rev.prior - cos.prior) });
    tot('125', '9367', opex); tot('125', '9368', exp); tot('125', '9970', before);
    tot('125', '9999', { cur: r2(before.cur - taxes.cur), prior: r2(before.prior - taxes.prior) });
    lines.sort((a, b) => a.schedule.localeCompare(b.schedule) || +a.code - +b.code);
    // Net income on Schedule 125 should agree with the statements once every account has a GIFI code.
    const ni = lines.find(l => l.schedule === '125' && l.code === '9999');
    const agrees = !missing.length && Math.abs(ni.cur - st.is.net.cur) < 0.01 && Math.abs((lines.find(l => l.code === '2599') || {}).cur - (lines.find(l => l.code === '3640') || {}).cur) < 0.01;
    return { lines, missing, agrees };
  }

  return { KINDS, STATUS, LEADSHEETS, BY_CODE, RE_OPEN, suggest, leadOf, ajeTotals, ajeProblem, workingTb, leadsheets, netIncome, changedSince, BS_GROUPS, statements, gifi };
});
