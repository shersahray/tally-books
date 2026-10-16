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
  const KINDS = { compilation: 'Compilation', internal: 'Internal financial statements' };
  // Accounting frameworks. More (IFRS…) can be added here.
  const FRAMEWORKS = { ASPE: 'Accounting Standards for Private Enterprises (ASPE)', ASNPO: 'Accounting Standards for Not-for-Profit Organizations (ASNPO)' };
  // The file's stage. 'open' is the old name for 'progress'. A final file is locked until it's reopened with a reason.
  const STATUS = ['progress', 'ready', 'reviewing', 'final'];
  const STATUS_LABEL = { progress: 'In progress', ready: 'Ready for review', reviewing: 'Review in progress', final: 'Final (locked)' };
  const statusOf = s => (s === 'open' ? 'progress' : STATUS.includes(s) ? s : 'progress');

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
  const isDividend = r => /dividend|drawing|withdrawal|prélèvement/i.test(r.name || '');
  /*
   * The kind of entity decides the statements' titles and the equity wording. Figures are the same for all of them:
   * equity is the share capital (or contributions) plus the retained earnings (or accumulated surplus).
   */
  const ENTITIES = {
    corporation: { label: 'Corporation', bs: 'Balance sheet', is: 'Statement of income and retained earnings', equity: 'Shareholders’ equity', capital: 'Share capital', re: 'Retained earnings', net: 'Net income', open: 'Retained earnings, beginning of year', close: 'Retained earnings, end of year', out: 'Dividends', expenses: 'Operating expenses', split: true },
    sole: { label: 'Sole proprietorship', bs: 'Balance sheet', is: 'Statement of income and owner’s equity', equity: 'Owner’s equity', capital: 'Contributions', re: 'Owner’s equity', net: 'Net income', open: 'Owner’s equity, beginning of year', close: 'Owner’s equity, end of year', out: 'Drawings', expenses: 'Operating expenses', split: false },
    partnership: { label: 'Partnership', bs: 'Balance sheet', is: 'Statement of income and partners’ capital', equity: 'Partners’ capital', capital: 'Contributions', re: 'Partners’ capital', net: 'Net income', open: 'Partners’ capital, beginning of year', close: 'Partners’ capital, end of year', out: 'Partner drawings', expenses: 'Operating expenses', split: false },
    npo: { label: 'Not-for-profit organization', bs: 'Statement of financial position', is: 'Statement of operations and changes in net assets', equity: 'Net assets', capital: 'Contributed net assets', re: 'Unrestricted net assets', net: 'Excess of revenue over expenses', netNeg: 'Deficiency of revenue over expenses', open: 'Net assets, beginning of year', close: 'Net assets, end of year', out: 'Transfers out', expenses: 'Expenses', split: false },
  };

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

  /* ---------- working papers, review notes and the completion checklist ---------- */
  // A working paper for each leadsheet with a balance, plus these, which every file has.
  const EXTRA_WPS = [
    { code: 'GEN', label: 'Engagement planning and client acceptance' },
    { code: 'RP', label: 'Related parties' },
    { code: 'SUB', label: 'Subsequent events and commitments' },
  ];
  const WP_STATUS = { notstarted: 'Not started', progress: 'In progress', done: 'Done' };
  const TICKS = { agreed: { mark: '✓', label: 'Agreed to supporting document' }, py: { mark: 'PY', label: 'Agreed to prior year' }, recalc: { mark: 'R', label: 'Recalculated' }, conf: { mark: 'C', label: 'Confirmed with client' }, issue: { mark: '!', label: 'Needs follow-up' } };
  const NOTE_STATUS = { open: 'Open', progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
  const PRIORITY = { high: 'High', normal: 'Normal', low: 'Low' };
  /** The working papers of a file: [{ code, label, lines, cur, prior, final, wp }] (wp: what's saved for it). */
  function workingPapers(file, accounts) {
    const saved = (file && file.wps) || {};
    const ls = leadsheets(file, accounts).map(l => ({ code: l.code, label: l.label, lines: l.lines, cur: l.cur, prior: l.prior, final: l.final, adj: l.adj }));
    return [...EXTRA_WPS.slice(0, 1).map(x => ({ ...x, lines: [] })), ...ls, ...EXTRA_WPS.slice(1).map(x => ({ ...x, lines: [] }))]
      .map(w => ({ ...w, wp: saved[w.code] || {} }));
  }
  const openNote = n => n.status === 'open' || n.status === 'progress';
  // The completion checklist. auto: worked out from the file (not ticked by hand).
  const CHECKLIST = [
    { group: 'Engagement setup', items: [['setupClient', 'Client information confirmed'], ['setupYear', 'Fiscal year-end confirmed'], ['setupFramework', 'Accounting framework confirmed'], ['setupKind', 'Engagement type confirmed']] },
    { group: 'Trial balance', items: [['tbBalances', 'Trial balance balances', 'auto'], ['tbMapping', 'Account mapping reviewed'], ['tbPrior', 'Prior-year figures agreed to last year’s statements']] },
    { group: 'Working papers', items: [['wpPrepared', 'Every working paper prepared', 'auto'], ['wpReviewed', 'Every working paper reviewed', 'auto'], ['wpDocs', 'Supporting documents attached where needed']] },
    { group: 'Adjustments', items: [['ajeReviewed', 'Every adjusting entry reviewed', 'auto'], ['ajeBalances', 'Adjusted trial balance balances', 'auto']] },
    { group: 'Financial statements', items: [['fsBalance', 'Balance sheet balances', 'auto'], ['fsReviewed', 'Statements and comparative figures reviewed'], ['fsNotes', 'Notes reviewed']] },
    { group: 'Finalization', items: [['finReport', 'Compilation report reviewed and dated', 'auto'], ['finNotes', 'No open review notes', 'auto'], ['finPrepared', 'Preparer sign-off', 'auto'], ['finReviewed', 'Reviewer sign-off', 'auto']] },
  ];
  /** Each checklist item with whether it's done: [{ group, items: [{ key, label, auto, done, by }] }]. */
  function checklist(file, accounts, attachments) {
    const f = file || {}, wps = workingPapers(f, accounts), st = statements(f, accounts), manual = f.checklist || {};
    const tb = workingTb(f, accounts), zero = col => Math.abs(tb.reduce((s, r) => s + (r[col] || 0), 0)) < 0.005;
    const auto = {
      tbBalances: zero('cur') && zero('prior'),
      wpPrepared: wps.every(w => w.wp.prepared),
      wpReviewed: wps.every(w => w.wp.reviewed),
      ajeReviewed: (f.ajes || []).every(j => j.reviewedBy),
      ajeBalances: zero('final'),
      fsBalance: Math.abs(st.bs.off.cur) < 0.01 && Math.abs(st.bs.off.prior) < 0.01,
      finReport: !!(f.report && f.report.date),
      finNotes: !(f.reviewNotes || []).some(openNote),
      finPrepared: !!(f.signoffs && f.signoffs.prepared),
      finReviewed: !!(f.signoffs && f.signoffs.reviewed),
    };
    void attachments;
    return CHECKLIST.map(g => ({ group: g.group, items: g.items.map(([key, label, a]) => ({ key, label, auto: !!a, done: a ? !!auto[key] : !!manual[key], by: a ? null : manual[key] || null })) }));
  }
  /** The file's progress at a glance (for the list and the file's overview). attachments: the company's attachment records. */
  function progress(file, accounts, attachments) {
    const f = file || {}, cl = checklist(f, accounts, attachments).flatMap(g => g.items), wps = workingPapers(f, accounts);
    const docs = new Set((attachments || []).filter(a => a.target === 'engagements' && a.targetId === f.id).map(a => a.wp));
    const st = statements(f, accounts);
    return {
      pct: Math.round(cl.filter(i => i.done).length / cl.length * 100),
      openNotes: (f.reviewNotes || []).filter(openNote).length,
      unreviewed: wps.filter(w => !w.wp.reviewed).length, wps: wps.length,
      draftAjes: (f.ajes || []).filter(j => !j.reviewedBy).length,
      // Balance sheet working papers with a balance and no document attached.
      noDocs: wps.filter(w => w.lines.length && BY_CODE[w.code] && BY_CODE[w.code].side === 'bs' && Math.abs(w.final) >= 0.005 && !docs.has(w.code)).length,
      fsOk: Math.abs(st.bs.off.cur) < 0.01 && Math.abs(st.bs.off.prior) < 0.01,
      final: statusOf(f.status) === 'final',
    };
  }

  /**
   * A GIFI file for tax software (.GFI): one "code,amount" line per GIFI code, current year, whole dollars, in GIFI's
   * signs. Totals the tax software works out itself are left out; the retained earnings start (3660) and dividends (3700)
   * are included because the software can't work them out. Returns { text, lines, roundingDiff }.
   */
  function gfi(file, accounts) {
    const g = gifi(file, accounts), keep = new Set(['3600', '3660', '3700', '3740']);
    const lines = g.lines.filter(l => (!l.total || keep.has(l.code)) && Math.abs(l.cur) >= 0.5).map(l => ({ code: l.code, amount: Math.round(l.cur) }));
    const at = c => (g.lines.find(l => l.code === c) || { cur: 0 }).cur;
    const roundingDiff = Math.round(at('2599')) - lines.filter(l => +l.code >= 1000 && +l.code <= 2589).reduce((t, l) => t + l.amount, 0);
    return { text: lines.map(l => `${l.code},${l.amount}`).join('\r\n') + '\r\n', lines, roundingDiff, missing: g.missing };
  }

  /* ---------- roll forward ---------- */
  /**
   * Does this file's prior year agree with last year's final figures? [{ account, name, prior, last }] for each account
   * that differs (an adjusting entry last year that never reached the books is the usual reason).
   */
  function priorCheck(file, prevFile, accounts) {
    if (!file || !prevFile) return [];
    const last = {}, names = {};
    for (const r of workingTb(prevFile, accounts)) { last[r.account] = r.final; names[r.account] = r.name; }
    const prior = {};
    for (const l of (file.snapshot && file.snapshot.lines) || []) { prior[l.account] = l.prior; names[l.account] = names[l.account] || l.name; }
    const out = [];
    for (const id of new Set([...Object.keys(last), ...Object.keys(prior)])) {
      const a = r2(prior[id] || 0), b = r2(last[id] || 0);
      if (Math.abs(a - b) >= 0.005) out.push({ account: id, name: names[id] || id, prior: a, last: b });
    }
    return out;
  }
  /** Snapshot lines with the prior year replaced by last year's final figures (lines added for accounts only last year had). */
  function withPriorFrom(lines, prevFile, accounts) {
    const last = {}, info = {};
    for (const r of workingTb(prevFile, accounts)) { last[r.account] = r.final; info[r.account] = r; }
    const out = lines.map(l => ({ ...l, prior: r2(last[l.account] || 0) }));
    for (const [id, v] of Object.entries(last)) {
      if (Math.abs(v) < 0.005 || out.some(l => l.account === id)) continue;
      const r = info[id];
      out.push({ account: id, code: r.code || '', name: r.name, type: r.type, detail: r.detail || '', gifi: r.gifi || '', cur: 0, prior: r2(v) });
    }
    return out;
  }

  /* ---------- fixed-asset continuity and cash flow ---------- */
  const isAccum = r => /accum|amorti[sz]|depreci|amort\./i.test(r.name || '') || (r.type === 'Asset' && r.final < 0 && r.prior <= 0 && (r.final || r.prior));
  /**
   * The capital assets continuity schedule from the capital assets leadsheet (G): for each cost account, opening,
   * additions, disposals and closing; for each accumulated amortization account, opening, amortization for the year,
   * disposals and closing; and net book value. activity: { account: { debits, credits } } for the year from the books
   * (without entries posted from this file); without it (an imported trial balance) the year's change is used.
   */
  function continuity(file, accounts, activity) {
    const tb = workingTb(file, accounts).filter(r => r.lead === 'G');
    const aje = {};
    for (const j of (file && file.ajes) || []) for (const l of j.lines || []) { const a = aje[l.account] = aje[l.account] || { debits: 0, credits: 0 }; a.debits = r2(a.debits + (Number(l.debit) || 0)); a.credits = r2(a.credits + (Number(l.credit) || 0)); }
    const row = (r, accum) => {
      const act = activity && activity[r.account], a = aje[r.account] || { debits: 0, credits: 0 };
      const sign = accum ? -1 : 1, open = r2(sign * r.prior), close = r2(sign * r.final);
      let up, down; // additions (or amortization) and disposals, in the account's own direction
      if (act || aje[r.account]) { const d = r2((act ? act.debits : 0) + a.debits), c = r2((act ? act.credits : 0) + a.credits); up = accum ? c : d; down = accum ? d : c; }
      else { const ch = r2(close - open); up = ch > 0 ? ch : 0; down = ch < 0 ? -ch : 0; }
      const other = r2(close - (open + up - down));
      return { account: r.account, name: r.name, code: r.code, open, up: r2(up), down: r2(down), other, close };
    };
    const cost = tb.filter(r => !isAccum(r)).map(r => row(r, false)), accum = tb.filter(isAccum).map(r => row(r, true));
    const sum = (rows, k) => r2(rows.reduce((t, x) => t + x[k], 0));
    const tot = rows => ({ open: sum(rows, 'open'), up: sum(rows, 'up'), down: sum(rows, 'down'), other: sum(rows, 'other'), close: sum(rows, 'close') });
    const tc = tot(cost), ta = tot(accum);
    return { cost, accum, totals: { cost: tc, accum: ta, nbv: { open: r2(tc.open - ta.open), close: r2(tc.close - ta.close) } } };
  }

  /**
   * The statement of cash flows (indirect method) from the balance sheet changes and net income. Cash is Cash (A) less
   * bank indebtedness (AA). Amortization is added back from expense accounts named for it. A difference left over
   * (there shouldn't be one) is shown so it can't hide.
   */
  function cashFlow(file, accounts) {
    const st = statements(file, accounts), tb = workingTb(file, accounts);
    const d = (code, sign) => { const rows = tb.filter(r => r.lead === code); return r2(sign * rows.reduce((t, r) => t + r.final - r.prior, 0)); };
    const amortRows = tb.filter(r => ['X', 'COS', 'OI'].includes(r.lead) && /amorti[sz]|depreci/i.test(r.name || ''));
    const amort = { cur: r2(amortRows.reduce((t, r) => t + r.final, 0)), prior: r2(amortRows.reduce((t, r) => t + r.prior, 0)) };
    // Changes this year (cur) only: the prior year's own changes would need the year before it.
    const wc = [
      ['Accounts receivable', -d('C', 1)], ['Inventory', -d('D', 1)], ['Prepaid expenses and other current assets', -d('E', 1)],
      ['Accounts payable and accrued liabilities', d('BB', -1)], ['Government remittances and sales taxes payable', d('CC', -1)], ['Income taxes payable', d('DD', -1)], ['Deferred revenue', d('EE', -1)],
    ].filter(x => Math.abs(x[1]) >= 0.005);
    const opening = r2(st.is.net.cur + amort.cur + wc.reduce((t, x) => t + x[1], 0));
    const investing = [
      ['Purchase of capital assets, net', r2(-(d('G', 1) + amort.cur))], ['Short-term investments', -d('B', 1)], ['Intangible and other assets', -d('H', 1)], ['Advances to related parties', -d('F', 1)],
    ].filter(x => Math.abs(x[1]) >= 0.005);
    const reGap = r2(st.re.opening.cur - st.re.closing.prior); // opening retained earnings not equal to last year's closing
    const financing = [
      ['Long-term debt', d('FF', -1)], ['Advances from shareholders and related parties', d('GG', -1)], ['Share capital', d('SC', -1)],
      ['Dividends paid', -st.re.dividends.cur], ['Other changes in equity', r2(st.re.other.cur - st.re.other.prior + reGap)],
    ].filter(x => Math.abs(x[1]) >= 0.005);
    const inv = r2(investing.reduce((t, x) => t + x[1], 0)), fin = r2(financing.reduce((t, x) => t + x[1], 0));
    const cashOf = col => r2(tb.filter(r => r.lead === 'A' || r.lead === 'AA').reduce((t, r) => t + r[col], 0));
    const begin = cashOf('prior'), end = cashOf('final'), change = r2(opening + inv + fin);
    return { net: st.is.net.cur, amort: amort.cur, wc, operating: opening, investing, inv, financing, fin, change, begin, end, gap: r2(end - begin - change) };
  }

  /* ---------- analysis (suggestions for the accountant, never conclusions) ---------- */
  const NORMAL_DEBIT = { Asset: true, Expense: true, 'Cost of Goods Sold': true, Liability: false, Equity: false, Income: false };
  const SIDE = { Asset: 'bs', Liability: 'bs', Equity: 'bs', Income: 'is', Expense: 'is', 'Cost of Goods Sold': 'is' };
  /**
   * Things worth a look: large changes from last year, balances on the wrong side, accounts on a leadsheet that doesn't
   * match their type, balance sheet working papers with no document, capital asset additions with no document, and
   * unfinished parts of the file. Each is { kind, wp, level ('high'|'normal'), text }.
   * opts: { minChange (dollars, default 1,000), minPct (default 20), activity (see continuity) }.
   */
  function analyze(file, accounts, attachments, opts = {}) {
    const minChange = opts.minChange ?? 1000, minPct = opts.minPct ?? 20, out = [];
    const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ls = leadsheets(file, accounts), tb = workingTb(file, accounts);
    const signOf = l => (l.side === 'bs' ? (l.type === 'Asset' ? 1 : -1) : (l.type === 'Income' ? -1 : 1));
    for (const l of ls) {
      const sg = signOf(l), cur = r2(sg * l.final), pr = r2(sg * l.prior), ch = r2(cur - pr);
      if (Math.abs(ch) < minChange || !pr || l.code === 'RE') continue;
      const pct = Math.round(ch / Math.abs(pr) * 1000) / 10;
      if (Math.abs(pct) < minPct) continue;
      const hint = { C: ' Consider reviewing the A/R aging and collectibility.', D: ' Consider the inventory count and costing.', G: ' Check additions and disposals against invoices.', BB: ' Check for unrecorded or duplicate liabilities.', R: ' Compare with sales tax returns and cut-off.', X: ' Look at the expense accounts that moved most.', FF: ' Agree to the loan statement.', GG: ' Agree with the shareholder.' }[l.code] || '';
      out.push({ kind: 'variance', wp: l.code, level: Math.abs(pct) >= 50 ? 'high' : 'normal', text: `${l.label} ${ch > 0 ? 'increased' : 'decreased'} ${Math.abs(pct)}% from the prior year (${money(pr)} to ${money(cur)}).${hint}` });
    }
    for (const r of tb) {
      if (r.account === RE_OPEN || Math.abs(r.final) < 0.005) continue;
      const nd = NORMAL_DEBIT[r.type];
      if (nd !== undefined && (nd ? r.final < 0 : r.final > 0) && !/accum|amorti|depreci|allowance|drawing|dividend|contra|discount|return/i.test(r.name)) out.push({ kind: 'sign', wp: r.lead, level: 'normal', text: `${r.name} has a ${r.final < 0 ? 'credit' : 'debit'} balance of ${money(Math.abs(r.final))}, which is unusual for ${r.type.toLowerCase()} accounts. Check whether it should be reclassified.` });
      const lsSide = BY_CODE[r.lead] && BY_CODE[r.lead].side;
      if (lsSide && SIDE[r.type] && lsSide !== SIDE[r.type]) out.push({ kind: 'mapping', wp: r.lead, level: 'high', text: `${r.name} is a ${r.type.toLowerCase()} account but sits on ${BY_CODE[r.lead].label}, on the ${lsSide === 'bs' ? 'balance sheet' : 'income statement'}. Check its leadsheet.` });
    }
    const docs = new Set((attachments || []).filter(a => a.target === 'engagements' && a.targetId === (file && file.id)).map(a => a.wp));
    for (const l of ls) if (l.side === 'bs' && Math.abs(l.final) >= 0.005 && !docs.has(l.code) && !['RE', 'SC'].includes(l.code)) out.push({ kind: 'docs', wp: l.code, level: 'normal', text: `${l.label} of ${money(Math.abs(l.final))} has no supporting document attached.` });
    const cont = continuity(file, accounts, opts.activity);
    if (cont.totals.cost.up >= minChange && !docs.has('G')) out.push({ kind: 'docs', wp: 'G', level: 'high', text: `Capital asset additions of ${money(cont.totals.cost.up)} have no supporting document attached.` });
    for (const j of (file && file.ajes) || []) if (!j.explanation) out.push({ kind: 'aje', wp: j.wp || '', level: 'normal', text: `AJE ${j.num} (${j.memo || 'no description'}) has no explanation of where the figure comes from.` });
    for (const g of checklist(file, accounts, attachments)) { const left = g.items.filter(i => !i.done); if (left.length) out.push({ kind: 'checklist', wp: '', level: 'normal', text: `${g.group}: ${left.length} item${left.length === 1 ? '' : 's'} not done (${left.map(i => i.label.toLowerCase()).join('; ')}).` }); }
    return out;
  }
  /**
   * Transactions in the year that look unusual, from the books' postings ({ entryId, date, account, name, amount, memo }):
   * possible duplicates (same account, amount and date, or same amount and memo within 7 days) and single postings much
   * bigger than the account's usual ones.
   */
  function unusual(postingsList, from, to) {
    const out = [], list = postingsList.filter(p => p.date >= from && p.date <= to && Math.abs(p.amount) >= 0.005);
    const seen = new Map();
    for (const p of list) {
      const k = `${p.account}|${Math.round(p.amount * 100)}`;
      for (const q of (seen.get(k) || []).slice(-20)) {
        const days = Math.abs((new Date(p.date) - new Date(q.date)) / 864e5);
        if (q.entryId !== p.entryId && (days === 0 || (days <= 7 && p.memo && p.memo === q.memo))) { out.push({ kind: 'duplicate', entryId: p.entryId, other: q.entryId, text: `Possible duplicate: ${p.name} ${p.amount.toFixed(2)} on ${p.date} and ${q.date}${p.memo ? ` (${p.memo})` : ''}.` }); break; }
      }
      let arr = seen.get(k); if (!arr) seen.set(k, arr = []); arr.push(p);
    }
    const byAcct = new Map();
    for (const p of list) { let a = byAcct.get(p.account); if (!a) byAcct.set(p.account, a = []); a.push(Math.abs(p.amount)); }
    // Each account's usual (median) posting, worked out once.
    const median = new Map();
    for (const [id, a] of byAcct) if (a.length >= 6) { a.sort((x, y) => x - y); median.set(id, a[Math.floor(a.length / 2)]); }
    for (const p of list) {
      const med = median.get(p.account);
      if (med === undefined) continue;
      if (Math.abs(p.amount) >= 5 * med && Math.abs(p.amount) >= 1000) out.push({ kind: 'large', entryId: p.entryId, text: `${p.name}: ${Math.abs(p.amount).toFixed(2)} on ${p.date} is much larger than this account’s usual postings (about ${med.toFixed(2)}).${p.memo ? ` ${p.memo}` : ''}` });
    }
    return out.slice(0, 50);
  }

  return { gfi, ENTITIES, analyze, unusual, continuity, cashFlow, priorCheck, withPriorFrom, KINDS, FRAMEWORKS, STATUS, STATUS_LABEL, statusOf, EXTRA_WPS, WP_STATUS, TICKS, NOTE_STATUS, PRIORITY, CHECKLIST, workingPapers, checklist, progress, openNote, LEADSHEETS, BY_CODE, RE_OPEN, suggest, leadOf, ajeTotals, ajeProblem, workingTb, leadsheets, netIncome, changedSince, BS_GROUPS, statements, gifi };
});
